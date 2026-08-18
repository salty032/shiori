import { describe, expect, it } from 'vitest'

import { describeStartupError, STARTUP_ERROR_DETAIL_MAX } from './startup-error'

describe('起動失敗ダイアログに出す 1 行', () => {
  it('Error のメッセージをそのまま出す', () => {
    expect(describeStartupError(new Error('EADDRINUSE 127.0.0.1:39821'))).toBe('EADDRINUSE 127.0.0.1:39821')
  })

  it('Error 以外が投げられても文字列にして出す（throw されるのは Error とは限らない）', () => {
    expect(describeStartupError('boom')).toBe('boom')
    expect(describeStartupError(undefined)).toBe('undefined')
  })

  it('複数行のメッセージは 1 行目だけにする（ダイアログが縦に伸びて閉じられなくなる）', () => {
    const err = new Error('SQLITE_CORRUPT: database disk image is malformed\n  at Database.prepare\n  at initDb')
    expect(describeStartupError(err)).toBe('SQLITE_CORRUPT: database disk image is malformed')
  })

  it('長い 1 行は切って末尾に ... を付ける', () => {
    const long = 'x'.repeat(STARTUP_ERROR_DETAIL_MAX + 50)
    const out = describeStartupError(new Error(long))
    expect(out).toHaveLength(STARTUP_ERROR_DETAIL_MAX + 3)
    expect(out.endsWith('...')).toBe(true)
  })

  it('メッセージが空でも理由の行を空にしない', () => {
    expect(describeStartupError(new Error(''))).toBe('unknown error')
    expect(describeStartupError(new Error('   \n  詳細'))).toBe('unknown error')
  })
})
