// レコーダーウィンドウ専用 IPC（recorder:* の合図の受け口。準備・開始・停止・失敗・保存）。
// recorder:* は ShioriApi の CH 定数の対象外（別契約・別検証方式。preload/recorder.ts 参照）。
import { ipcMain } from 'electron'
import { unlink } from 'fs/promises'
import { computeVideoCrop, writeCaptureFile } from '../capture/capture'
import { ensureCaptureSubDir, thumbPathFor } from '../system/paths'
import { loadSettings } from '../system/settings'
import { beginTask, endTask } from '../system/busy'
import { sendBrowserNotice, sendFailureNotice } from '../browser/browser-notice'
import { isTrustedRecorderSender } from './recorder-window'
import { extractThumb } from './ffmpeg'
import { verifyClipFrames } from './verify-clip'
import {
  finishRecordingState, getRecordingDisplayPixels, getRecordingMeta, isCurrentRecordingSession, markArmingUnconfirmed,
  notifyRecorderPrepared, recordMeasuredSupply, releaseCaptureUi, takeSettleNote, takeStartDoubts
} from './recording'
import {
  logMatchResult, buildFrameTable, getSourceFps, getReportDelay, logReportInterruptions,
  countReportDrops, reportDropsMeasured, getSourceFrames
} from './frame-feed'
import { logBitrateDiag, logClockDiag, logSupplyDiag, parseCaptureDiag, recordedSize, summarizeSupply } from './capture-diag'
import { registerCapturedMedia } from '../capture/captured-media'
import { setFrameCounts } from '../db/db'
import { saveVideoFrames } from '../db/db-video-frames'
import { t } from '../system/i18n'

// renderer 破損時のメモリ DoS / 不正データ対策
const MAX_WEBM_BYTES = 1024 * 1024 * 1024 // 1GB
// 著作権対策の録画上限（settings.ts の clipMaxSeconds、最大30秒）に停止タイマーの
// 遅延分だけ余裕を持たせた値。renderer が改ざん・誤動作しても、この値を超える尺の
// クリップを保存させない（多層防御。settings.ts 側が一次の上限）。
const MAX_CLIP_DURATION_SEC = 40
// フレーム数の妥当性上限。取得は acquireScreenStream 側で MAX_CAPTURE_FPS（120）に
// 上限しているが、renderer の改ざん・誤動作に対する多層防御として余裕を持たせた値で判定する。
// **取得上限そのものと同値にしないこと** — 上限ちょうどの供給が続いた録画を弾いてしまう。
const MAX_FRAME_RATE_FOR_VALIDATION = 240

// このクリップの先頭が、作品の何秒目か。
//
// **ホットキーを押した時刻ではなく、実際に記録された先頭のコマから決める。** 押してから
// 記録が始まるまでには、画面キャプチャの立ち上げ・コマ通知が落ち着くのを待つ時間
// （最大 2 秒）・「準備中」の消去をキャプチャ側で確認する待ちが入る（recording.ts）。押した
// 時刻をそのまま保存すると、その全部ぶん古い値が残る——**表示にもファイル名にも出るのに、
// 何秒ずれているかは画面からは分からない。**
//
// 表の 1 行目の mediaTime は「記録できた最初の素材コマの再生位置」そのものなので、
// 補正ではなく実測でそのまま置き換わる。
//
// 表が無いクリップ（対応が崩れて捨てたもの）では null を返し、押した時の値へ戻す。
// **推測で埋めない**——表が無いのは拡張からコマが届いていないということで、その状態では
// 測り直す手段も無い（fps を供給レートで埋めないのと同じ）。
function recordedStartTime(frameTable: { matches: { mediaTime: number }[] } | null): number | null {
  const first = frameTable?.matches[0]?.mediaTime
  return typeof first === 'number' && Number.isFinite(first) && first >= 0 ? first : null
}

function formatClipDuration(seconds: number): string {
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
}

export function registerRecorderIpc(): void {
  ipcMain.handle('recorder:getCrop', (event, streamW: number, streamH: number) => {
    if (!isTrustedRecorderSender(event)) return null
    return computeVideoCrop(streamW, streamH)
  })

  // 画面キャプチャの立ち上げが済んだ合図。**記録はまだ始まっていない。**
  // main はこれを受けてから、コマ通知が落ち着くのを待つ（recording.ts の startRecording）。
  ipcMain.on('recorder:ready', (event, sessionId: number) => {
    if (!isTrustedRecorderSender(event)) return
    notifyRecorderPrepared(sessionId)
  })

  ipcMain.on('recorder:startBoundary', (event, sessionId: number, confirmed: boolean) => {
    if (!isTrustedRecorderSender(event) || !isCurrentRecordingSession(sessionId)) return
    // 始める瞬間には出さず、完了通知に添える（recording.ts の StartDoubts）。
    if (confirmed !== true) markArmingUnconfirmed()
  })

  // 録画が実際に止まった合図。**保存の完了ではない**ので録画状態は触らず、隠している
  // プレーヤー UI の復帰だけを先に流す（理由は recording.ts の releaseCaptureUi）。
  // この後に重い後処理（尺補正・数十MB の転送）が続き、recorder:done がその後に届く。
  ipcMain.on('recorder:stopped', (event, sessionId: number) => {
    if (!isTrustedRecorderSender(event)) return
    // recorder:done / recorder:error と同じ理由（レコーダーウィンドウ側のレース）で、
    // 現在のセッションと一致しない通知は無視する。旧セッションの遅れた合図で、
    // 始まったばかりの新しい録画の UI を戻してしまわないため。
    if (!isCurrentRecordingSession(sessionId)) return
    releaseCaptureUi()
  })

  ipcMain.on('recorder:error', (event, msg: string, sessionId: number) => {
    if (!isTrustedRecorderSender(event)) return
    // レコーダーウィンドウ側のレース（新しい録画が始まった後に旧セッションの通知が
    // 遅延して届く）で、新しい録画状態を巻き込んで壊さないよう、現在のセッションと
    // 一致しない通知は黙って無視する。
    if (!isCurrentRecordingSession(sessionId)) return
    // V-1: token不一致・recorder未生成での中断は「録画開始処理中に停止された」だけで
    // ユーザーへの通知は不要（そもそも録画は始まっていない）。状態リセットだけ行う。
    if (msg === 'aborted') {
      finishRecordingState()
      return
    }
    // V-5: audio+video が失敗し video のみで録画を継続しているだけなので、録画状態は
    // リセットしない（このあと recorder:done / recorder:error が別途届く）。
    if (msg === 'audio_unavailable_fallback') {
      sendBrowserNotice('warning', t('notice.recordingNoAudio'))
      return
    }
    finishRecordingState()
    if (msg === 'crop_unavailable') {
      sendFailureNotice('warning', t('notice.videoRegionNotFound'))
    } else if (msg === 'no_data') {
      sendFailureNotice('warning', t('notice.recordingEmpty'))
    } else if (msg === 'getUserMedia_not_allowed') {
      sendFailureNotice('error', t('notice.screenCapturePermission'))
    } else {
      sendFailureNotice('error', t('notice.recordingError', { message: msg.slice(0, 80) }))
    }
  })

  ipcMain.on('recorder:done', async (event, webmAB: ArrayBuffer, duration: number, sessionId: number, drawnAt: number[], diag: unknown) => {
    if (!isTrustedRecorderSender(event)) return
    // recorder:error と同じ理由（レコーダーウィンドウ側のレース）で、現在のセッションと
    // 一致しない完了通知は無視する。新しい録画を誤って確定・保存させない。
    if (!isCurrentRecordingSession(sessionId)) return

    // renderer 側が壊れた場合に備えた入力検証（メモリ DoS / 不正データ対策）
    if (!(webmAB instanceof ArrayBuffer) || webmAB.byteLength === 0 || webmAB.byteLength > MAX_WEBM_BYTES) {
      console.error('[clip] recorder:done rejected: invalid webm payload', { byteLength: (webmAB as ArrayBuffer)?.byteLength })
      finishRecordingState()
      sendFailureNotice('error', t('notice.recordingDataInvalid'))
      return
    }
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_CLIP_DURATION_SEC) {
      console.error('[clip] recorder:done rejected: invalid duration', { duration })
      finishRecordingState()
      sendFailureNotice('error', t('notice.recordingDataInvalid'))
      return
    }

    // fps 列が意味するのは**素材のフレームレート**（研究用途で意味を持つのはこちらだけ）。
    //
    // drawnAt.length/duration は「画面キャプチャが何枚寄越したか」でしかなく、素材とは無関係な
    // 値になる（23.976fps の素材に対し 50 枚/秒前後）。以前はこれを退避先にしていたが、
    // 詳細パネルに「50fps の素材」と読める数字が出てしまい、コマ打ちを数える用途では
    // 誤解が実害になる。素材の fps が取れないとき（拡張未接続・非対応サイト）は空欄のまま
    // にする — getVideoMeta が tbr にフォールバックしないのと同じ方針。
    const sourceFps = getSourceFps()
    const fps = sourceFps

    const meta = getRecordingMeta()
    finishRecordingState()

    // 素材のコマと撮れたフレームの対応付け。renderer 破損に備え、数値の配列で
    // あることを確認してから使う。ここが得られなくてもクリップ保存は続行する
    // （コマ精度の無い従来どおりのクリップとして残る方が、保存失敗より良い）。
    const usableDrawnAt = Array.isArray(drawnAt) && drawnAt.length > 0 &&
      drawnAt.length <= MAX_CLIP_DURATION_SEC * MAX_FRAME_RATE_FOR_VALIDATION &&
      drawnAt.every((t) => Number.isFinite(t))
    // 探索の窓を素材 1 コマ幅に閉じてあるので、オフセットの曖昧さが残っても表のずれは
    // 1 コマ未満に収まる。**以前あった「飽和したら表ごと捨てる」措置は不要になったので撤去した**
    // （供給が均一な録画ほどコマ精度を失う副作用の方が大きい）。疑わしい点の判定と警告は
    // frame-feed 側（offsetVerdict / logMatchResult）に集約してある。
    const frameTable = usableDrawnAt ? buildFrameTable(drawnAt) : null
    // 録画直後の検査が絵を取り出した後に表を作り直すのに使う。検査は非同期なので、次の録画で
    // 消える前に写しておく。
    const sourceFrames = frameTable ? getSourceFrames() : []
    const parsedDiag = parseCaptureDiag(diag)
    const supply = usableDrawnAt
      ? summarizeSupply(drawnAt, duration, sourceFps ? 1000 / sourceFps : null)
      : null

    // 1 録画ぶんの実測ログの見出し。
    //
    // **区切りと、いちばん知りたい数字を先頭に置く。** この下に 5〜7 行の詳細が続き、さらに
    // 検証（`[frame-verify]`）は数秒後に非同期で出て次の録画の行に混ざる。区切りが無いと
    // どこからどこまでが 1 本ぶんか読めない。
    //
    // 2 行目に素材の fps を**ラベル付きで**置くのは、詳細行の中では `source frame 41.7ms` や
    // `candidates 8 (13..20ms…)` に紛れて探さないと見つからないため。ここだけ見れば
    // 「何 fps の映像を、毎秒何枚で撮ったか」が分かる状態にする。
    // ASCII のみ（dev.bat のコンソールは Shift-JIS で日本語が化ける）。
    console.log(`\n===== clip #${sessionId}  ${new Date().toTimeString().slice(0, 8)}  ${duration.toFixed(1)}s =====`)
    console.log(
      `  video is ${sourceFps ? `${sourceFps.toFixed(3)} fps` : 'fps unknown'}` +
      `  |  screen captured at ${supply ? `${supply.drawnPerSec.toFixed(1)} frames/s` : 'n/a'}` +
      // 供給の天井がキャプチャ側かレコーダーウィンドウ側かの切り分け（CaptureDiag.tickerTicks）。
      `  |  window redrawn at ${parsedDiag?.tickerTicks != null ? `${(parsedDiag.tickerTicks / duration).toFixed(1)}/s` : 'n/a'}` +
      // 撮影枚数の上限と、その元にした画面のリフレッシュレート。自動起動の回だけ枚数が落ちた
      // （2026-11-09/12/13）原因の切り分け用——起動時の値が残って上限が低くなっていないか。
      (meta ? `  |  cap ${meta.captureFps}/s (display ${meta.displayHz ?? 'unknown'} Hz)` : '')
    )
    const settleNote = takeSettleNote()
    if (settleNote) console.log(settleNote)
    const startDoubts = takeStartDoubts()

    logMatchResult(frameTable)
    // 通知が途切れていた区間は表に入らず、割合にも枚数にも現れない（logReportInterruptions 参照）。
    logReportInterruptions()
    // 撮り逃しの原因を「供給不足」と「観測漏れ」に切り分けるための実測ログ（1録画1行）。
    // 素材の周期が分かるときだけ「素材1コマより長く空いた回数」も併記する。
    logSupplyDiag(supply, parsedDiag)
    // 次の録画のビットレートの根拠にする（recording.ts の supplyFps）。上限の見込みではなく
    // 実際に届いた枚数を使うため、ここで測った値を戻す。
    if (supply) recordMeasuredSupply(supply.drawnPerSec)
    // 突き合わせている 2 つの時刻の基準がどれだけずれているか（logClockDiag 参照）。
    // 表が作れなかった録画（拡張未接続など）でも出す。
    logClockDiag(getReportDelay(), parsedDiag)

    const webm = Buffer.from(webmAB)

    // 画質の判断材料（logBitrateDiag 参照）。素材のコマ数は表からしか分からないので、
    // 表が作れた録画でだけ「素材 1 コマあたり」が出る。画面の物理画素数も渡して、
    // キャプチャストリームが縮んでいないかをその場で読めるようにする。
    logBitrateDiag(
      webm.byteLength, duration, frameTable ? frameTable.matches.length : null, sourceFps,
      parsedDiag, getRecordingDisplayPixels()
    )

    const capturedAt = Date.now()
    const recordedPixels = recordedSize(parsedDiag)
    let webmPath: string | null = null
    let thumbPath: string | null = null
    // 録画状態は上で畳んであるので、ここから登録までの数秒は「録画中」に数えられない。
    // 登録しておかないと、その間の終了が確認なしで通り、このクリップが失われる。
    beginTask('clip-save')
    try {
      const dir = await ensureCaptureSubDir(capturedAt)
      webmPath = await writeCaptureFile(dir, webm, '.webm')
      const thumbOut = thumbPathFor(webmPath, '.png')
      try {
        await extractThumb(webmPath, thumbOut)
        thumbPath = thumbOut
      } catch (err) {
        console.warn('[clip] extractThumb failed, proceeding without thumb', err)
      }

      const result = await registerCapturedMedia({
        insert: {
          filepath: webmPath,
          captured_at: capturedAt,
          title: meta?.title ?? null,
          current_time: recordedStartTime(frameTable) ?? meta?.currentTime ?? null,
          url: meta?.url ?? null,
          // 実際に記録した画素数。**画質を語るときの母数**なので、取れないときは推定で
          // 埋めず空欄にする（fps を供給レートで埋めないのと同じ理由。capture-diag.ts の
          // recordedSize 参照）。
          width: recordedPixels?.width ?? null,
          height: recordedPixels?.height ?? null,
          colors: null,
          memo: null,
          media_type: 'video',
          duration,
          fps,
          thumb_path: thumbPath
        },
        filePath: webmPath,
        thumbPath,
        autoTag: thumbPath ? { path: thumbPath } : null
      })
      if (!result.ok) {
        sendFailureNotice('error', t('notice.clipSaveFailed'))
        return
      }
      // 見出し（clip #N）と image id の対応。**この後に出る `[frame-verify]` は数秒後の
      // 非同期なので、次の録画のログに混ざる。** id で引けるようにしておく。
      console.log(`[clip] #${sessionId} saved as image ${result.id}`)
      // フレーム表は保存できなくてもクリップ自体は成立する（コマ送りが従来動作に
      // 落ちるだけ）。ここで失敗させて保存済みのクリップを巻き戻す方が損失が大きい。
      const missedFrames = frameTable ? frameTable.matches.filter((m) => !m.captured).length : 0
      let verified: Promise<number | null> | null = null
      if (frameTable) {
        try {
          saveVideoFrames(result.id, frameTable.matches)
          setFrameCounts(
            result.id, missedFrames, frameTable.matches.length,
            countReportDrops(frameTable.matches), 0, reportDropsMeasured(frameTable.matches)
          )
          // 撮り逃しの有無にかかわらず走らせる。撮り逃しが 0 でも、表の frameIndex が
          // ファイル内の実フレームと一致しているかの照合は必要だから（一致しなければ
          // 全コマが黙って別の絵を指す）。以前は撮り逃しがあるときだけ呼んでいたが、
          // それだと「最も精度が良く見えるクリップ」ほど照合されないことになる。
          // 待たずに投げっぱなしにする — 保存の完了通知を遅らせないため。
          verified = verifyClipFrames(result.id, webmPath, frameTable.matches, drawnAt, sourceFrames)
        } catch (err) {
          console.error('[clip] saveVideoFrames failed', err)
        }
      }
      // 撮り逃したコマがあるときは枚数も添える。この場で分かれば撮り直せるが、後から
      // 詳細パネルで気づいても撮り直せる場面はもう終わっている。0 枚なら従来どおり
      // 何も足さない（大半はこちら。常に数字を出すと通知が読み飛ばされる）。
      //
      // **枚数は照合し直した後の数を出す。** 保存直後の数は時刻だけで決めた仮の値で、
      // 照合で決め直した詳細パネルの数と食い違っていた。照合できなかったときは保存直後の数を出す
      // （詳細パネルもその数のまま残る）。
      //
      // 照合は録画ファイルを読み直すので 1〜3 秒かかる。**その間も黙らない**——保存できたことは
      // 止めた瞬間に「確認中」で出し、照合が終わったら同じ通知を結果で書き換える（拡張は同じ場所に
      // 上書きする）。待ってから出すと、2 秒でも通知に気づけなかった（2026-11-07 の指摘）。
      // 仮の数は出さない（後から変わる数を見せると、詳細パネルと食い違う）。
      // 3 つの文言は末尾だけが違う形に揃えてあり、拡張は書き換えるとき左端を固定する
      // （中央寄せのままだと長さが変わるたびに文字が左右へ動く）。
      // **「撮り逃し なし」は照合で 0 と確かめたときだけ。** 照合できなかった・表が無いときは
      // 確かめていないので、従来どおり何も添えない。
      //
      // 冒頭について保証できなかったこと（StartDoubts）もここに添える。始める瞬間には出さない。
      // 置くのは尺の直後で、書き換わる「撮り逃し …」より前（後ろに置くと書き換えのたびに動く）。
      // 完了通知を切っていても、これがあるときは出す（保証できないことを黙らない）。
      const notes = (startDoubts.notSettled ? t('notice.clipNoteStartGap') : '') +
        (startDoubts.armingUnconfirmed ? t('notice.clipNoteArming') : '')
      const shouldNotify = loadSettings().clipNotify !== false || notes !== ''
      const d = formatClipDuration(duration)
      const notifySaved = (missed: number, confirmed: boolean): void => {
        if (!shouldNotify) return
        sendBrowserNotice('success', missed > 0
          ? t('notice.clipSavedWithMissed', { duration: d, notes, count: String(missed) })
          : t(confirmed ? 'notice.clipSavedNoMissed' : 'notice.clipSaved', { duration: d, notes }))
      }
      if (verified) {
        if (shouldNotify) sendBrowserNotice('success', t('notice.clipSavedChecking', { duration: d, notes }), true)
        void verified.then((missed) => notifySaved(missed ?? missedFrames, missed !== null))
      } else notifySaved(missedFrames, false)
    } catch (err) {
      console.error('[clip] save failed', err)
      if (webmPath) try { await unlink(webmPath) } catch {}
      if (thumbPath) try { await unlink(thumbPath) } catch {}
      sendFailureNotice('error', t('notice.clipSaveFailed'))
    } finally {
      endTask('clip-save')
    }
  })
}
