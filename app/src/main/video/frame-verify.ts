// 撮り逃したコマが本当に問題なのかを、録画後に絵で検証する。
//
// 素材のコマに専用の絵が無いと、直前のコマの絵を流用することになる
// （frame-feed.ts の captured=false）。これが起きるのは画面キャプチャの供給が素材のコマ数の
// 2 倍に届かないとき。
//
// 供給は約 50枚/秒まで引き上げてあり（recorder.ts の startCaptureTicker）、24fps 素材なら
// 必要な 2 倍（約 48枚/秒）を満たすので実測で 100% 撮れている。ただし 30fps 素材には
// 60枚/秒、60fps 素材には 120枚/秒が要るため届かず、高負荷で供給が落ちたときも同じ。
// つまり撮り逃しは「もう起きない」ものではなく、素材と状況次第で必ず出る。
//
// ただし撮り逃しの大半は「同じ絵が続いている区間」に当たっており、流用は結果的に正しい。
// 実害があるのは絵の変わり目に当たった場合だけで、そこだけがコマ打ちの数を誤らせる。
// 前後のキャプチャを比べれば、この2つは区別できる。
//
//   前後で絵が変わっていない → 流用は正しい。実害なしと確定（'same'）
//   前後で絵が変わっている   → その区間で絵が変わったことは確定する。ただし区間には
//                              素材のコマ境界が2つ入るため、どちらのコマで変わったかは
//                              決められない → 要確認として残す（'changed'）
//
// 後者を「たぶん直前のコマだろう」と埋めることはしない。研究用途では、黙って間違った
// コマ打ちを出すことが最悪の結果になる。特定できないものは特定できないと出す。
import type { FrameVerify, StoredFrame } from '../db'

// 「絵が変わった」と判定するしきい値。
//
// 判定の向きは意図的に非対称にしてある。'changed'（要確認）と言い過ぎても失うのは
// 「確認しなくてよかった」という手間だけだが、'same'（実害なし）と言い間違えると
// 誤ったコマ打ちを正しいものとして提示してしまう。後者だけは避けたいので、
// わずかな差でも変化側へ倒れるよう低めに置く。
const CELL_DIFF = 5      // 1セル（0-255）がこの値以上動いたら「動いたセル」
const CHANGED_CELLS = 3  // 動いたセルがこの数以上あれば「絵が変わった」

// 2つの署名（グレースケールの縮小画像）が別の絵かどうか。
export function signaturesDiffer(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return true
  let moved = 0
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) >= CELL_DIFF) {
      moved++
      if (moved >= CHANGED_CELLS) return true
    }
  }
  return false
}

export interface VerifyResult {
  /** 検証結果を書き込んだフレーム表（入力と同じ長さ・同じ順序） */
  frames: StoredFrame[]
  /** 専用の絵が無かったコマの総数（従来の uncaptured_frames と同じ意味） */
  missed: number
  /** そのうち「絵が変わっていて特定できない」コマ数＝本当に要確認な枚数 */
  ambiguous: number
  /** そのうち「絵が変わっておらず実害なし」と確定したコマ数 */
  harmless: number
  /** 署名が足りない等で判定できなかったコマ数 */
  unknown: number
  /** ファイル内のフレーム数（署名の枚数） */
  fileFrames: number
  /**
   * 隣り合うフレームのあいだで絵が変わったと判定した回数。
   *
   * 「実害なし」の判定を信用してよいかを外から確かめるための数字。撮り逃しが全部
   * 実害なしに落ちたとき、それが本当に静止区間だったのか、それとも検出器が鈍くて
   * 変化を見落としているだけなのかは、この総数を見れば区別できる（2コマ打ち中心の
   * アニメなら、隣接フレームの半分前後で絵が変わるのが自然な値）。
   */
  fileChanges: number
}

// フレーム表と、ファイル内全フレームの署名から、撮り逃したコマを分類する。
//
// 撮り逃したコマ k は「直前のキャプチャ a の絵を流用している」状態なので、
// 次に別の絵が現れるキャプチャ b までの間に絵の変化があったかを見ればよい。
// a と b の間の全フレームを順に比べるのは、間に複数フレームが挟まる場合
// （連続して撮り逃した場合など）に変化を跨いで見落とさないため。
export function verifyFrameTable(table: StoredFrame[], signatures: Uint8Array[]): VerifyResult {
  const frames = table.map((f) => ({ ...f }))
  let missed = 0
  let ambiguous = 0
  let harmless = 0
  let unknown = 0

  for (let k = 0; k < frames.length; k++) {
    if (frames[k].captured) {
      frames[k].verified = 'unknown'   // 撮れているコマに検証結果は要らない
      continue
    }
    missed++
    const verdict = classify(frames, k, signatures)
    frames[k].verified = verdict
    if (verdict === 'changed') ambiguous++
    else if (verdict === 'same') harmless++
    else unknown++
  }

  let fileChanges = 0
  for (let j = 1; j < signatures.length; j++) {
    if (signaturesDiffer(signatures[j - 1], signatures[j])) fileChanges++
  }

  return { frames, missed, ambiguous, harmless, unknown, fileFrames: signatures.length, fileChanges }
}

function classify(frames: StoredFrame[], k: number, signatures: Uint8Array[]): FrameVerify {
  const a = frames[k].frameIndex
  if (a < 0 || a >= signatures.length) return 'unknown'

  // 次に別の絵を指すコマを探す。見つからない（末尾まで同じ絵）なら、比較相手が無いので
  // 判定しない。最後のコマを撮り逃した場合がこれに当たる。
  let b = -1
  for (let m = k + 1; m < frames.length; m++) {
    if (frames[m].frameIndex !== a) { b = frames[m].frameIndex; break }
  }
  if (b < 0 || b >= signatures.length) return 'unknown'
  // 表は時間順なので b > a のはず。逆行しているなら想定外の表なので判定を避ける。
  if (b <= a) return 'unknown'

  for (let j = a + 1; j <= b; j++) {
    if (signaturesDiffer(signatures[j - 1], signatures[j])) return 'changed'
  }
  return 'same'
}

// 検証の結果を1行だけ残す。出力は英語（dev.bat のコンソールは Shift-JIS のため）。
export function logVerifyResult(result: VerifyResult | null): void {
  if (!result) {
    console.log('[frame-verify] skipped (no frame table or signatures)')
    return
  }
  // 末尾の picture changes は判定の感度そのものを見るための数字（VerifyResult 参照）。
  // ここが極端に小さいときは「静止していた」のではなく「変化を見落としている」を疑う。
  const transitions = Math.max(0, result.fileFrames - 1)
  const rate = transitions > 0 ? (result.fileChanges / transitions) * 100 : 0
  console.log(
    `[frame-verify] ${result.missed} missed frames: ${result.harmless} identical (harmless),` +
    ` ${result.ambiguous} changed (needs review), ${result.unknown} undetermined` +
    ` | picture changes ${result.fileChanges}/${transitions} transitions (${rate.toFixed(0)}%)`
  )
}
