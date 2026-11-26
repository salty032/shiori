import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 起動の順番を確かめる。どれも `npm run verify` の他のテストでは見えず、間違えると
// 「dev なのに古い版が起動する」「起動し直すたびにプロセスが溜まる」「起動時の通知が出ない」
// のように、動いているように見えたまま壊れる（.claude/rules/startup.md）。
const m = vi.hoisted(() => {
  const calls: string[] = []
  const rec = (name: string, ret?: unknown) => vi.fn((..._args: unknown[]) => { calls.push(name); return ret })
  // 確かめに使わないモジュールは、どの名前を読んでも「何もしない関数」を返す。
  // 後ろで .catch() を繋ぐ呼び出しがあるので、戻り値は解決済みの Promise にする。
  const stub = (): Record<string, unknown> => new Proxy({} as Record<string | symbol, unknown>, {
    get(target, key) {
      if (key === 'then' || key === '__esModule' || typeof key === 'symbol') return undefined
      if (!(key in target)) target[key] = vi.fn(() => Promise.resolve(undefined))
      return target[key]
    }
  })
  return {
    calls,
    rec,
    stub,
    app: {
      isPackaged: false,
      commandLine: { appendSwitch: vi.fn() },
      enableSandbox: vi.fn(),
      getPath: vi.fn(() => 'C:/AppData'),
      getName: vi.fn(() => 'Shiori'),
      getVersion: vi.fn(() => '2.0.0'),
      setPath: rec('setPath'),
      requestSingleInstanceLock: rec('requestSingleInstanceLock', true),
      quit: rec('quit'),
      setAppUserModelId: vi.fn(),
      on: vi.fn(),
      whenReady: vi.fn(() => Promise.resolve())
    },
    dialog: { showErrorBox: vi.fn() },
    registerShutdownGuard: rec('registerShutdownGuard', { runUpdate: vi.fn() }),
    startDiagLogIfEnabled: rec('startDiagLogIfEnabled'),
    openDatabaseOrRecover: vi.fn(() => true),
    createWindow: rec('createWindow'),
    getMainWindow: vi.fn((): unknown => null),
    readyCallbacks: [] as Array<() => void>,
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    sendToRenderer: vi.fn(),
    sendNotice: vi.fn(),
    settings: { language: 'ja', captureHotkey: 'Alt+S', allowedExtensionIds: [] as string[], lastRunVersion: '2.0.0' } as Record<string, unknown>,
    saveSettings: vi.fn(),
    consumeSettingsLoadProblem: vi.fn((): string | null => null),
    rebuildTrayMenu: vi.fn(),
    broadcastMessage: vi.fn(),
    backfillFrameCounts: vi.fn(() => 0),
    recheckMarkedClips: vi.fn(() => Promise.resolve()),
    sweepOrphanFilesIfDue: vi.fn(() => Promise.resolve()),
    normalizeCaptureHotkey: vi.fn((h: string): string | null => h),
    changeHotkey: vi.fn(() => true)
  }
})

vi.mock('electron', () => ({
  app: m.app,
  dialog: m.dialog,
  globalShortcut: { isRegistered: vi.fn(() => true) },
  Menu: { setApplicationMenu: vi.fn() },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } }
}))
vi.mock('fs', async (orig) => ({ ...(await orig<typeof import('fs')>()), mkdirSync: vi.fn() }))

vi.mock('./system/shutdown', () => ({ registerShutdownGuard: m.registerShutdownGuard }))
vi.mock('./system/diag-log', () => ({ startDiagLogIfEnabled: m.startDiagLogIfEnabled }))
vi.mock('./db/db-startup', () => ({ openDatabaseOrRecover: m.openDatabaseOrRecover, backupDateLabel: vi.fn(() => '') }))
vi.mock('./system/windows', () => ({
  createWindow: m.createWindow,
  getMainWindow: m.getMainWindow,
  whenRendererReady: (cb: () => void) => { m.readyCallbacks.push(cb) },
  handleTrusted: (channel: string, fn: (...args: unknown[]) => unknown) => { m.handlers.set(channel, fn) },
  sendToRenderer: m.sendToRenderer,
  sendNotice: m.sendNotice,
  showMainWindow: vi.fn(),
  isMainWindowFocused: vi.fn(() => false)
}))
vi.mock('./system/settings', () => ({
  loadSettings: () => ({ ...m.settings }),
  saveSettings: (s: Record<string, unknown>) => { m.saveSettings(s); Object.assign(m.settings, s) },
  consumeSettingsLoadProblem: m.consumeSettingsLoadProblem,
  onSettingsPersistFailed: vi.fn(),
  stripDedicatedSettingKeys: (patch: Record<string, unknown>) => {
    const { captureHotkey: _h, ...safePatch } = patch
    return { safePatch, ignored: 'captureHotkey' in patch ? ['captureHotkey'] : [] }
  }
}))
vi.mock('./system/tray', () => ({ createTray: vi.fn(), rebuildTrayMenu: m.rebuildTrayMenu }))
vi.mock('./system/startup', () => ({
  isStartupLaunch: vi.fn(() => false), isOpenAtLogin: vi.fn(), setOpenAtLogin: vi.fn(), migrateStartupArgs: vi.fn()
}))
vi.mock('./system/i18n', () => ({ t: (key: string) => key }))
vi.mock('./system/startup-error', () => ({ describeStartupError: () => 'detail' }))
vi.mock('./db/db-maintenance', () => ({ consumeRestoreMarker: vi.fn(() => null) }))
vi.mock('./db/db-schema', () => ({ databasePath: vi.fn(() => 'db'), consumeDbBackupFailure: vi.fn(() => false) }))
vi.mock('./db/db-video-frames', () => ({ backfillFrameCounts: m.backfillFrameCounts }))
vi.mock('./video/verify-clip', () => ({ recheckMarkedClips: m.recheckMarkedClips }))
vi.mock('./capture/sweep-orphans', () => ({ sweepOrphanFilesIfDue: m.sweepOrphanFilesIfDue }))
vi.mock('./browser/ws-server', () => ({
  broadcastMessage: m.broadcastMessage, onExtensionMessage: vi.fn(), setAllowedExtensionIds: vi.fn(), onPortInUse: vi.fn()
}))
vi.mock('./browser/hotkey', () => ({ normalizeCaptureHotkey: m.normalizeCaptureHotkey }))
vi.mock('./browser/extension-bridge', () => ({
  startExtensionBridge: vi.fn(), extensionSettingsMessage: (s: unknown) => ({ type: 'settings', settings: s })
}))
vi.mock('./capture/capture', () => ({
  onCaptureDone: vi.fn(), setSourceVideoSize: vi.fn(), setPreCaptureHook: vi.fn(), setPostCaptureHook: vi.fn(),
  canCaptureVideo: vi.fn(() => true), isBrowserVideoCovered: vi.fn(() => false), setBlackFrameHook: vi.fn(), runPreCaptureGuards: vi.fn(),
  changeHotkey: m.changeHotkey,
  registerHotkey: vi.fn(() => true),
  onCaptureFailure: vi.fn(),
  SilentCaptureAbort: class extends Error {}
}))
vi.mock('./capture/captured-media', () => m.stub())
vi.mock('./video', () => m.stub())
vi.mock('./browser/extension-updater', () => m.stub())
vi.mock('./capture/migrate-thumbnails', () => m.stub())
vi.mock('./system/updater', () => m.stub())
vi.mock('./system/paths', () => m.stub())
vi.mock('./system/capfile-protocol', () => m.stub())
vi.mock('./capture/image-thumb', () => m.stub())
vi.mock('./browser/timecode', () => m.stub())
vi.mock('./ipc/ipc-images', () => m.stub())
vi.mock('./ipc/ipc-drag', () => m.stub())
vi.mock('./ipc/ipc-tagger', () => m.stub())
vi.mock('./ipc/ipc-share', () => m.stub())
vi.mock('./ipc/ipc-import', () => m.stub())
vi.mock('./ipc/ipc-shell', () => m.stub())
vi.mock('./browser/browser-notice', () => m.stub())
vi.mock('./browser/ext-diag', () => m.stub())
vi.mock('./browser/timecode-request', () => m.stub())

import { bootstrap } from './bootstrap'
import { CH } from '../shared/api'

// whenReady().then(...) の中身が終わるまで待つ。
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
  m.calls.length = 0
  m.readyCallbacks.length = 0
  m.handlers.clear()
  m.app.isPackaged = false
  m.app.requestSingleInstanceLock.mockImplementation(() => { m.calls.push('requestSingleInstanceLock'); return true })
  m.openDatabaseOrRecover.mockReturnValue(true)
  m.getMainWindow.mockReturnValue(null)
  m.app.whenReady.mockImplementation(() => Promise.resolve())
  Object.assign(m.settings, { language: 'ja', captureHotkey: 'Alt+S', lastRunVersion: '2.0.0' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('bootstrap: 二重起動と終了の確認', () => {
  it('2 回目の起動は、終了の確認を登録する前に終わる', () => {
    m.app.requestSingleInstanceLock.mockImplementation(() => { m.calls.push('requestSingleInstanceLock'); return false })
    bootstrap()
    expect(m.app.quit).toHaveBeenCalled()
    // 終了の確認が先にあると、この quit を止めてプロセス一式が残り続ける
    expect(m.registerShutdownGuard).not.toHaveBeenCalled()
    // 1 回目と同じログファイルへ書かない
    expect(m.startDiagLogIfEnabled).not.toHaveBeenCalled()
  })

  it('終了の確認は二重起動のチェックの後に登録する', () => {
    bootstrap()
    expect(m.calls.indexOf('requestSingleInstanceLock')).toBeLessThan(m.calls.indexOf('registerShutdownGuard'))
  })
})

describe('bootstrap: 開発版と製品版を分ける', () => {
  it('開発版は保存場所を二重起動の鍵より先に分ける', () => {
    bootstrap()
    expect(m.app.setPath).toHaveBeenCalledWith('userData', expect.stringContaining('Shiori-dev'))
    // 後ろで分けると、鍵は製品版と同じ場所のまま取られ、常駐中の製品版が前に出てくる
    expect(m.calls.indexOf('setPath')).toBeLessThan(m.calls.indexOf('requestSingleInstanceLock'))
  })

  it('製品版は保存場所を変えない', () => {
    m.app.isPackaged = true
    bootstrap()
    expect(m.app.setPath).not.toHaveBeenCalled()
  })

  it('開発版の ID は製品版と分ける（同じだとタスクバーと通知が Electron に取られる）', () => {
    bootstrap()
    const devId = m.app.setAppUserModelId.mock.calls[0][0]
    vi.clearAllMocks()
    m.app.isPackaged = true
    bootstrap()
    const prodId = m.app.setAppUserModelId.mock.calls[0][0]
    expect(prodId).toBe('com.shiori.app')
    expect(devId).not.toBe(prodId)
  })
})

describe('bootstrap: DB が開けないとき', () => {
  it('ウィンドウを作らずに終了する（ロックだけ握ったプロセスを残さない）', async () => {
    m.openDatabaseOrRecover.mockReturnValue(false)
    bootstrap()
    await settle()
    expect(m.app.quit).toHaveBeenCalled()
    expect(m.createWindow).not.toHaveBeenCalled()
  })
})

describe('bootstrap: 後追いの処理', () => {
  it('画面の読み込みが終わってから猶予を置いて 1 回だけ走る', async () => {
    vi.useFakeTimers()
    bootstrap()
    await settle()
    expect(m.backfillFrameCounts).not.toHaveBeenCalled()
    m.readyCallbacks.forEach((cb) => cb())
    await vi.advanceTimersByTimeAsync(5_000)
    expect(m.backfillFrameCounts).toHaveBeenCalledTimes(1)
    expect(m.recheckMarkedClips).toHaveBeenCalledTimes(1)
    expect(m.sweepOrphanFilesIfDue).toHaveBeenCalledTimes(1)
    // 保険の 30 秒が来ても二重には走らない
    await vi.advanceTimersByTimeAsync(30_000)
    expect(m.backfillFrameCounts).toHaveBeenCalledTimes(1)
  })

  it('読み込みの合図が来なくても、30 秒の保険で走る', async () => {
    vi.useFakeTimers()
    bootstrap()
    await settle()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(m.backfillFrameCounts).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(m.backfillFrameCounts).toHaveBeenCalledTimes(1)
  })

  it('数え直しが失敗しても、見直しと掃除は走る', async () => {
    vi.useFakeTimers()
    m.backfillFrameCounts.mockImplementation(() => { throw new Error('boom') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    bootstrap()
    await settle()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(m.recheckMarkedClips).toHaveBeenCalled()
    expect(m.sweepOrphanFilesIfDue).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('bootstrap: 起動時の知らせ', () => {
  it('設定が読めなかったことは、画面の準備ができてから出す', async () => {
    m.consumeSettingsLoadProblem.mockReturnValue('unreadable')
    bootstrap()
    await settle()
    expect(m.sendNotice).not.toHaveBeenCalled()
    m.readyCallbacks.forEach((cb) => cb())
    expect(m.sendNotice).toHaveBeenCalledWith('error', 'notice.settingsUnreadable')
  })

  it('壊れていたときと読めなかったときで、文言を分ける', async () => {
    m.consumeSettingsLoadProblem.mockReturnValue('corrupt')
    bootstrap()
    await settle()
    m.readyCallbacks.forEach((cb) => cb())
    expect(m.sendNotice).toHaveBeenCalledWith('error', 'notice.settingsCorrupt')
  })

  it('版が変わった起動では変更点を出し、今の版を記録する', async () => {
    m.settings.lastRunVersion = '1.6.0'
    m.app.getVersion.mockReturnValue('1.6.1')
    bootstrap()
    await settle()
    m.readyCallbacks.forEach((cb) => cb())
    expect(m.sendToRenderer).toHaveBeenCalledWith(CH.whatsNew, expect.objectContaining({ version: '1.6.1' }))
    expect(m.settings.lastRunVersion).toBe('1.6.1')
  })

  it('同じ版の起動では何も出さない', async () => {
    m.app.getVersion.mockReturnValue('2.0.0')
    bootstrap()
    await settle()
    m.readyCallbacks.forEach((cb) => cb())
    expect(m.sendToRenderer).not.toHaveBeenCalledWith(CH.whatsNew, expect.anything())
    expect(m.saveSettings).not.toHaveBeenCalled()
  })
})

describe('bootstrap: 設定の保存', () => {
  async function settingsSet(patch: unknown): Promise<void> {
    bootstrap()
    await settle()
    await m.handlers.get(CH.settingsSet)!({}, patch)
  }

  it('送られたキーだけを、保存済みの値に重ねる', async () => {
    m.settings.captureNotify = true
    await settingsSet({ showAiTags: true })
    expect(m.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ showAiTags: true, captureNotify: true }))
  })

  it('専用の口が要るキー（ホットキー等）は落とす', async () => {
    await settingsSet({ captureHotkey: 'Alt+X' })
    expect(m.settings.captureHotkey).toBe('Alt+S')
  })

  it('言語が変わったときだけトレイのメニューを組み直す', async () => {
    await settingsSet({ showAiTags: true })
    expect(m.rebuildTrayMenu).not.toHaveBeenCalled()
    await m.handlers.get(CH.settingsSet)!({}, { language: 'en' })
    expect(m.rebuildTrayMenu).toHaveBeenCalledTimes(1)
  })

  it('保存した設定を拡張へ配り直す', async () => {
    await settingsSet({ language: 'en' })
    expect(m.broadcastMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'settings' }))
  })
})

describe('bootstrap: ホットキーの変更', () => {
  async function setHotkey(h: string): Promise<unknown> {
    bootstrap()
    await settle()
    return m.handlers.get(CH.captureSetHotkey)!({}, h)
  }

  it('使えない組み合わせなら登録も保存もしない', async () => {
    m.normalizeCaptureHotkey.mockReturnValue(null)
    expect(await setHotkey('X')).toBe(false)
    expect(m.changeHotkey).not.toHaveBeenCalled()
    expect(m.saveSettings).not.toHaveBeenCalled()
  })

  it('登録できたら保存し、拡張へ配り直す', async () => {
    m.normalizeCaptureHotkey.mockReturnValue('Alt+Q')
    expect(await setHotkey('alt+q')).toBe(true)
    expect(m.settings.captureHotkey).toBe('Alt+Q')
    expect(m.broadcastMessage).toHaveBeenCalled()
  })

  it('登録できなければ保存しない（他のアプリが握っている等）', async () => {
    m.changeHotkey.mockReturnValue(false)
    expect(await setHotkey('Alt+Q')).toBe(false)
    expect(m.saveSettings).not.toHaveBeenCalled()
  })
})

describe('bootstrap: 準備の途中で落ちたとき', () => {
  it('ウィンドウが無ければ、知らせてから終了する', async () => {
    m.createWindow.mockImplementation(() => { throw new Error('icon') })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    bootstrap()
    await settle()
    expect(m.dialog.showErrorBox).toHaveBeenCalledWith('Shiori', 'error.startupFailed')
    expect(m.app.quit).toHaveBeenCalled()
    err.mockRestore()
  })

  it('ウィンドウがあれば、知らせるだけで終了しない（途中まで使える）', async () => {
    m.createWindow.mockImplementation(() => { throw new Error('later step') })
    m.getMainWindow.mockReturnValue({ isDestroyed: () => false })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    bootstrap()
    await settle()
    expect(m.dialog.showErrorBox).toHaveBeenCalledWith('Shiori', 'error.startupPartial')
    expect(m.app.quit).not.toHaveBeenCalled()
    err.mockRestore()
  })
})
