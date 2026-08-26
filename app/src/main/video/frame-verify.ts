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
import type { FrameVerify, StoredFrame } from '../db-video-frames'

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

/**
 * 供給した時刻列（drawnAt）とファイル内フレームの表示時刻（pts）を突き合わせ、
 * **対応が崩れる最初の位置**を返す。崩れなければ min(drawnAt.length, pts.length) を返す。
 *
 * フレーム表の `frameIndex` は「requestFrame を呼んだ回数」の添字なので、ファイル内の
 * フレームと 1 対 1 で対応していることが前提になっている。実測では MediaRecorder が
 * 1〜2 枚少ないファイルを吐くことがあり（停止時に未エンコードのフレームが残るとみられる）、
 * その場合に**どこで対応が切れたのか**を知る必要がある。
 *
 * - 末尾だけ足りない → そこまでの対応は正しいので、表の末尾を切れば残りは使える
 * - 途中で切れている → それ以降の frameIndex は全てずれている
 *
 * この 2 つは枚数の差だけでは区別できない。「1〜2 枚だから末尾だろう」と決めつけるのは
 * この機能が避けるべき推測そのものなので、時刻で判定する。両者は原点の違う時計だが、
 * 先頭からの相対時刻にすれば原点は消え、同じ実時間のレートで進む。1 枚落ちるとその位置から
 * 先は供給 1 回ぶん（実測 17.8ms）ずれるので、供給間隔より十分小さい許容幅で検出できる。
 *
 * **判定するのはずれの絶対値ではなく、前後の水準の「段差」。** 1 枚落ちればそこから先は
 * 供給 1 回ぶんずれたままになるので、段差として必ず現れる。逆に、原点がずれているだけなら
 * 全域が同じだけ平行移動するので段差は出ない。実測で踏んだ誤検出は 2 つともこの形だった：
 *
 * - 先頭 2 枚が -7.5 / -15.0ms 外れて 3 枚目で戻る（一過性の揺らぎ）
 * - 先頭フレームの時刻がずれ、全域が +8〜10ms 平行移動したまま最後まで続く
 *   （`captureTime` が載らなかった 1 枚が原点に来た形。許容幅ちょうどの水準なので、
 *   揺らぎで何度か超えた場所が「崩れ」に見えていた）
 *
 * どちらも対応は最後まで成立しているのに、絶対値で見ていた頃は**取れている表を捨てていた**。
 * 水準の比較には中央値を使う（数枚の外れ値では動かない）。
 *
 * @param toleranceMs 省略時は供給間隔の中央値の半分（最低 5ms）。requestFrame の呼び出し時刻と
 *   captureTime は処理時間ぶん揺らぐため、その揺らぎより大きく、供給 1 回ぶんより小さく取る。
 */
export function findFrameDivergence(drawnAt: number[], pts: number[], toleranceMs?: number): number {
  const n = Math.min(drawnAt.length, pts.length)
  if (n < 2) return n

  // 段差とみなす下限は供給 1 回ぶんの 0.6。1 枚落ちたときの段差はちょうど 1.0 なので
  // 十分な余裕があり、実測で踏んだ原点ずれ（供給 1 回ぶんの 0.45＝約 9ms）とは重ならない。
  // 半分（0.5）だとその原点ずれと紙一重で、揺らぎ次第で誤検出になる。
  const tolerance = toleranceMs ?? Math.max(5, medianGapMs(drawnAt) * 0.6)
  const shift: number[] = []
  for (let i = 0; i < n; i++) shift.push(drawnAt[i] - drawnAt[0] - (pts[i] - pts[0]) * 1000)

  for (let i = 1; i < n; i++) {
    // 手前が窓に満たない位置（先頭 LEVEL_WINDOW 枚）では中央値を使わず 0 と比べる。
    // **shift[0] は定義上つねに 0**（先頭を原点にした差なので）で、頭の水準は推定するまでも
    // なく分かっている。数枚しか無いところで中央値を取ると、一過性の外れが 2 枚あるだけで
    // 中央値が外れ値そのものになり、正常へ戻った位置を段差と読む。
    // 実測（2026-08-26・23.976fps / 供給 19.1ms）: shift が 0.0 / -9.6 / -13.1 と外れて
    // 4 枚目で +0.1 へ戻り、末尾まで対応が成立していた録画で、手前 3 枚の中央値 -9.6 と
    // その先の +2.9 の差 12.5ms が許容 11.5ms を 1ms 超え、231 コマ・撮り逃し 0 の表を
    // 捨てていた（image 246）。ここを 0 と比べれば差は 2.9ms で通る。
    // **窓に満たないからといって判定自体を止めてはいけない。** 止めると先頭で本当に落ちた
    // ときに水準の変化が窓へ収まりきり、対応が 1 コマずれた表を黙って使うことになる。
    const before = i < LEVEL_WINDOW ? 0 : median(shift.slice(i - LEVEL_WINDOW, i))
    const after = median(shift.slice(i, Math.min(n, i + LEVEL_WINDOW)))
    if (Math.abs(after - before) <= tolerance) continue
    // 窓の中央値で見ているので、段差を検出した位置は実際の欠落より数枚手前になりうる
    // （後ろ側の窓に欠落が入った時点で中央値が動くため）。**返す位置がずれると、そこまでを
    // 使う末尾切り詰めが誤った枚数を残す**ので、水準が実際に変わった最初の位置まで進める。
    let j = i
    while (j < n - 1 && Math.abs(shift[j] - before) <= tolerance) j++
    return j
  }
  return n
}

// 水準を測る窓の枚数。中央値なので外れ値 2 枚までは無害で、かつ末尾近くで落ちた場合にも
// 判定が残る程度に短く取る。
const LEVEL_WINDOW = 5

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

// 供給間隔の中央値。時刻が逆行した標本は捨てる（capture-diag.ts の summarizeSupply と同じ理由）。
function medianGapMs(drawnAt: number[]): number {
  const gaps: number[] = []
  for (let i = 1; i < drawnAt.length; i++) {
    const gap = drawnAt[i] - drawnAt[i - 1]
    if (gap >= 0) gaps.push(gap)
  }
  if (gaps.length === 0) return 0
  gaps.sort((a, b) => a - b)
  return gaps[gaps.length >> 1]
}

interface VerifyResult {
  /** 検証結果を書き込んだフレーム表（入力と同じ長さ・同じ順序） */
  frames: StoredFrame[]
  /** 専用の絵が無かったコマの総数（従来の uncaptured_frames と同じ意味） */
  missed: number
  /**
   * 画面に「要確認」として出す枚数（`images.ambiguous_frames`）＝ `changed + unknown`。
   *
   * **判定できなかったコマ（unknown）もここに含める**（2026-08-13）。しきい値を意図的に
   * 非対称にしているのと同じ理由で、「要確認」と言い過ぎても失うのは手間だけだが、
   * 「実害なし」と言い間違えると誤ったコマ打ちを正解として提示することになる。
   * 含めなかった頃は、10 コマ撮り逃して 3 identical / 6 changed / 1 undetermined のとき
   * 画面が「6コマ要確認」になり、**判定できなかった 1 コマがどの数字にも出ていなかった**
   * （パネルだけ見ると 4 コマが問題なしに見える）。
   * changed と unknown の区別が要るときはビューアで当該コマへ行けば「要確認」と
   * 「流用（未検証）」で見分けられるので、パネル側は 1 つの意味に寄せる。
   */
  ambiguous: number
  /** そのうち「絵が変わっていて、どのコマで変わったか特定できない」コマ数 */
  changed: number
  /** そのうち「絵が変わっておらず実害なし」と確定したコマ数 */
  harmless: number
  /** 署名が足りない・比較相手が無い等で判定できなかったコマ数（ambiguous に含まれる） */
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
  let changed = 0
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
    if (verdict === 'changed') changed++
    else if (verdict === 'same') harmless++
    else unknown++
  }

  let fileChanges = 0
  for (let j = 1; j < signatures.length; j++) {
    if (signaturesDiffer(signatures[j - 1], signatures[j])) fileChanges++
  }

  // 「実害なしと確定できなかった」枚数を画面へ出す（ambiguous の項参照）。
  return { frames, missed, ambiguous: changed + unknown, changed, harmless, unknown, fileFrames: signatures.length, fileChanges }
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
//
// **image id を必ず添える。** この行は保存の数秒後に非同期で出るため、次の録画の
// 実測ログ（clip #N の塊）の中に割り込む。id が無いとどのクリップの話か読めない。
export function logVerifyResult(imageId: number, result: VerifyResult | null): void {
  if (!result) {
    console.log(`[frame-verify] image ${imageId}: skipped (no frame table or signatures)`)
    return
  }
  // 末尾の picture changes は判定の感度そのものを見るための数字（VerifyResult 参照）。
  // ここが極端に小さいときは「静止していた」のではなく「変化を見落としている」を疑う。
  const transitions = Math.max(0, result.fileFrames - 1)
  const rate = transitions > 0 ? (result.fileChanges / transitions) * 100 : 0
  console.log(
    `[frame-verify] image ${imageId}: ${result.missed} missed frames: ${result.harmless} identical (harmless),` +
    // 末尾の flagged が画面の「Nコマ要確認」と一致する数字。内訳と並べて出さないと、
    // パネルの数が内訳のどれとも合わず「どこかが抜けている」ように見える。
    ` ${result.changed} changed (needs review), ${result.unknown} undetermined → ${result.ambiguous} flagged` +
    ` | picture changes ${result.fileChanges}/${transitions} transitions (${rate.toFixed(0)}%)`
  )
}
