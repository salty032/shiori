// 保存済みクリップに対する撮り逃しコマの検証（起動部）。
//
// 判定そのものは frame-verify.ts（純関数）が持つ。こちらは ffmpeg でフレームの署名を
// 取り出し、結果を DB へ書き戻すところだけを受け持つ。録画とトリミングの両方から
// 同じ経路で呼べるように独立させてある。
import { getFrameSignatures } from './ffmpeg'
import { logVerifyResult, verifyFrameTable } from './frame-verify'
import { saveVideoFrames, setAmbiguousFrames, type StoredFrame } from '../db'

// クリップを保存し終えてから走らせる。フル デコードを伴うので数秒かかることがあり、
// 完了を待たせるとその間ホットキーが効かず次の場面を撮り逃す。検証は「表示に出る注記が
// 後から精密になる」だけの後追い処理なので、失敗しても保存済みのクリップには影響させない。
export async function verifyClipFrames(imageId: number, videoPath: string, table: StoredFrame[]): Promise<void> {
  try {
    const signatures = await getFrameSignatures(videoPath)
    if (signatures.length === 0) {
      logVerifyResult(null)
      return
    }
    const result = verifyFrameTable(table, signatures)
    saveVideoFrames(imageId, result.frames)
    setAmbiguousFrames(imageId, result.ambiguous)
    logVerifyResult(result)
  } catch (err) {
    // 検証できなくてもクリップは従来どおり使える（注記が「未検証」のまま残るだけ）。
    console.warn('[frame-verify] failed', err)
  }
}
