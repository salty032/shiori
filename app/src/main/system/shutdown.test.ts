import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  beforeQuit: null as ((event: { preventDefault(): void }) => void) | null,
  quit: vi.fn(),
  showMessageBox: vi.fn(),
  unregisterAll: vi.fn(),
  activeLabels: [] as string[],
  recording: false,
  flushSettings: vi.fn(async () => undefined),
  setQuitting: vi.fn(),
  stopWsServer: vi.fn(),
  cleanupDragTempDir: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    on: vi.fn((name: string, callback: (event: { preventDefault(): void }) => void) => {
      if (name === 'before-quit') mocks.beforeQuit = callback
    }),
    quit: (...args: unknown[]) => mocks.quit(...args),
  },
  dialog: { showMessageBox: (...args: unknown[]) => mocks.showMessageBox(...args) },
  globalShortcut: { unregisterAll: (...args: unknown[]) => mocks.unregisterAll(...args) },
}))

vi.mock('./busy', () => ({ activeTaskLabels: () => [...mocks.activeLabels] }))
vi.mock('./settings', () => ({ flushSettings: () => mocks.flushSettings() }))
vi.mock('./windows', () => ({
  getMainWindow: () => null,
  setQuitting: (value: boolean) => mocks.setQuitting(value),
}))
vi.mock('../browser/ws-server', () => ({ stopWsServer: () => mocks.stopWsServer() }))
vi.mock('../ipc/ipc-drag', () => ({ cleanupDragTempDir: () => mocks.cleanupDragTempDir() }))
vi.mock('../video/recording', () => ({ isRecordingInProgress: () => mocks.recording }))
vi.mock('./i18n', () => ({
  t: (key: string, params?: { tasks?: string }) => params?.tasks ? `running:${params.tasks}` : ({
    'busy.recording': '録画',
    'list.separator': '・',
  }[key] ?? key),
}))

import { registerShutdownGuard } from './shutdown'

function requestQuit(): ReturnType<typeof vi.fn> {
  const preventDefault = vi.fn()
  if (!mocks.beforeQuit) throw new Error('before-quit handler was not registered')
  mocks.beforeQuit({ preventDefault })
  return preventDefault
}

describe('終了ガード', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.beforeQuit = null
    mocks.activeLabels = []
    mocks.recording = false
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
    mocks.flushSettings.mockResolvedValue(undefined)
  })

  it('処理が無くても一度 quit を止め、設定保存と後片付けの後に終了し直す', async () => {
    registerShutdownGuard()
    const preventDefault = requestQuit()

    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledTimes(1))
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
    expect(mocks.flushSettings).toHaveBeenCalledTimes(1)
    expect(mocks.unregisterAll).toHaveBeenCalledTimes(1)
    expect(mocks.stopWsServer).toHaveBeenCalledTimes(1)
    expect(mocks.cleanupDragTempDir).toHaveBeenCalledTimes(1)
  })

  it('実行中に終了をキャンセルしたら後片付けせず通常状態へ戻る', async () => {
    mocks.activeLabels = ['取り込み']
    mocks.showMessageBox.mockResolvedValue({ response: 1 })
    registerShutdownGuard()
    requestQuit()

    await vi.waitFor(() => expect(mocks.setQuitting).toHaveBeenCalledWith(false))
    expect(mocks.quit).not.toHaveBeenCalled()
    expect(mocks.unregisterAll).not.toHaveBeenCalled()
  })

  it('録画だけが進行中でも終了確認に表示する', async () => {
    mocks.recording = true
    mocks.showMessageBox.mockResolvedValue({ response: 1 })
    registerShutdownGuard()
    requestQuit()

    await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledTimes(1))
    expect(mocks.showMessageBox.mock.calls[0][0]).toMatchObject({ message: 'running:録画' })
  })

  it('更新で確認済みなら、その更新が起こす before-quit で二度確認しない', async () => {
    mocks.activeLabels = ['書き出し']
    const guard = registerShutdownGuard()

    const ran = await guard.runUpdate(async () => { requestQuit() })

    expect(ran).toBe(true)
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledTimes(1))
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
  })
})
