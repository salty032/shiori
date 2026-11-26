// 切り出し画面（VideoTrimmer.tsx）の開始・終了の計算。表（コマの頭の時刻 pts）があるときだけ使う。
//
// **ここで決めた開始・終了の時刻がそのまま ffmpeg に渡る**（trimVideo(id, 開始, 終了)）。ずれても画面上は
// 普通に切り出せてしまい、切り出した動画のコマの対応だけが黙ってずれる。開始はコマの頭の時刻ちょうど
// （間の時刻から切ると ffmpeg は手前の絵を捨てる。docs/SPEC.md「切り出し」）。
//
// 撮り逃したコマは直前のコマと同じ時刻で並ぶ。**時刻だけでは行が決まらない**ので、行と時刻を両方持つ。
import { FRAME_EPS, findFrameIdx } from './frameTable'

// 覚えている行が今の時刻と合っていればその行。食い違っていれば（ドラッグ・クリック等で時刻だけ
// 動いた）時刻から引く。時刻から引くと同じ時刻の並びでは最後の行になる。
export function boundaryRow(pts: number[], row: number, sec: number): number {
  if (row >= 0 && row < pts.length && Math.abs(pts[row] - sec) <= FRAME_EPS) return row
  return findFrameIdx(pts, sec)
}

// 終了に選んだコマの「終わり」＝次に時刻が進む行の頭。終了のコマを含めて切るので ffmpeg にはこれを渡す。
// 次の行ではなく次に時刻が進む行を取る——撮り逃しの行を終了にしたとき次の行を取ると、映っている絵の
// 手前で切れる。最後のコマなら動画の終わり。
export function trimEndSec(pts: number[], duration: number, outSec: number): number {
  let idx = findFrameIdx(pts, outSec)
  // findFrameIdx は表の先頭に同じ時刻が並ぶときだけ最初の行を返すので、ここで並びの最後まで進める。
  while (idx + 1 < pts.length && pts[idx + 1] <= outSec + FRAME_EPS) idx++
  return idx + 1 < pts.length ? pts[idx + 1] : duration
}

// タイムライン上の時刻を、近い方のコマの頭へ寄せる。
export function snapToFrameStart(pts: number[], sec: number): number {
  const idx = findFrameIdx(pts, sec)
  if (idx + 1 < pts.length) {
    const prev = pts[idx]
    const next = pts[idx + 1]
    return sec - prev <= next - sec ? prev : next
  }
  return pts[idx]
}

// 開始は終了より 1 行前まで、終了は開始より 1 行後ろまで（長さ 0 の切り出しを作らない）。
export function inRowWithin(row: number, outRow: number): number {
  return Math.max(0, Math.min(row, outRow - 1))
}

export function outRowWithin(row: number, inRow: number, total: number): number {
  return Math.max(inRow + 1, Math.min(row, total - 1))
}
