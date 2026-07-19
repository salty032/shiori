import { describe, expect, it } from 'vitest'
import { decideVersionNotice } from './version-notice'

describe('decideVersionNotice', () => {
  it('同一バージョン → none', () => {
    expect(decideVersionNotice('1.1.3', '1.1.3', ['note'])).toEqual({ kind: 'none' })
  })

  it('初回起動（previousRunVersion が null）→ none', () => {
    expect(decideVersionNotice(null, '1.1.3', ['note'])).toEqual({ kind: 'none' })
  })

  it('更新されていて該当バージョンのノートがある → whatsNew', () => {
    expect(decideVersionNotice('1.1.2', '1.1.3', ['機能を追加しました'])).toEqual({
      kind: 'whatsNew',
      version: '1.1.3',
      notes: ['機能を追加しました'],
    })
  })

  it('更新されているがノートが無い（undefined） → toast', () => {
    expect(decideVersionNotice('1.1.2', '1.1.3', undefined)).toEqual({
      kind: 'toast',
      message: 'Shiori を v1.1.3 に更新しました',
    })
  })

  it('更新されているがノートが空配列 → toast', () => {
    expect(decideVersionNotice('1.1.2', '1.1.3', [])).toEqual({
      kind: 'toast',
      message: 'Shiori を v1.1.3 に更新しました',
    })
  })
})
