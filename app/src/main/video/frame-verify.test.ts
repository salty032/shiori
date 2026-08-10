import { describe, expect, it, vi } from 'vitest'

// db.ts は electron の app.getPath を import 時点で読むため、型のみの参照でもモックが要る。
vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/userData') } }))

import { findFrameDivergence, signaturesDiffer, verifyFrameTable } from './frame-verify'
import type { StoredFrame } from '../db'

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

  it('末尾を撮り逃した場合は比較相手が無いので判定しない（undetermined）', () => {
    const tail = [frame(0, 0, true), frame(0.042, 0, false)]
    const result = verifyFrameTable(tail, [flat(100)])
    expect(result.frames[1].verified).toBe('unknown')
    expect(result).toMatchObject({ missed: 1, unknown: 1, ambiguous: 0, harmless: 0 })
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

  function makeDrawn(count: number, jitterMs = 0): number[] {
    let seed = 4242
    return Array.from({ length: count }, (_, i) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const jitter = jitterMs === 0 ? 0 : ((seed / 0x7fffffff) * 2 - 1) * jitterMs
      return T0 + i * GAP_MS + jitter
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
