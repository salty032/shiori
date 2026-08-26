import { describe, expect, it, vi } from 'vitest'

// db.ts は electron の app.getPath を import 時点で読むため、型のみの参照でもモックが要る。
vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/userData') } }))

import { checkTableAgainstFile, findFrameDivergence, signaturesDiffer, verifyFrameTable } from './frame-verify'
import type { StoredFrame } from '../db-video-frames'

const GRID = 32 * 32

// 一様な明るさの署名。値を変えれば「別の絵」になる。
function flat(value: number): Uint8Array {
  return new Uint8Array(GRID).fill(value)
}

// base のうち先頭 cells 個だけを delta ぶん動かした署名（部分的な変化の再現）。
function withMovedCells(base: Uint8Array, cells: number, delta: number): Uint8Array {
  const out = new Uint8Array(base)
  for (let i = 0; i < cells; i++) out[i] = Math.min(255, out[i] + delta)
  return out
}

function frame(mediaTime: number, frameIndex: number, captured: boolean): StoredFrame {
  return { mediaTime, frameIndex, captured }
}

describe('signaturesDiffer（絵が変わったかの判定）', () => {
  it('同じ署名は変化なし', () => {
    expect(signaturesDiffer(flat(100), flat(100))).toBe(false)
  })

  it('全面が動けば変化あり', () => {
    expect(signaturesDiffer(flat(100), flat(140))).toBe(true)
  })

  it('動いたセルが1つだけならノイズとして無視する', () => {
    expect(signaturesDiffer(flat(100), withMovedCells(flat(100), 1, 40))).toBe(false)
  })

  it('小さな領域でも3セル動けば変化と見なす（口パク相当を落とさない）', () => {
    expect(signaturesDiffer(flat(100), withMovedCells(flat(100), 3, 20))).toBe(true)
  })

  it('しきい値未満のわずかな揺れ（エンコードのノイズ）は変化としない', () => {
    expect(signaturesDiffer(flat(100), withMovedCells(flat(100), GRID, 4))).toBe(false)
  })
})

describe('verifyFrameTable（撮り逃したコマの分類）', () => {
  // 素材4コマ。2コマ目に専用の絵が無く、1コマ目の絵(フレーム0)を流用している。
  const table = [
    frame(0.000, 0, true),
    frame(0.042, 0, false),
    frame(0.083, 1, true),
    frame(0.125, 2, true)
  ]

  it('前後で絵が変わっていなければ実害なし（same）と確定する', () => {
    const sigs = [flat(100), flat(100), flat(160)]
    const result = verifyFrameTable(table, sigs)
    expect(result.frames[1].verified).toBe('same')
    expect(result).toMatchObject({ missed: 1, harmless: 1, ambiguous: 0, unknown: 0 })
  })

  // 「実害なし」に全部落ちたとき、それが本当に静止区間だったのか検出器が鈍いだけなのかを
  // 外から確かめるための数字。判定と同じしきい値で数えていることを固定する。
  it('ファイル全体の絵の変化回数を併せて数える（判定の感度を外から確かめるため）', () => {
    // フレーム 0→1 は同じ、1→2 で変化 → 3フレーム中 1 回の変化
    const result = verifyFrameTable(table, [flat(100), flat(100), flat(160)])
    expect(result.fileFrames).toBe(3)
    expect(result.fileChanges).toBe(1)
  })

  it('前後で絵が変わっていれば要確認（changed）として残す', () => {
    const sigs = [flat(100), flat(160), flat(200)]
    const result = verifyFrameTable(table, sigs)
    expect(result.frames[1].verified).toBe('changed')
    expect(result).toMatchObject({ missed: 1, harmless: 0, ambiguous: 1, unknown: 0 })
  })

  it('連続して撮り逃した区間は、間のどこかに変化があれば要確認になる', () => {
    const consecutive = [
      frame(0.000, 0, true),
      frame(0.042, 0, false),
      frame(0.083, 0, false),
      frame(0.125, 3, true)
    ]
    // フレーム0→1 は同じ絵、1→2 で変化、2→3 は同じ絵。間に変化があるので要確認。
    const sigs = [flat(100), flat(100), flat(180), flat(180)]
    const result = verifyFrameTable(consecutive, sigs)
    expect(result.frames[1].verified).toBe('changed')
    expect(result.frames[2].verified).toBe('changed')
    expect(result.ambiguous).toBe(2)
  })

  // 判定できなかったコマは「実害なし」側に落とさず、画面の「要確認」に数える
  // （ambiguous = changed + unknown）。落とすと、パネルだけ見たときに未検証のコマが
  // 問題なしとして消える。しきい値を非対称にしているのと同じ理由。
  it('末尾を撮り逃した場合は比較相手が無いので判定しない（undetermined）が、要確認には数える', () => {
    const tail = [frame(0, 0, true), frame(0.042, 0, false)]
    const result = verifyFrameTable(tail, [flat(100)])
    expect(result.frames[1].verified).toBe('unknown')
    expect(result).toMatchObject({ missed: 1, unknown: 1, changed: 0, harmless: 0, ambiguous: 1 })
  })

  it('署名が足りない（デコード失敗・フレーム数不一致）コマは判定しない', () => {
    const result = verifyFrameTable(table, [flat(100)])
    expect(result.frames[1].verified).toBe('unknown')
    expect(result.unknown).toBe(1)
  })

  it('撮れているコマには検証結果を付けない', () => {
    const result = verifyFrameTable(table, [flat(100), flat(100), flat(160)])
    expect(result.frames[0].verified).toBe('unknown')
    expect(result.frames[2].verified).toBe('unknown')
  })

  it('入力の表を書き換えない（元の配列は不変）', () => {
    const original = table.map((f) => ({ ...f }))
    verifyFrameTable(table, [flat(100), flat(100), flat(160)])
    expect(table).toEqual(original)
  })
})

describe('findFrameDivergence（供給時刻とファイル内 PTS の対応が崩れる位置）', () => {
  // 実測に近い供給間隔（p50 17.8ms）。決定的な擬似ジッタを乗せる。
  const GAP_MS = 17.8
  const T0 = 1_700_000_000_000

  function makeDrawn(count: number, jitterMs = 0, gapMs = GAP_MS): number[] {
    let seed = 4242
    return Array.from({ length: count }, (_, i) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const jitter = jitterMs === 0 ? 0 : ((seed / 0x7fffffff) * 2 - 1) * jitterMs
      return T0 + i * gapMs + jitter
    })
  }

  // 供給時刻から、ファイル内フレームの表示時刻（秒・原点は別）を作る。
  // 原点をずらすのは実物と同じ条件にするため（先頭からの相対で比較すれば消える）。
  function ptsFrom(drawnAt: number[]): number[] {
    return drawnAt.map((t) => (t - drawnAt[0]) / 1000 + 12.345)
  }

  it('全フレームが対応していれば崩れない', () => {
    const drawn = makeDrawn(200, 2)
    expect(findFrameDivergence(drawn, ptsFrom(drawn))).toBe(200)
  })

  it('末尾が足りないだけなら、短い方の長さまで崩れない', () => {
    // MediaRecorder の停止時に未エンコードのフレームが残るケース（実測 -1〜-2 枚）。
    const drawn = makeDrawn(200, 2)
    const pts = ptsFrom(drawn).slice(0, 198)
    expect(findFrameDivergence(drawn, pts)).toBe(198)
  })

  it('途中で 1 枚落ちたら、その位置を返す', () => {
    // 落ちた位置から先は供給 1 回ぶんずれるので、そこで検出できる。
    // 末尾欠落（表を切って使える）と途中欠落（捨てるしかない）を分ける判定そのもの。
    for (const dropAt of [1, 120]) {
      const drawn = makeDrawn(200, 2)
      const pts = ptsFrom(drawn)
      pts.splice(dropAt, 1)
      expect(findFrameDivergence(drawn, pts), `dropAt=${dropAt}`).toBe(dropAt)
    }
  })

  // 2026-08-10 の再現だけでは足りなかった。あちらは許容幅まで 3ms しか余裕が無く、
  // 外れが 2 枚続いて戻り先がわずかに正側へ振れただけで超える。実機で再発したので、
  // 実測値そのものを固定する（それまでの判定は image 246 をここで捨てていた）。
  it('先頭で 2 枚続けて外れても崩れとみなさない（2026-08-26 の実測を再現）', () => {
    // 実測: 供給 19.1ms・許容 11.5ms。shift が 0.0 / -9.6 / -13.1 と外れ、4 枚目で +0.1、
    // 以降は +2.9 前後で末尾まで対応が成立していた（231 コマ・撮り逃し 0）。
    const drawn = makeDrawn(200, 0, 19.1)
    const pts = ptsFrom(drawn)
    pts[1] += 9.6 / 1000
    pts[2] += 13.1 / 1000
    for (let i = 3; i < pts.length; i++) pts[i] -= 2.9 / 1000
    expect(findFrameDivergence(drawn, pts)).toBe(200)
  })

  // 上の直しで「手前が足りないうちは判定しない」に逃げると、ここが素通りする。
  // 素通りの実害は表が捨てられないことではなく、**1 コマずれた表が黙って使われる**こと。
  it('先頭付近で本当に落ちていれば、外れと区別してその位置を返す', () => {
    for (const dropAt of [1, 2, 3, 4]) {
      const drawn = makeDrawn(200, 2)
      const pts = ptsFrom(drawn)
      pts.splice(dropAt, 1)
      expect(findFrameDivergence(drawn, pts), `dropAt=${dropAt}`).toBe(dropAt)
    }
  })

  it('先頭の一過性の外れは崩れとみなさない（2026-08-10 の実測を再現）', () => {
    // 実測: shift が 0.0 / -7.5 / -15.0 と外れた後、3 枚目で +2.2 へ戻り、末尾は +0.7 だった。
    // **対応は最後まで成立している**のに、「最初に許容幅を超えた位置」で判定していた頃は
    // ここを崩れと読み、取れている表を毎回捨てていた（コマ精度が失われる主因）。
    // 外れ幅は許容幅（8.9ms）を超え、供給 1 回ぶん（17.8ms）に迫る大きさ。
    const drawn = makeDrawn(200, 2)
    const pts = ptsFrom(drawn)
    pts[1] += 7.5 / 1000
    pts[2] += 15 / 1000
    expect(findFrameDivergence(drawn, pts)).toBe(200)
  })

  it('先頭の時刻ずれが全域に乗っていても崩れとみなさない（2026-08-10 の実測を再現）', () => {
    // 実測: 先頭フレームの captureTime が載らず Date.now() へ退避した結果、shift が全域で
    // +7〜11ms に平行移動していた（許容幅 9.9ms とほぼ同じ水準）。段差は無いので対応は
    // 成立しているのに、絶対値で見ていた頃は揺らぎで超えた位置を崩れと読んでいた。
    const drawn = makeDrawn(200, 2)
    const pts = ptsFrom(drawn).map((t, i) => (i === 0 ? t + 9 / 1000 : t))
    expect(findFrameDivergence(drawn, pts)).toBe(200)
  })

  it('末尾の直前で落ちても検出する（一過性と区別しつつ取りこぼさない）', () => {
    const drawn = makeDrawn(200, 2)
    const pts = ptsFrom(drawn)
    pts.splice(198, 1)
    expect(findFrameDivergence(drawn, pts)).toBe(198)
  })

  it('現実的なジッタでは誤検出しない（供給間隔の半分を許容幅にする）', () => {
    // requestFrame の呼び出し時刻と captureTime は処理時間ぶん揺らぐ。その揺らぎで
    // 「崩れた」と誤判定すると、正常なクリップのフレーム表まで捨ててしまう。
    for (const jitter of [0, 1, 2, 3]) {
      const drawn = makeDrawn(300, jitter)
      expect(findFrameDivergence(drawn, ptsFrom(drawn)), `jitter=${jitter}ms`).toBe(300)
    }
  })

  it('標本が 1 枚以下なら判定しない', () => {
    expect(findFrameDivergence([], [])).toBe(0)
    expect(findFrameDivergence([T0], [0])).toBe(1)
  })
})

// 印を付けた表を救えるかの判定（recheckUnusableClips が使う）。
// **録画時の判定とは別の物差し。** あちらは供給枚数とファイル枚数を添字で突き合わせるので
// ファイル側が 1 枚落ちただけで全部ダメと出るが、録画は素材 1 コマあたり 2 枚以上撮って
// いるので絵は正しい。こちらは表とファイルだけを見て、ずれが溜まっているかを判定する。
describe('checkTableAgainstFile（印を付けた表を見直す）', () => {
  const SRC = 1 / 23.976   // 素材のコマ長（秒）
  const CAP = 1 / 51       // 供給の間隔（秒）。素材 1 コマにつき 2 枚強

  // 素材 count コマぶんの表と、それが指すファイル内フレーム時刻を作る。
  function build(count: number, opts: { shiftRows?: Record<number, number>; drift?: number } = {}) {
    const pts: number[] = []
    for (let i = 0; i < count * 3; i++) pts.push(i * CAP)
    const frames = Array.from({ length: count }, (_, i) => ({
      mediaTime: i * SRC,
      frameIndex: Math.round((i * SRC) / CAP),
      captured: true
    }))
    for (const [row, by] of Object.entries(opts.shiftRows ?? {})) {
      frames[Number(row)].frameIndex += by
    }
    // 供給 1 枚ぶん（19.6ms）のずれは素材 1 コマ（41.7ms）未満で、同じ素材コマの別の 1 枚を
    // 指すだけなので絵は変わらない。**印が立つのは素材 1 コマ以上ずれたときだけ**なので、
    // 崩れの再現には 3 枚ぶん動かす。
    if (opts.drift) {
      for (let i = opts.drift; i < frames.length; i++) frames[i].frameIndex += 3
    }
    return { frames, pts }
  }

  it('ずれが無ければ、どの行にも印は立たない', () => {
    const { frames, pts } = build(120)
    const r = checkTableAgainstFile(frames, pts)
    expect(r.misaligned).toBe(0)
    expect(r.frames).toHaveLength(120)
  })

  it('ずれている行にだけ印を立て、残りはそのまま使う', () => {
    // **ここが方針転換の核心。** 以前は「ずれた行が 5% を超えたら全部捨てる」だったので、
    // 116 行が正しくても 120 行まとめて失っていた。
    const { frames, pts } = build(120, { shiftRows: { 2: 3, 3: 3, 4: 3, 5: 3 } })
    const r = checkTableAgainstFile(frames, pts)
    expect(r.misaligned).toBe(4)
    expect(r.frames).toHaveLength(120)
    expect(r.frames[2].misaligned).toBe(true)
    expect(r.frames[50].misaligned).toBeFalsy()
  })

  // 対応が本当に崩れたなら、そこから先はずっとずれ続ける。1〜2 コマだけ超えて戻るのは
  // 撮影間隔の揺らぎで、崩れではない。実測（image 264）で本物の崩れ 38 コマ連続の手前に、
  // 1 コマだけの印が 3 か所出ていた——**関係ない場所に印が散る方が読めなくなる。**
  it('1〜2 コマだけ外れて戻るところには印を立てない', () => {
    const { frames, pts } = build(120, { shiftRows: { 10: 3, 40: 3, 41: 3 } })
    expect(checkTableAgainstFile(frames, pts).misaligned).toBe(0)
  })

  it('途中から最後までずれ続けていれば、その先だけに印が立つ（手前は残る）', () => {
    const { frames, pts } = build(120, { drift: 40 })
    const r = checkTableAgainstFile(frames, pts)
    expect(r.frames[10].misaligned).toBeFalsy()
    expect(r.frames[110].misaligned).toBe(true)
    // 手前の 40 行ぶんは使えるまま残っていること。
    expect(r.frames.filter((f) => !f.misaligned).length).toBeGreaterThanOrEqual(39)
  })

  it('ファイルの範囲外を指す行は落とす（末尾切り詰め）', () => {
    const { frames, pts } = build(120)
    frames[119].frameIndex = pts.length + 5
    const r = checkTableAgainstFile(frames, pts)
    expect(r.frames).toHaveLength(119)
    expect(r.misaligned).toBe(0)
  })
})
