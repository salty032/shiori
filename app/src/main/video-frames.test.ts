import { describe, expect, it, vi } from 'vitest'

// db.ts は electron の app.getPath を読むため、import 時点でモックが要る。
// better-sqlite3 は Electron の ABI 向けにビルドされており素の Node からは読み込めないので、
// 実 DB を張るテストは書けない。ここでは DB アクセスから切り離した直列化だけを検証する。
vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/userData') } }))

// 数え直し（backfillFrameCounts）だけは DB を読むので、その 2 か所だけ差し替える。
const storedRows = vi.fn<() => unknown[]>(() => [])
const setFrameCountsMock = vi.fn()
const executedSql: { sql: string; args: unknown[] }[] = []
vi.mock('./db-core', () => ({
  getDb: vi.fn(),
  prepare: (sql: string) => ({
    all: () => storedRows(),
    get: () => undefined,
    run: (...args: unknown[]) => { executedSql.push({ sql, args }) }
  })
}))
vi.mock('./db', () => ({ setFrameCounts: (...args: unknown[]) => setFrameCountsMock(...args) }))

import {
  encodeFrames, decodeFrames, encodeUnusable, readUnusableReason, backfillFrameCounts,
  markVideoFramesUnusable, type StoredFrame
} from './db-video-frames'

const frames: StoredFrame[] = [
  { mediaTime: 0, frameIndex: 0, captured: true, verified: 'unknown' },
  { mediaTime: 0.0417083, frameIndex: 2, captured: true, verified: 'unknown' },
  { mediaTime: 0.0834166, frameIndex: 2, captured: false, verified: 'changed' }
]

describe('フレーム表の直列化', () => {
  it('保存した内容をそのまま読み戻せる', () => {
    expect(decodeFrames(encodeFrames(frames))).toEqual(frames)
  })

  it('千コマ規模でも往復できる（60秒クリップ相当）', () => {
    const many: StoredFrame[] = Array.from({ length: 1440 }, (_, i) => ({
      mediaTime: i / 23.976, frameIndex: Math.floor(i * 1.4), captured: i % 20 !== 0, verified: 'unknown' as const
    }))
    const back = decodeFrames(encodeFrames(many))!
    expect(back).toHaveLength(1440)
    expect(back[1439]).toEqual(many[1439])
  })

  // 検証結果（4要素目）は後から足したもの。既存クリップの行は3要素しか無いため、
  // ここが読めなくなると過去の録画のコマ送りが丸ごと従来動作へ落ちる。
  it('検証結果を持たない古い行（3要素）も読める。未検証として扱う', () => {
    const back = decodeFrames('[[0,0,1],[0.042,2,0]]')!
    expect(back).toHaveLength(2)
    expect(back[0].verified).toBe('unknown')
    expect(back[1]).toEqual({ mediaTime: 0.042, frameIndex: 2, captured: false, verified: 'unknown' })
  })

  it('検証結果を往復できる', () => {
    const back = decodeFrames(encodeFrames([
      { mediaTime: 0, frameIndex: 0, captured: false, verified: 'same' },
      { mediaTime: 0.042, frameIndex: 1, captured: false, verified: 'changed' }
    ]))!
    expect(back.map((f) => f.verified)).toEqual(['same', 'changed'])
  })

  it('verified を省いて保存したら未検証として読み戻る', () => {
    const back = decodeFrames(encodeFrames([{ mediaTime: 0, frameIndex: 0, captured: true }]))!
    expect(back[0].verified).toBe('unknown')
  })

  it('アニメの抜け推定を前の行に保存して読み戻せる', () => {
    const row: StoredFrame = {
      mediaTime: 35.243, frameIndex: 683, captured: true, animeGapMissing: 2
    }
    expect(decodeFrames(encodeFrames([row]))![0]).toMatchObject({ animeGapMissing: 2 })
  })

  it('壊れたアニメの抜け推定は表を捨てず、未推定として扱う', () => {
    // 7要素目。0・小数・文字列はいずれも推定値として採らない。
    for (const bad of [0, 1.5, '2']) {
      const back = decodeFrames(JSON.stringify([[0, 0, 1, 0, 0, -1, bad]]))!
      expect(back[0].animeGapMissing).toBeUndefined()
    }
  })

  // 検証結果は補助情報。見慣れないコードが入っていても、コマ送りの土台である
  // mediaTime/frameIndex まで巻き添えで捨てない（未検証へ落として使い続ける）。
  it('検証結果のコードが想定外でも表は捨てず、未検証として扱う', () => {
    const back = decodeFrames('[[0,0,1,9]]')!
    expect(back[0]).toEqual({ mediaTime: 0, frameIndex: 0, captured: true, verified: 'unknown' })
  })

  it('mediaTime の精度が落ちない（コマの同定に使うため）', () => {
    const back = decodeFrames(encodeFrames(frames))!
    expect(back[1].mediaTime).toBe(0.0417083)
  })

  // 以下は「壊れていたら精度を諦めて従来動作へ退避する」ことの確認。
  // 半端に解釈してコマ送りが不可解に狂う方が、精度が無いより悪い。
  it('JSON として壊れていれば null', () => {
    expect(decodeFrames('{"broken"')).toBeNull()
    expect(decodeFrames('')).toBeNull()
  })

  it('配列でない・空なら null', () => {
    expect(decodeFrames('{"a":1}')).toBeNull()
    expect(decodeFrames('[]')).toBeNull()
  })

  it('要素の形が違えば null', () => {
    expect(decodeFrames('[[0,1]]')).toBeNull()          // 要素数が足りない
    expect(decodeFrames('[[0,1,1],"x"]')).toBeNull()    // 配列でない要素が混在
    expect(decodeFrames('[["a",1,1]]')).toBeNull()      // mediaTime が数値でない
    expect(decodeFrames('[[0,1.5,1]]')).toBeNull()      // frameIndex が整数でない
    expect(decodeFrames('[[0,-1,1]]')).toBeNull()       // frameIndex が負
  })

  it('captured は 1 以外を全て false として扱う', () => {
    expect(decodeFrames('[[0,0,0]]')![0].captured).toBe(false)
    expect(decodeFrames('[[0,0,1]]')![0].captured).toBe(true)
  })
})

describe('使えない表の集計値を無効化する', () => {
  it('ずれを含む全カウントを一緒に null へ戻す', () => {
    executedSql.length = 0
    markVideoFramesUnusable(7, 'correspondence-break')
    const update = executedSql.find((entry) => entry.sql.includes('UPDATE images'))
    expect(update?.sql).toContain('misaligned_frames = NULL')
    expect(update?.args).toEqual([7])
  })
})

// 検証で「使ってはいけない」と決めた表の扱い（markVideoFramesUnusable）。
// 以前は行ごと DELETE していたが、判定の方が誤っていたときに遡って救えないため残す形にした。
// **残したうえで、絶対に使われないことが要る。** その保証がこの 3 本。
describe('使えないと判定した表', () => {
  const frames: StoredFrame[] = [
    { mediaTime: 0, frameIndex: 0, captured: true, verified: 'unknown' },
    { mediaTime: 0.042, frameIndex: 2, captured: false, verified: 'same' }
  ]

  it('印を付けた行は、読み出すと「表が無い」と同じ null になる', () => {
    // 呼ぶ側は 1 行も変えずに従来のフレーム走査へ落ちる。ここが null でなくなると、
    // 対応が 1 コマずれた表で黙ってコマ送りが動くことになる。
    expect(decodeFrames(encodeUnusable(encodeFrames(frames), 'correspondence-break'))).toBeNull()
  })

  it('印を付けても、表の中身はそのまま残っている', () => {
    // 後から判定を直したときに救えること。消していた頃はここが失われていた。
    const marked = encodeUnusable(encodeFrames(frames), 'correspondence-break')
    expect(decodeFrames(JSON.stringify(JSON.parse(marked).frames))).toEqual(frames)
    expect(readUnusableReason(marked)).toBe('correspondence-break')
  })

  it('通常の表と壊れた行には印が付いていない', () => {
    expect(readUnusableReason(encodeFrames(frames))).toBeNull()
    expect(readUnusableReason('{')).toBeNull()
  })
})

// 詳細パネルに出す枚数は録画・トリミングの直後にしか書いていない。実測（2026-08-26）では
// 手元 82 本のうち 25 本が空、5 本が表と食い違っており、**詳細パネルだけが黙る**状態だった
// （コマ送りの表示は開くたびに表から数え直すので出ていた）。起動後に数え直して埋める。
describe('保存済みのコマ表から枚数を数え直す', () => {
  const SRC = 1 / 24
  // 6 コマぶんの表。3 コマ目の後ろで 2 コマ抜け、最後の 1 コマは対応がずれている。
  const table: StoredFrame[] = [0, 1, 2, 5, 6, 7].map((n, i) => ({
    mediaTime: n * SRC,
    frameIndex: i,
    captured: i !== 1,
    verified: 'unknown' as const,
    ...(i === 5 ? { misaligned: true } : {})
  }))

  const row = (over: Record<string, unknown>): unknown => ({
    imageId: 7, data: encodeFrames(table),
    uncaptured: null, total: null, unreported: null, misaligned: null, ...over
  })

  it('空のままの録画を、表から数えて埋める', () => {
    setFrameCountsMock.mockClear()
    storedRows.mockReturnValue([row({})])
    expect(backfillFrameCounts()).toBe(1)
    // 撮り逃し 1 / 行数 6 / 抜け 2 / ずれ 1
    expect(setFrameCountsMock).toHaveBeenCalledWith(7, 1, 6, 2, 1, false)
  })

  it('既に合っている録画は書き換えない（起動のたびに全件書き直さない）', () => {
    setFrameCountsMock.mockClear()
    storedRows.mockReturnValue([row({ uncaptured: 1, total: 6, unreported: 2, misaligned: 1 })])
    expect(backfillFrameCounts()).toBe(0)
    expect(setFrameCountsMock).not.toHaveBeenCalled()
  })

  it('使えない印の付いた表は触らない（表が無いのと同じ扱い）', () => {
    setFrameCountsMock.mockClear()
    storedRows.mockReturnValue([row({ data: encodeUnusable(encodeFrames(table), 'correspondence-break') })])
    expect(backfillFrameCounts()).toBe(0)
    expect(setFrameCountsMock).not.toHaveBeenCalled()
  })
})
