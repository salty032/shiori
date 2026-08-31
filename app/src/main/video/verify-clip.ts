// 保存済みクリップのフレーム表を、実ファイルと突き合わせて確かめる（起動部）。
//
// やることは 2 つ。
//   1. フレーム表の土台（frameIndex がファイル内の実フレーム番号と一致すること）の確認
//   2. 撮り逃したコマに実害があるかの検証（判定そのものは frame-verify.ts の純関数）
//
// ffmpeg でフレームの署名と表示時刻を取り出し、結果を DB へ書き戻すところだけを受け持つ。
// 録画とトリミングの両方から同じ経路で呼べるように独立させてある。
import { getFrameSignatures } from './ffmpeg'
import { invalidateClipFrames } from './ipc-video'
import {
  applyAnimeGapEstimates, checkTableAgainstFile, findFrameDivergence, logVerifyResult, verifyFrameTable
} from './frame-verify'
import { setAmbiguousFrames, setFrameCounts } from '../db'
import {
  listClipsForRecheck, markRechecked, markVideoFramesUnusable, saveVideoFrames, type StoredFrame
} from '../db-video-frames'
import { countReportDrops, reportDropsMeasured } from './frame-feed'
import { isCurrentlyRecording } from './recording'
import { sendToRenderer } from '../system/windows'
import { CH } from '../../shared/api'

// 検証で確定した枚数を画面へ反映させる。
//
// 一覧は保存時点のスナップショットで、ここが裏で書き換える DB の値を自分では拾わない。
// 飛ばさないと**検証済みなのに「N コマ未取得」（未検証の表示）のまま**になる
// （実測 2026-08-10: DB は ambiguous=64 なのに画面は 90コマ未取得 のままだった）。
// fps の遡及埋め（fps:backfilled）と同じ購読パターン。
// total（素材のコマ総数）も一緒に流す。末尾を切ったときは母数も変わるので、枚数だけ送ると
// 一覧のスナップショットの中で分子と分母が別の時点の数になり、割合の判定が静かに狂う。
// misaligned まで流すのは、詳細パネルの「要注意」がこの値で決まるため。**落とすと録画した
// 直後の 1 本だけ、コマ送りの表示が赤いのに詳細パネルが黙る**（開き直すまで直らない）。
function notifyVerified(
  imageId: number, uncaptured: number | null, ambiguous: number | null,
  total: number | null, unreported: number | null, misaligned: number | null = 0,
  unreportedMeasured = false
): void {
  // **画面へ知らせる前にキャッシュを捨てる。** ここへ来るのは表を書き換えた後だけで、
  // 捨てないと開いたままのクリップが古い並びのままコマ送りを続ける。
  invalidateClipFrames(imageId)
  sendToRenderer(CH.framesVerified, { id: imageId, uncaptured, ambiguous, total, unreported, misaligned, unreportedMeasured })
}

/**
 * クリップを保存し終えてから走らせる。フル デコードを伴うので数秒かかることがあり、
 * 完了を待たせるとその間ホットキーが効かず次の場面を撮り逃す。表示に出る注記が後から
 * 精密になるだけの後追い処理なので、失敗しても保存済みのクリップには影響させない。
 *
 * @param drawnAt 録画時に供給した各フレームの取り込み時刻。渡すと 1. の照合を行う。
 *   トリミング経路は表の frameIndex を切り出し後の PTS 列から作り直しており、定義上ずれない
 *   ので null を渡す。
 */
export async function verifyClipFrames(
  imageId: number,
  videoPath: string,
  table: StoredFrame[],
  drawnAt: number[] | null
): Promise<void> {
  try {
    const { signatures, pts } = await getFrameSignatures(videoPath)
    if (signatures.length === 0) {
      logVerifyResult(imageId, null)
      return
    }

    let frames = table

    // 表の frameIndex は「requestFrame を呼んだ回数」の添字で、ファイル内のデコード実フレームの
    // 添字と一致することが全ての前提になっている。MediaRecorder はエンコードに詰まると
    // フレームを落とすが、値は範囲内に収まるので他のどの検査にも引っかからない（別のコマの絵を
    // 正しい絵として黙って出し続けることになる）。
    if (drawnAt !== null && signatures.length !== drawnAt.length) {
      // 枚数の差だけでは「末尾が足りない」のか「途中で落ちた」のか区別が付かない。
      // 時刻で対応が崩れる位置を割り出して、根拠を持って分ける。
      const paired = Math.min(drawnAt.length, pts.length)
      const divergeAt = findFrameDivergence(drawnAt, pts)
      if (divergeAt < paired) {
        // 崩れの正体を 1 本の録画で切り分けるための診断。
        // 供給時刻とファイル内 PTS の「先頭からのずれ」を並べる。読み方:
        //   ある位置から供給 1 回ぶん（実測 17.8ms）の階段が末尾まで続く → そこで落ちている
        //   外れても数枚で 0 付近へ戻る → 一過性の揺らぎ。対応は保たれている（崩れではない）
        // 実測（2026-08-10）では先頭で -7.5 / -15.0ms の外れが出て 3 枚目で戻り、末尾は 0.7ms
        // だった。**この形は崩れではない**ので findFrameDivergence は持続を見て判定する。
        const shiftAt = (i: number): string =>
          (drawnAt[i] - drawnAt[0] - (pts[i] - pts[0]) * 1000).toFixed(1)
        const head = Array.from({ length: Math.min(8, paired) }, (_, i) => shiftAt(i)).join(', ')
        const around = [divergeAt - 2, divergeAt - 1, divergeAt, divergeAt + 1, divergeAt + 2]
          .filter((i) => i >= 0 && i < paired)
          .map((i) => `${i}:${shiftAt(i)}`)
          .join(' ')
        const tail = paired > 3
          ? [paired - 3, paired - 2, paired - 1].map((i) => `${i}:${shiftAt(i)}`).join(' ')
          : ''
        // **段差が見えただけでは印を立てない。その場で測り直して裏を取る。**
        //
        // 供給時刻とファイル PTS の段差は、**原点に置いた 1 枚がずれているだけでも出る。**
        // 実測（2026-08-31・image 307）: ファイル先頭の 2 枚が 1ms 差で入っており、その 1 枚を
        // 原点にしたせいで残り全域が -19ms の水準に見えた。段差は 3 行目で立ち、303 行のうち
        // 301 行に印が付いたが、**対応は末尾まで崩れていなかった**（水準は全区間で -19ms
        // 前後の平坦。崩れていればずれは溜まって戻らない）。同じ日の 24fps の録画はもっと
        // 大きな水準差（+30〜44ms）を持ちながら、枚数が一致していたので検査自体が走らず
        // 印ゼロだった——**赤くなるかどうかが、精度ではなく検査が走ったかで決まっていた。**
        //
        // checkTableAgainstFile は供給時刻を使わず、素材の時刻の進みと、表が指すファイル内
        // フレームの時刻の進みだけを比べる。原点のずれは全域へ等しく乗って消え、本当の崩れ
        // だけがずれの蓄積として残る。**起動時の見直しが使うのと同じ判定**なので、ここで
        // 印を立てても次の起動で外れる——それなら最初から立てない。
        //
        // 代償：見分けられるずれは素材 1 コマぶんまでで、それより小さい崩れ（供給 1 枚ぶん・
        // 約 20ms）はここを通る。**画面からは気づけない。** 判定を厳しくする側は、正しい表を
        // 捨てる誤りに直結するため、この幅は起動時の見直しと揃えたままにしてある。
        const confirmed = checkTableAgainstFile(frames, pts)
        // **崩れた位置より手前は正しいので、そこまでは使う。** 以前は表を丸ごと使わなく
        // していたが、それ自体がコマ精度を失う変更にあたる（docs/ANIME-FRAMES.md 0 章）。
        // ずれた行には印を立て、画面ではそのコマだけ赤く出す。
        // 測り直せなかったとき（行が 3 つ未満・周期が出ない）だけ、従来どおり段差から先へ印を立てる。
        const marked = confirmed.frames.length > 0
          ? confirmed.frames
          : frames
              .filter((f) => f.frameIndex < signatures.length)
              .map((f) => (f.frameIndex >= divergeAt ? { ...f, misaligned: true } : f))
        const misaligned = marked.filter((f) => f.misaligned).length
        const usable = marked.length - misaligned
        const verdict = marked.length === 0
          ? 'no row points inside the file'
          : misaligned === 0
            ? 'table still tracks the file to the end, so no row was marked'
            : `keeping the ${usable} usable row(s); ${misaligned} row(s) marked misaligned`
        const log = usable > 0 && misaligned === 0 ? console.warn : console.error
        log(
          `[frame-verify] image ${imageId}: supply/file step at index ${divergeAt}` +
          ` (supplied ${drawnAt.length}, file has ${signatures.length}).` +
          ` head shift [${head}]ms | around break [${around}]ms | tail [${tail}]ms.` +
          ` Re-measured the table against the file: worst ${confirmed.worstMs.toFixed(1)}ms` +
          ` — ${verdict}.`
        )
        if (marked.length === 0 || (misaligned > 0 && misaligned === marked.length)) {
          // 1 行も使えるところが無い。ここだけは表として成立しない。
          markVideoFramesUnusable(imageId, 'correspondence-break')
          notifyVerified(imageId, null, null, null, null, null)
          return
        }
        if (misaligned > 0) {
          saveVideoFrames(imageId, marked)
          setFrameCounts(
            imageId,
            marked.filter((f) => !f.captured).length,
            marked.length,
            countReportDrops(marked),
            misaligned,
            reportDropsMeasured(marked)
          )
          notifyVerified(
            imageId,
            marked.filter((f) => !f.captured).length,
            null,
            marked.length,
            countReportDrops(marked),
            misaligned,
            reportDropsMeasured(marked)
          )
          return
        }
        // 裏が取れなかった＝表はそのまま使える。範囲外を指す行だけ落として通常の経路へ戻す。
        frames = marked
        saveVideoFrames(imageId, frames)
        setFrameCounts(imageId, frames.filter((f) => !f.captured).length, frames.length, countReportDrops(frames), 0, reportDropsMeasured(frames))
      } else {
        // 末尾だけ足りない。そこまでの対応は正しいので、範囲外を指すコマを落として残りを使う。
        const kept = frames.filter((f) => f.frameIndex < signatures.length)
        if (kept.length === 0) {
          markVideoFramesUnusable(imageId, 'no-frame-within-file')
          notifyVerified(imageId, null, null, null, null, null)
          return
        }
        console.warn(
          `[frame-verify] image ${imageId}: file is short by ${drawnAt.length - signatures.length} frame(s) at the end` +
          ` (supplied ${drawnAt.length}, file has ${signatures.length});` +
          ` correspondence holds up to the end, so ${frames.length - kept.length} trailing frame(s) were trimmed.`
        )
        frames = kept
        saveVideoFrames(imageId, frames)
        setFrameCounts(imageId, frames.filter((f) => !f.captured).length, frames.length, countReportDrops(frames), 0, reportDropsMeasured(frames))
      }
    }

    // 通知欠落数とは別に、左右に残った絵のあいだだけにあるアニメのコマ数を推定する。
    // 署名は上の対応検査と同じ1回のデコード結果を使うので、録画後の負荷は増えない。
    const animeGaps = applyAnimeGapEstimates(frames, signatures, pts)
    frames = animeGaps.frames
    if (animeGaps.changed) saveVideoFrames(imageId, frames)

    const missed = frames.filter((f) => !f.captured).length
    // 撮り逃しが 1 コマも無ければ検証する対象が無い（照合だけが目的だった）。
    // 末尾を切って枚数が変わっている場合があるので、画面への反映だけは伝える。
    if (missed === 0) {
      notifyVerified(imageId, 0, null, frames.length, countReportDrops(frames), 0, reportDropsMeasured(frames))
      return
    }

    const result = verifyFrameTable(frames, signatures)
    saveVideoFrames(imageId, result.frames)
    setAmbiguousFrames(imageId, result.ambiguous)
    notifyVerified(imageId, missed, result.ambiguous, frames.length, countReportDrops(frames), 0, reportDropsMeasured(frames))
    logVerifyResult(imageId, result)
  } catch (err) {
    // 検証できなくてもクリップは従来どおり使える（注記が「未検証」のまま残るだけ）。
    console.warn(`[frame-verify] image ${imageId}: failed`, err)
  }
}

// 印の付いた表を、もう一度ファイルと突き合わせて救う。
//
// **判定は経験則なので、実測を踏むたび調整が入る。** 2026-08-26 は録画時の判定が誤って
// 231 コマ・撮り逃し 0 の表を捨てていた。直したあとも、既に印が付いたクリップは印が付いた
// ままで黄色く出続ける——残しただけでは戻らないので、見直す口が要る。
//
// **「使えない」印だけでなく、ずれの印が立っただけのクリップも見る**（2026-08-31）。
// 後者は画面に「要注意」として出るが、それまで見直しの対象外で、**一度赤くなったら
// 戻る口が無かった**（実測: image 307 は 303 行のうち 301 行が誤って印付き）。
//
// 1 本ごとにフル デコードが要るので、同じ版では二度見しない（markRechecked）。
// 判定を直したときは RECHECK_VERSION を上げれば、次の起動で全部もう一度見直される。
const RECHECK_YIELD_MS = 2000

export async function recheckMarkedClips(): Promise<void> {
  const targets = listClipsForRecheck()
  if (targets.length === 0) return
  console.log(`[frame-recheck] ${targets.length} marked clip(s), re-checking against the files`)
  // 番号だけでは画面のどの録画か探せない。撮影時刻を添える（ASCII のみ——dev.bat の
  // コンソールは Shift-JIS でタイトルの日本語が化ける）。
  const when = (at: number | null): string =>
    at ? new Date(at).toLocaleString('sv-SE').slice(5, 16) : 'unknown time'
  for (const target of targets) {
    // **録画中は必ず譲る。** 1 本ごとに動画をまるごとデコードするので CPU を食う。
    // 録画中に走らせると、キャプチャの負荷でページが素材のコマを描き落とす——
    // recording.ts の waitForSteadyFrames で塞いだのと同じ壊れ方を、こちらから起こすことになる。
    // 撮り終えてから続ける（後追いの処理なので、遅れて困るものではない）。
    while (isCurrentlyRecording()) {
      await new Promise((resolve) => setTimeout(resolve, RECHECK_YIELD_MS))
    }
    try {
      const { pts } = await getFrameSignatures(target.filepath)
      if (pts.length === 0) {
        markRechecked(target.imageId)
        continue
      }
      const match = checkTableAgainstFile(target.frames, pts)
      const usable = match.frames.length - match.misaligned
      if (usable === 0) {
        console.log(
          `[frame-recheck] image ${target.imageId} (${when(target.capturedAt)}): no usable rows` +
          ` (${match.misaligned}/${match.frames.length} misaligned, worst ${match.worstMs.toFixed(1)}ms)`
        )
        markRechecked(target.imageId)
        continue
      }
      // 印を外して通常の表へ戻す。ずれた行には印が立っており、そこだけ画面で赤く出る。
      // **全部か全部ダメにしない**——使える行が 1 つでもあれば、その精度は返す。
      saveVideoFrames(target.imageId, match.frames)
      // 救えたときも版を記録する。**印が残ったクリップを毎回の起動でデコードし直さないため。**
      markRechecked(target.imageId)
      setFrameCounts(
        target.imageId,
        match.frames.filter((f) => !f.captured).length,
        match.frames.length,
        countReportDrops(match.frames),
        match.misaligned,
        reportDropsMeasured(match.frames)
      )
      console.log(
        `[frame-recheck] image ${target.imageId} (${when(target.capturedAt)}): restored` +
        ` (${usable} usable, ${match.misaligned} misaligned, worst ${match.worstMs.toFixed(1)}ms)`
      )
      notifyVerified(
        target.imageId,
        match.frames.filter((f) => !f.captured).length,
        null,
        match.frames.length,
        countReportDrops(match.frames),
        match.misaligned,
        reportDropsMeasured(match.frames)
      )
    } catch (err) {
      console.warn(`[frame-recheck] image ${target.imageId} failed`, err)
    }
  }
}
