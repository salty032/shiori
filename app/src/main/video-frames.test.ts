import { describe, expect, it, vi } from 'vitest'

// db.ts は electron の app.getPath を読むため、import 時点でモックが要る。
// better-sqlite3 は Electron の ABI 向けにビルドされており素の Node からは読み込めないので、
// 実 DB を張るテストは書けない。ここでは DB アクセスから切り離した直列化だけを検証する。
vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/userData') } }))

import { encodeFrames, decodeFrames, type StoredFrame } from './db-video-frames'

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
