// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSettingsStore } from './settingsStore'
import { SETTINGS_DEFAULTS } from '../../../shared/settingsDefaults'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('設定の楽観更新と巻き戻し', () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: { ...SETTINGS_DEFAULTS }, loaded: true })
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('保存に失敗したキーだけ元の値へ戻す', async () => {
    window.api = { setSettings: vi.fn().mockRejectedValue(new Error('ipc down')) } as never
    const toast = vi.fn()

    await useSettingsStore.getState().update('thumbnailSize', 200, toast)

    expect(useSettingsStore.getState().settings.thumbnailSize).toBe(SETTINGS_DEFAULTS.thumbnailSize)
    expect(toast).toHaveBeenCalledWith(expect.any(String), 'error')
  })

  it('同じキーを続けて変えたとき、先発の失敗で後発の成功値を巻き戻さない', async () => {
    // スライダーを動かす・テーマを続けて切り替える、で実際に起きる並び。
    // 巻き戻しの基準を「呼び出し前の値」だけにすると、画面には保存できた 240 ではなく
    // 2 つ前の既定値が出る（そして次の再起動で 240 に戻り、原因が分からない）。
    const first = deferred<void>()
    const setSettings = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => Promise.resolve())
    window.api = { setSettings } as never

    const firstCall = useSettingsStore.getState().update('thumbnailSize', 120)
    await useSettingsStore.getState().update('thumbnailSize', 240)
    first.reject(new Error('ipc down'))
    await firstCall

    expect(useSettingsStore.getState().settings.thumbnailSize).toBe(240)
  })
})
