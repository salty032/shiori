// 保存済みクリップのフレーム表を、実ファイルと突き合わせて確かめる（起動部）。
//
// やることは 2 つ。
//   1. フレーム表の土台（frameIndex がファイル内の実フレーム番号と一致すること）の確認
//   2. 撮り逃したコマに実害があるかの検証（判定そのものは frame-verify.ts の純関数）
//
// ffmpeg でフレームの署名と表示時刻を取り出し、結果を DB へ書き戻すところだけを受け持つ。
// 録画とトリミングの両方から同じ経路で呼べるように独立させてある。
import { getFrameSignatures } from './ffmpeg'
import { findFrameDivergence, logVerifyResult, verifyFrameTable } from './frame-verify'
import { dropVideoFrames, saveVideoFrames, setAmbiguousFrames, setUncapturedFrames, type StoredFrame } from '../db'
import { sendToRenderer } from '../windows'
import { CH } from '../../shared/api'

// 検証で確定した枚数を画面へ反映させる。
//
// 一覧は保存時点のスナップショットで、ここが裏で書き換える DB の値を自分では拾わない。
// 飛ばさないと**検証済みなのに「N コマ未取得」（未検証の表示）のまま**になる
// （実測 2026-08-10: DB は ambiguous=64 なのに画面は 90コマ未取得 のままだった）。
// fps の遡及埋め（fps:backfilled）と同じ購読パターン。
function notifyVerified(imageId: number, uncaptured: number | null, ambiguous: number | null): void {
  sendToRenderer(CH.framesVerified, { id: imageId, uncaptured, ambiguous })
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
      logVerifyResult(null)
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
        console.error(
          `[frame-verify] frame correspondence breaks at index ${divergeAt}` +
          ` (supplied ${drawnAt.length}, file has ${signatures.length}).` +
          ` head shift [${head}]ms | around break [${around}]ms | tail [${tail}]ms.` +
          ' Dropping the frame table (frame stepping falls back to raw file frames).'
        )
        dropVideoFrames(imageId)
        notifyVerified(imageId, null, null)
        return
      }
      // 末尾だけ足りない。そこまでの対応は正しいので、範囲外を指すコマを落として残りを使う。
      const kept = frames.filter((f) => f.frameIndex < signatures.length)
      if (kept.length === 0) {
        dropVideoFrames(imageId)
        notifyVerified(imageId, null, null)
        return
      }
      console.warn(
        `[frame-verify] file is short by ${drawnAt.length - signatures.length} frame(s) at the end` +
        ` (supplied ${drawnAt.length}, file has ${signatures.length});` +
        ` correspondence holds up to the end, so ${frames.length - kept.length} trailing frame(s) were trimmed.`
      )
      frames = kept
      saveVideoFrames(imageId, frames)
      setUncapturedFrames(imageId, frames.filter((f) => !f.captured).length)
    }

    const missed = frames.filter((f) => !f.captured).length
    // 撮り逃しが 1 コマも無ければ検証する対象が無い（照合だけが目的だった）。
    // 末尾を切って枚数が変わっている場合があるので、画面への反映だけは伝える。
    if (missed === 0) {
      notifyVerified(imageId, 0, null)
      return
    }

    const result = verifyFrameTable(frames, signatures)
    saveVideoFrames(imageId, result.frames)
    setAmbiguousFrames(imageId, result.ambiguous)
    notifyVerified(imageId, missed, result.ambiguous)
    logVerifyResult(result)
  } catch (err) {
    // 検証できなくてもクリップは従来どおり使える（注記が「未検証」のまま残るだけ）。
    console.warn('[frame-verify] failed', err)
  }
}
