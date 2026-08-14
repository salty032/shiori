import { describe, expect, it } from 'vitest'
import { matchFrames, offsetVerdict, summarizeReportDelay, type SourceFrame } from './frame-feed'

// 素材のコマ（23.976fps = 41.7083ms 間隔）と、画面キャプチャ（60Hz = 16.667ms 間隔）を
// 合成して、対応付けが 1 対 1 に収まるかを検証する。実機を回さずに固められる部分。
const SRC_PERIOD = 1000 / 23.976
const CAP_PERIOD = 1000 / 60
const T0 = 1_700_000_000_000

function makeSource(count: number, startMs = T0): SourceFrame[] {
  return Array.from({ length: count }, (_, i) => ({
    mediaTime: i * (SRC_PERIOD / 1000),
    displayAt: startMs + i * SRC_PERIOD,
    receivedAt: startMs + i * SRC_PERIOD
  }))
}

// キャプチャ経路の一定遅延 lagMs を挟んだ撮影時刻列。素材より広い範囲を覆う。
function makeDrawn(count: number, lagMs: number, startMs = T0 - 100): number[] {
  return Array.from({ length: count }, (_, i) => startMs + lagMs + i * CAP_PERIOD)
}

// 撮影時刻に現実的なばらつきを乗せる。実測では captureTime のばらつきが
// -4.1〜5.3ms だったので ±4ms 程度を再現する。テストを不安定にしないよう
// 乱数は使わず決定的な数列で作る。
function makeDrawnJittered(count: number, lagMs: number, amplitudeMs = 4): number[] {
  let seed = 12345
  return Array.from({ length: count }, (_, i) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const jitter = ((seed / 0x7fffffff) * 2 - 1) * amplitudeMs
    return T0 - 100 + lagMs + i * CAP_PERIOD + jitter
  })
}

// 実機の供給に近い、歪んだ間隔の撮影時刻列。実測は p50 17.8ms・max 36〜42ms で、
// ときどき素材のコマより長く空く。**この不規則な空きがスコアにピークを立てる**ので、
// 均一な供給（makeDrawn）では確かめられない性質はこちらで見る。
// テストを不安定にしないよう乱数は使わず決定的な数列で作る。
function makeDrawnUneven(count: number, lagMs: number, longGapRate = 0.15, seed0 = 24680): number[] {
  let seed = seed0
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  let t = T0 - 100 + lagMs
  return Array.from({ length: count }, () => {
    const long = next() < longGapRate
    t += long ? SRC_PERIOD + next() * 8 : 15 + next() * 5
    return t
  })
}

describe('matchFrames（素材のコマと撮影フレームの対応付け）', () => {
  it('素材の全コマに別々の撮影フレームを割り当てる', () => {
    const result = matchFrames(makeSource(120), makeDrawn(400, 0))
    expect(result).not.toBeNull()
    expect(result!.matches).toHaveLength(120)
    expect(result!.capturedRatio).toBe(1)
  })

  it('割り当てたフレーム番号は単調増加する（コマ送りが後戻りしない）', () => {
    const { matches } = matchFrames(makeSource(120), makeDrawn(400, 0))!
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i].frameIndex).toBeGreaterThan(matches[i - 1].frameIndex)
    }
  })

  it('キャプチャ経路に一定の遅延があっても 1 対 1 を保つ', () => {
    // 遅延そのものは全コマが等しくずれるだけなので、コマ打ちの数え方を壊さない。
    for (const lag of [-40, -15, 0, 15, 40, 80]) {
      const result = matchFrames(makeSource(120), makeDrawn(400, lag))
      expect(result!.capturedRatio, `lag=${lag}ms`).toBe(1)
    }
  })

  it('探索の窓は幅ちょうど素材 1 コマ（複製が 2 つ入らない）', () => {
    // **ここが 1 コマより広いと、同じ位相の複製が複数入り、どれを引くかが端の数コマの差
    // ＝雑音で決まる。** 実測で録画ごとに 1 コマ以上振れていた原因そのもの。
    const result = matchFrames(makeSource(120), makeDrawn(400, 0))!
    const [lo, hi] = result.searchRangeMs
    expect(hi - lo + 1).toBe(Math.round(result.sourcePeriodMs))
  })

  it('真の遅延が窓の外でも、オフセットは窓の中に収まる（コマ単位は定数が決める）', () => {
    // 遅延が窓の外なら、探索が引くのは 1 コマぶん離れた複製。**それでよい** — 何コマぶん
    // ずれるかは実測した定数（CAPTURE_LATENCY_MS）が決め、探索は 1 コマ内の位相だけを決める。
    // 探索に決めさせると、決められないものを決めさせることになる（docs/ANIME-FRAMES.md 2章）。
    for (const lag of [-40, 0, 60, 80]) {
      const result = matchFrames(makeSource(120), makeDrawn(400, lag))!
      const [lo, hi] = result.searchRangeMs
      expect(result.offsetMs, `lag=${lag}ms`).toBeGreaterThanOrEqual(lo)
      expect(result.offsetMs, `lag=${lag}ms`).toBeLessThanOrEqual(hi)
      // 複製を引いても 1 対 1 の対応そのものは崩れない
      expect(result.capturedRatio, `lag=${lag}ms`).toBe(1)
    }
  })

  it('素材の mediaTime をそのまま引き継ぐ（動画時刻の表示に使う）', () => {
    const source = makeSource(30)
    const { matches } = matchFrames(source, makeDrawn(200, 10))!
    matches.forEach((m, i) => expect(m.mediaTime).toBeCloseTo(source[i].mediaTime, 9))
  })

  it('撮影時刻がばらついても 24fps 素材なら 1 対 1 を保つ', () => {
    // 素材のコマ間隔 41.7ms に対し撮影は 16.7ms 間隔。±4ms のばらつきが乗っても
    // 隣の素材コマと同じ撮影フレームを掴むには足りず、余裕が残る。
    const result = matchFrames(makeSource(120), makeDrawnJittered(400, 10))!
    expect(result.capturedRatio).toBe(1)
  })

  it('十分な供給があれば全コマが「撮れた」と判定される', () => {
    const result = matchFrames(makeSource(120), makeDrawn(400, 0))!
    expect(result.capturedRatio).toBe(1)
    expect(result.matches.every((m) => m.captured)).toBe(true)
  })

  it('供給が足りないコマを「撮れていない」と印を付ける', () => {
    // 撮影 30Hz に対し素材 60fps。素材2コマにつき撮影1枚しかないので、約半分のコマは
    // 自分の表示区間内に絵が無く、直前のコマを流用することになる。原理的に避けられない
    // ので、重要なのは黙って壊れず割合として報告することと、どのコマかが分かること。
    const source = Array.from({ length: 120 }, (_, i) => ({
      mediaTime: i / 60,
      displayAt: T0 + i * (1000 / 60),
      receivedAt: T0 + i * (1000 / 60)
    }))
    const drawnAt30Hz = Array.from({ length: 200 }, (_, i) => T0 - 100 + i * (1000 / 30))
    const result = matchFrames(source, drawnAt30Hz)!
    expect(result.capturedRatio).toBeLessThan(0.6)
    expect(result.capturedRatio).toBeGreaterThan(0.4)
    // 流用したコマは、直前のコマと同じフレーム番号を指しているはず
    result.matches.forEach((m, i) => {
      if (!m.captured && i > 0) expect(m.frameIndex).toBe(result.matches[i - 1].frameIndex)
    })
  })

  it('「撮れた」コマは必ず直前とは別のフレームを指す', () => {
    // captured の定義そのものの整合性。ここが破れると、同じ絵しか無いのに
    // 「専用の絵がある」と report してしまい、フラグの意味が失われる。
    for (const lag of [-20, 0, 20, 50]) {
      const { matches } = matchFrames(makeSource(120), makeDrawnJittered(400, lag))!
      matches.forEach((m, i) => {
        if (m.captured && i > 0) {
          expect(m.frameIndex, `lag=${lag}ms i=${i}`).not.toBe(matches[i - 1].frameIndex)
        }
      })
    }
  })

  it('入力が空なら null を返す', () => {
    expect(matchFrames([], makeDrawn(100, 0))).toBeNull()
    expect(matchFrames(makeSource(10), [])).toBeNull()
  })

  it('素材のコマ周期を返す（ずれが何コマ分に当たるかの換算に使う）', () => {
    const result = matchFrames(makeSource(120), makeDrawn(400, 0))!
    expect(result.sourcePeriodMs).toBeCloseTo(1000 / 23.976, 1)
  })

  it('供給が完全に均一で位相が決まらなくても、採るのは同点の中央（端ではない）', () => {
    // 供給が**完全に均一**だと、オフセットをどこへ振っても隣接コマは別のフレームを指すため
    // 窓の全域が満点になる。以前はここで「最初に当たった値」＝窓の左端を採っていたので、
    // 飽和した録画ほど位相が systematically 片側へ寄っていた。
    //
    // **飽和は録画ごとの供給分布で決まる**（実測で幅 2〜6ms の録画と 200ms の録画の両方が出た）。
    // 「実機では起きない」と書いていた時期があるが外れている。docs/ANIME-FRAMES.md 4章。
    const result = matchFrames(makeSource(120), makeDrawn(400, 0))!
    expect(result.capturedRatio).toBe(1)
    // 窓の全域が同点になる
    expect(result.tiedOffsets).toBe(Math.round(result.sourcePeriodMs))
    // 採るのはその中央。窓は実測した遅延を中心にしてあるので、中央＝実測値そのもの
    const [lo, hi] = result.searchRangeMs
    expect(result.offsetMs).toBeGreaterThan(lo)
    expect(result.offsetMs).toBeLessThan(hi)
    expect(Math.abs(result.offsetMs - (lo + hi) / 2)).toBeLessThanOrEqual(1)
  })


  it('素材コマ 1 つぶんずらした位置のスコアを持ち帰る', () => {
    // 複製の位置（best ± n×素材コマ）の近傍で最良だった点を返す。ここを見ないと
    // 「何コマぶんずれているか」の判定材料が無い。
    const result = matchFrames(makeSource(240), makeDrawnUneven(700, 0))!
    expect(result.replicas.map((r) => r.shift)).toEqual([-2, -1, 1, 2])
    for (const r of result.replicas) {
      const center = result.offsetMs + r.shift * result.sourcePeriodMs
      expect(Math.abs(r.offsetMs - center), `shift=${r.shift}`).toBeLessThanOrEqual(3)
    }
  })

  it('素材コマ 1 つずらしてもスコアはほとんど変わらない（探索はコマ単位のずれに盲目）', () => {
    // **この探索が構造的に持っている限界そのもの。** オフセットに素材の周期 P を足すと、
    // 比較対象の時刻集合 {displayAt_k + offset + P} は {displayAt_{k+1} + offset} とほぼ一致し、
    // captured の列が添字 1 つぶん平行移動するだけになる。つまりスコアが変わるのは端の数コマだけ。
    // 一方でフレーム表の中身は素材コマ 1 つぶん丸ごとずれる。
    //
    // 供給を不均一にして（＝スコアにピークが立つ条件で）も成立することを固定する。
    // tiedOffsets が狭くても「決まっている」ことにはならない、の根拠。docs/ANIME-FRAMES.md 2章。
    const result = matchFrames(makeSource(240), makeDrawnUneven(700, 0))!
    // 240 コマ中、1 コマずらしても数コマしか変わらない
    for (const r of result.replicas) {
      expect(r.scoreDelta, `shift=${r.shift}`).toBeLessThanOrEqual(result.sourceFrames * 0.02)
    }
  })

  it('撮影が先に尽きたら、その先のコマは表に入れない（撮り逃しとして数えない）', () => {
    // 録画停止の前後で、素材のコマ通知だけが届き続ける状況。コマ通知の受け口は録画停止の
    // 処理が終わるまで生きているため、必ず起きる。
    //
    // これらは撮り逃したのではなく最初から録画の外なので、表からも枚数からも外す。
    // 残すと「撮り逃し」が録画停止後の長さに比例して水増しされ、詳細パネルの
    // 「N コマ要確認」が実態とかけ離れる。
    const result = matchFrames(makeSource(120), makeDrawn(20, 0))!
    expect(result.matches.length).toBeLessThan(30)
    expect(result.outsideRecording).toBeGreaterThan(80)
    // 残ったコマのフレーム番号は範囲内に収まり、後戻りしない
    result.matches.forEach((m, i) => {
      expect(m.frameIndex).toBeLessThan(20)
      expect(m.frameIndex).toBeGreaterThanOrEqual(0)
      if (i > 0) expect(m.frameIndex).toBeGreaterThanOrEqual(result.matches[i - 1].frameIndex)
    })
  })

  it('録画が始まる前に表示し終えたコマも表に入れない', () => {
    // 受け口は録画開始より前に立ち上げる（最初の数コマを取りこぼさないため）。
    // その間のコマは録画されていないので、撮り逃しではなく範囲外として外す。
    const source = makeSource(60)
    // 撮影は素材の 20 コマ目あたりから始まったことにする
    const drawn = makeDrawn(200, 0).map((t) => t + 20 * (1000 / 24))
    const result = matchFrames(source, drawn)!
    expect(result.outsideRecording).toBeGreaterThan(10)
    expect(result.matches.length).toBeLessThan(50)
  })

  it('同じコマの重複通知を畳む（撮り逃しに数えない）', () => {
    // ページ側の rVFC は同じフレームの再提示でもう一度発火しうる。畳まないと 2 つ目が
    // 必ず「専用の絵が無い」と判定され、撮り逃しの数を水増しする。
    const source = makeSource(40)
    const withDuplicates = source.flatMap((f, i) =>
      // 5 コマにつき 1 回、同じ mediaTime の通知が 8ms 後にもう一度届いたことにする
      i % 5 === 0 ? [f, { ...f, displayAt: f.displayAt + 8 }] : [f]
    )
    const plain = matchFrames(source, makeDrawn(400, 0))!
    const duped = matchFrames(withDuplicates, makeDrawn(400, 0))!
    expect(duped.duplicateReports).toBe(8)
    // 畳んだ結果、重複が無かった場合と同じ表になる
    expect(duped.matches).toEqual(plain.matches)
    expect(duped.capturedRatio).toBe(plain.capturedRatio)
  })
})

describe('offsetVerdict（オフセットの疑わしい点）', () => {
  // 規則をここ 1 か所に集めるための関数。分かれていた頃は、同じ 1 件の問題について
  // 4 行のログが出ていた。**表の採否は決めない**（窓が 1 コマ幅なのでずれは 1 コマ未満）。
  const base = matchFrames(makeSource(240), makeDrawnUneven(700, 0))!

  it('窓の中で位相が決まらないだけなら何も言わない', () => {
    // 窓が 1 コマ幅なので位相のずれはコマ内に収まり、指すコマは変わらない。しかも同点が
    // 広がるのは供給が均一で撮り逃しの少ない録画＝**最も出来の良い録画ほど毎回警告が出る**
    // ことになる（飽和したら表を捨てていた頃と同じ罠）。数字は実測の行に出してある。
    const mid = Math.round((base.searchRangeMs[0] + base.searchRangeMs[1]) / 2)
    const loose = { ...base, offsetMs: mid, tiedOffsets: 30, tiedRangeMs: [5, 35] as [number, number] }
    expect(offsetVerdict(loose)).toEqual([])
  })

  it('同点範囲が片側の端だけに接していたら知らせる（山が窓で切られている疑い）', () => {
    // 実測（2026-08-10）: 採用 7ms・同点 -1..14ms で左端に接していた。採用値は同点の中央
    // なので端には来ず、採用値だけを見る判定では見えない。
    const [lo] = base.searchRangeMs
    const clipped = { ...base, offsetMs: 7, tiedOffsets: 16, tiedRangeMs: [lo, 14] as [number, number] }
    expect(offsetVerdict(clipped).join(' ')).toContain('touches one edge')
  })

  it('窓の全域が同点なら端に接していても何も言わない（飽和はコマ内に収まる）', () => {
    const [lo, hi] = base.searchRangeMs
    const saturated = {
      ...base,
      offsetMs: Math.round((lo + hi) / 2),
      tiedOffsets: hi - lo + 1,
      tiedRangeMs: [lo, hi] as [number, number]
    }
    expect(offsetVerdict(saturated)).toEqual([])
  })

  it('採用値が窓の端に寄ったら知らせる（遅延の定数が外れている兆候）', () => {
    // 窓の外は隣のコマなので、これは「1 コマずれているかもしれない」という意味。
    const [lo] = base.searchRangeMs
    const pinned = { ...base, tiedOffsets: 1, tiedRangeMs: [lo, lo] as [number, number], offsetMs: lo }
    expect(offsetVerdict(pinned).join(' ')).toContain('capture latency constant may be off')
  })

  it('問題が無ければ何も挙げない', () => {
    const mid = Math.round((base.searchRangeMs[0] + base.searchRangeMs[1]) / 2)
    const clean = { ...base, tiedOffsets: 1, tiedRangeMs: [mid, mid] as [number, number], offsetMs: mid }
    expect(offsetVerdict(clean)).toEqual([])
  })

  // 撮り逃しが 0 ＝供給が足りて位相を測れていない録画。ここで端に寄るのは測定結果ではなく
  // 揺らぎで、実測でも 30fps 素材 3 本の採用値が右端・中央・左端と跳ね回った。
  // **黙らせないと、最も出来の良い録画でだけ警告が鳴り続ける。**
  it('全コマ撮れている録画では、端に寄っていても何も言わない（位相を測れていない）', () => {
    const [lo] = base.searchRangeMs
    const full = { ...base, capturedRatio: 1 }
    const pinned = { ...full, tiedOffsets: 1, tiedRangeMs: [lo, lo] as [number, number], offsetMs: lo }
    const clipped = { ...full, offsetMs: 7, tiedOffsets: 16, tiedRangeMs: [lo, 14] as [number, number] }
    expect(offsetVerdict(pinned)).toEqual([])
    expect(offsetVerdict(clipped)).toEqual([])
  })

  it('撮り逃しが 1 コマでもあれば従来どおり知らせる（そこは実際に測れている）', () => {
    const [lo] = base.searchRangeMs
    const partial = { ...base, capturedRatio: 0.99 }
    expect(offsetVerdict({ ...partial, tiedOffsets: 1, tiedRangeMs: [lo, lo] as [number, number], offsetMs: lo }))
      .not.toEqual([])
  })
})

describe('summarizeReportDelay（コマ通知が届くまでの遅れ）', () => {
  it('receivedAt - displayAt の最小値と中央値を出す', () => {
    // 最小値が「転送の遅れ 0」に一番近い標本。ページ側の時計がずれていれば、そのぶん
    // 全標本が平行移動するので最小値に出る（logClockDiag の読み方を参照）。
    const source = makeSource(21).map((f, i) => ({ ...f, receivedAt: f.displayAt + 5 + i }))
    const delay = summarizeReportDelay(source)!
    expect(delay.count).toBe(21)
    expect(delay.minMs).toBe(5)
    expect(delay.medianMs).toBe(15)
  })

  it('負の遅れもそのまま出す（時計のずれの証拠なので丸めない）', () => {
    const source = makeSource(3).map((f) => ({ ...f, receivedAt: f.displayAt - 40 }))
    expect(summarizeReportDelay(source)!.minMs).toBe(-40)
  })

  it('同じコマの重複通知は畳んでから数える（matchFrames と同じ母数にする）', () => {
    const source = makeSource(10)
    const withDuplicates = source.flatMap((f, i) => (i % 5 === 0 ? [f, { ...f }] : [f]))
    expect(summarizeReportDelay(withDuplicates)!.count).toBe(10)
  })

  it('通知が 1 件も無ければ要約しない', () => {
    expect(summarizeReportDelay([])).toBeNull()
  })
})

// 通知そのものが来なかったコマ（MatchResult.reportDrops）。
//
// **撮り逃し（captured=false）とは別物で、こちらの方が悪い。** 撮り逃しは表に残って
// 割合の分母にも入るが、通知が来なかったコマは表に無いのでどの数字にも現れない。
// 実測（2026-08-12・60fps 素材）では captured 89.3% と出ている裏で、素材の約 2 割が
// 表に存在しなかった。黙って通さないための数なので、算出をここで固定する。
describe('matchFrames（通知が来なかったコマの検出）', () => {
  it('通知が全部揃っていれば 0', () => {
    const result = matchFrames(makeSource(40), makeDrawn(200, 20))
    expect(result!.reportDrops).toBe(0)
  })

  it('コマ周期の格子に空いた穴を数える（撮り逃しとは別に数える）', () => {
    // 40 コマぶんの格子から 5 コマぶんの通知だけを落とす。displayAt/mediaTime は
    // 残ったコマの分だけ飛ぶので、周期の当てはめから穴が見える。
    const full = makeSource(40)
    const withHoles = full.filter((_, i) => i < 20 || i >= 25)
    const result = matchFrames(withHoles, makeDrawn(200, 20))
    expect(result!.reportDrops).toBe(5)
    // 穴は「撮り逃し」ではない。残ったコマ自体には絵が付いている。
    expect(result!.capturedRatio).toBeGreaterThan(0.9)
  })

  it('穴があっても素材の周期は正しく出る（穴を短い周期と読まない）', () => {
    const full = makeSource(40)
    const withHoles = full.filter((_, i) => i % 7 !== 3)
    const result = matchFrames(withHoles, makeDrawn(200, 20))
    expect(result!.sourcePeriodMs).toBeCloseTo(SRC_PERIOD, 1)
    expect(result!.reportDrops).toBeGreaterThan(0)
  })
})
