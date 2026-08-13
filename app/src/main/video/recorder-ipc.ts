// レコーダーウィンドウ専用 IPC（recorder:getCrop / recorder:error / recorder:done）。
// recorder:* は ShioriApi の CH 定数の対象外（別契約・別検証方式。preload/recorder.ts 参照）。
import { ipcMain } from 'electron'
import { unlink } from 'fs/promises'
import { computeVideoCrop, writeCaptureFile } from '../capture/capture'
import { sendNotice, sendToRenderer } from '../system/windows'
import { ensureCaptureSubDir, thumbPathFor } from '../system/paths'
import { loadSettings } from '../system/settings'
import { sendBrowserNotice } from '../browser/browser-notice'
import { CH } from '../../shared/api'
import { isTrustedRecorderSender } from './recorder-window'
import { extractThumb } from './ffmpeg'
import { verifyClipFrames } from './verify-clip'
import { finishRecordingState, getRecordingMeta, isCurrentRecordingSession, recordMeasuredSupply, releaseCaptureUi } from './recording'
import { logMatchResult, buildFrameTable, getSourceFps, getReportDelay, logReportInterruptions } from './frame-feed'
import { logBitrateDiag, logClockDiag, logSupplyDiag, parseCaptureDiag, summarizeSupply } from './capture-diag'
import { registerCapturedMedia } from '../capture/captured-media'
import { saveVideoFrames, setFrameCounts } from '../db'
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

function formatClipDuration(seconds: number): string {
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
}

export function registerRecorderIpc(): void {
  ipcMain.handle('recorder:getCrop', (event, streamW: number, streamH: number) => {
    if (!isTrustedRecorderSender(event)) return null
    return computeVideoCrop(streamW, streamH)
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
      sendNotice('warning', t('notice.videoRegionNotFound'))
    } else if (msg === 'no_data') {
      sendNotice('warning', t('notice.recordingEmpty'))
    } else if (msg === 'getUserMedia_not_allowed') {
      sendNotice('error', t('notice.screenCapturePermission'))
    } else {
      sendNotice('error', t('notice.recordingError', { message: msg.slice(0, 80) }))
    }
  })

  ipcMain.on('recorder:done', async (event, webmAB: ArrayBuffer, duration: number, frameCount: number, sessionId: number, drawnAt: number[], diag: unknown) => {
    if (!isTrustedRecorderSender(event)) return
    // recorder:error と同じ理由（レコーダーウィンドウ側のレース）で、現在のセッションと
    // 一致しない完了通知は無視する。新しい録画を誤って確定・保存させない。
    if (!isCurrentRecordingSession(sessionId)) return

    // renderer 側が壊れた場合に備えた入力検証（メモリ DoS / 不正データ対策）
    if (!(webmAB instanceof ArrayBuffer) || webmAB.byteLength === 0 || webmAB.byteLength > MAX_WEBM_BYTES) {
      console.error('[clip] recorder:done rejected: invalid webm payload', { byteLength: (webmAB as ArrayBuffer)?.byteLength })
      finishRecordingState()
      sendNotice('error', t('notice.recordingDataInvalid'))
      return
    }
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_CLIP_DURATION_SEC) {
      console.error('[clip] recorder:done rejected: invalid duration', { duration })
      finishRecordingState()
      sendNotice('error', t('notice.recordingDataInvalid'))
      return
    }

    // fps 列が意味するのは**素材のフレームレート**（研究用途で意味を持つのはこちらだけ）。
    //
    // frameCount/duration は「画面キャプチャが何枚寄越したか」でしかなく、素材とは無関係な
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
      `  |  window redrawn at ${parsedDiag?.tickerTicks != null ? `${(parsedDiag.tickerTicks / duration).toFixed(1)}/s` : 'n/a'}`
    )

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
    // 表が作れた録画でだけ「素材 1 コマあたり」が出る。
    logBitrateDiag(webm.byteLength, duration, frameTable ? frameTable.matches.length : null, sourceFps, parsedDiag)

    const capturedAt = Date.now()
    let webmPath: string | null = null
    let thumbPath: string | null = null
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
          current_time: meta?.currentTime ?? null,
          url: meta?.url ?? null,
          width: null,
          height: null,
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
        sendNotice('error', t('notice.clipSaveFailed'))
        return
      }
      // 見出し（clip #N）と image id の対応。**この後に出る `[frame-verify]` は数秒後の
      // 非同期なので、次の録画のログに混ざる。** id で引けるようにしておく。
      console.log(`[clip] #${sessionId} saved as image ${result.id}`)
      // フレーム表は保存できなくてもクリップ自体は成立する（コマ送りが従来動作に
      // 落ちるだけ）。ここで失敗させて保存済みのクリップを巻き戻す方が損失が大きい。
      const missedFrames = frameTable ? frameTable.matches.filter((m) => !m.captured).length : 0
      if (frameTable) {
        try {
          saveVideoFrames(result.id, frameTable.matches)
          setFrameCounts(result.id, missedFrames, frameTable.matches.length, frameTable.reportDrops)
          // 撮り逃しの有無にかかわらず走らせる。撮り逃しが 0 でも、表の frameIndex が
          // ファイル内の実フレームと一致しているかの照合は必要だから（一致しなければ
          // 全コマが黙って別の絵を指す）。以前は撮り逃しがあるときだけ呼んでいたが、
          // それだと「最も精度が良く見えるクリップ」ほど照合されないことになる。
          // 待たずに投げっぱなしにする — 保存の完了通知を遅らせないため。
          void verifyClipFrames(result.id, webmPath, frameTable.matches, drawnAt)
        } catch (err) {
          console.error('[clip] saveVideoFrames failed', err)
        }
      }
      if (loadSettings().clipNotify !== false) {
        // 撮り逃したコマがあるときは枚数も添える。この場で分かれば撮り直せるが、後から
        // 詳細パネルで気づいても撮り直せる場面はもう終わっている。0 枚なら従来どおり
        // 何も足さない（大半はこちら。常に数字を出すと通知が読み飛ばされる）。
        sendBrowserNotice('success', missedFrames > 0
          ? t('notice.clipSavedWithMissed', { duration: formatClipDuration(duration), count: String(missedFrames) })
          : t('notice.clipSaved', { duration: formatClipDuration(duration) }))
      }
    } catch (err) {
      console.error('[clip] save failed', err)
      if (webmPath) try { await unlink(webmPath) } catch {}
      if (thumbPath) try { await unlink(thumbPath) } catch {}
      sendNotice('error', t('notice.clipSaveFailed'))
    }
  })
}
