import { describe, expect, it, vi } from 'vitest'

// extension-bridge.ts は起動時の配線ごと読み込むので、判断の関数だけを使えるよう周りを空にする。
vi.mock('electron', () => ({ Notification: class {} }))
vi.mock('./ws-server', () => ({}))
vi.mock('./extension-updater', () => ({}))
vi.mock('../system/settings', () => ({}))
vi.mock('./hotkey', () => ({}))
vi.mock('./timecode', () => ({}))
vi.mock('../capture/capture', () => ({}))
vi.mock('../video/recording', () => ({}))
vi.mock('../system/windows', () => ({}))
vi.mock('../system/i18n', () => ({ t: (k: string) => k }))

import { decideExtensionRefresh, EXTENSION_RELOAD_GRACE_MS, type ExtensionRefreshState } from './extension-bridge'

const fresh = (): ExtensionRefreshState => ({ requestedFor: null, requestedAt: 0, notified: false })

// 古い拡張が動いていると分かったら、利用者に頼まず拡張に自分を読み込み直させる。
describe('decideExtensionRefresh', () => {
  it('古い版が報告されたら、読み込み直しを 1 回だけ頼む', () => {
    const s = fresh()
    expect(decideExtensionRefresh(s, '1.6.3', 1000, false)).toBe('reload')
    expect(decideExtensionRefresh(s, '1.6.3', 2000, false)).toBe('wait')
  })

  it('録画中・撮影中は頼まずに待つ（ページの部分が入れ替わると撮っている途中のものが壊れる）', () => {
    const s = fresh()
    expect(decideExtensionRefresh(s, '1.6.3', 1000, true)).toBe('wait')
    expect(decideExtensionRefresh(s, '1.6.3', 2000, false)).toBe('reload')
  })

  it('頼んでもしばらく古いままなら（別のフォルダの拡張を読んでいる）、頼み直さず 1 回だけ手での再読み込みを案内する', () => {
    const s = fresh()
    decideExtensionRefresh(s, '1.6.3', 0, false)
    expect(decideExtensionRefresh(s, '1.6.3', EXTENSION_RELOAD_GRACE_MS + 1, false)).toBe('notify')
    expect(decideExtensionRefresh(s, '1.6.3', EXTENSION_RELOAD_GRACE_MS + 2, false)).toBe('none')
  })

  it('別の古い版が来たら（もう一度更新された）、また頼む', () => {
    const s = fresh()
    decideExtensionRefresh(s, '1.6.2', 0, false)
    expect(decideExtensionRefresh(s, '1.6.3', 10, false)).toBe('reload')
  })
})
