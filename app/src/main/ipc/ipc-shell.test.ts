import { describe, expect, it, vi, beforeEach } from 'vitest'

// 保存先の変更（ipc-shell.ts の storageChooseRoot / storageMoveToRoot）。
// 移す先の計算（planCaptureMove）は本物を使い、ファイルを実際に動かす moveCaptureFiles だけ差し替える。

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
}))
vi.mock('../system/windows', () => ({
  handleTrusted: (channel: string, listener: (...args: unknown[]) => unknown) => { handlers.set(channel, listener) },
  safeExternalUrl: (url: string) => url,
  sendToRenderer: vi.fn(),
}))

const pickFolder = vi.fn(async () => ({ canceled: false, filePaths: ['D:\\new-captures'] as string[] }))
vi.mock('../system/dialogs', () => ({ showOpenDialogOver: () => pickFolder() }))

const writeFileMock = vi.fn(async (..._args: unknown[]) => {})
vi.mock('fs/promises', () => ({
  mkdir: vi.fn(async () => {}),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
  unlink: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ size: 1000 })),
}))

let imagePaths: { id: number; filepath: string }[] = []
const setImagePathsMock = vi.fn()
vi.mock('../db/db', () => ({
  getImage: vi.fn(), countImages: vi.fn(),
  listImagePaths: () => imagePaths,
  setImagePaths: (...args: unknown[]) => setImagePathsMock(...args),
}))

const rootProblem = vi.fn((_p: string): string | null => null)
vi.mock('../system/paths', () => ({
  resolveRealCapturePath: vi.fn(),
  captureDir: () => 'C:\\old-captures',
  defaultCaptureDir: () => 'C:\\old-captures',
  captureRootProblem: (p: string) => rootProblem(p),
}))
vi.mock('../browser/extension-updater', () => ({ installedExtensionPath: () => 'C:\\ext' }))
vi.mock('../browser/ws-server', () => ({ getActivePort: () => 0 }))
vi.mock('../system/storage', () => ({ collectStorageUsage: vi.fn() }))

type Outcome = { ok: true; moved: number; missing: number } | { ok: false; reason: 'conflict' | 'canceled' | 'failed'; failedPath?: string }
let moveImpl: (params: { targets: unknown[]; isCanceled?: () => boolean; commit: (m: unknown[]) => void }) => Promise<Outcome>
const moveCalls = vi.fn()
vi.mock('../system/move-captures', async (importOriginal) => ({
  planCaptureMove: (await importOriginal<typeof import('../system/move-captures')>()).planCaptureMove,
  moveCaptureFiles: (params: Parameters<typeof moveImpl>[0]) => { moveCalls(params); return moveImpl(params) },
}))

let settings = { captureRoot: null as string | null, previousCaptureRoots: [] as string[], language: 'ja' }
const saveSettingsMock = vi.fn((next: typeof settings) => { settings = next })
vi.mock('../system/settings', () => ({
  loadSettings: () => settings,
  saveSettings: (next: typeof settings) => saveSettingsMock(next),
}))

import { registerShellHandlers } from './ipc-shell'
import { hasActiveTasks, resetTasksForTest } from '../system/busy'

const choose = (): Promise<Record<string, unknown>> => handlers.get('storage:chooseRoot')!({}) as Promise<Record<string, unknown>>
const move = (path: unknown): Promise<Record<string, unknown>> => handlers.get('storage:moveToRoot')!({}, path) as Promise<Record<string, unknown>>

beforeEach(() => {
  handlers.clear()
  resetTasksForTest()
  pickFolder.mockClear()
  pickFolder.mockResolvedValue({ canceled: false, filePaths: ['D:\\new-captures'] })
  writeFileMock.mockReset()
  writeFileMock.mockResolvedValue(undefined)
  rootProblem.mockReset()
  rootProblem.mockReturnValue(null)
  setImagePathsMock.mockClear()
  saveSettingsMock.mockClear()
  moveCalls.mockClear()
  imagePaths = [
    { id: 1, filepath: 'C:\\old-captures\\2026-11\\a.png' },
    { id: 2, filepath: 'C:\\old-captures\\2026-11\\b.webm' },
  ]
  settings = { captureRoot: null, previousCaptureRoots: [], language: 'ja' }
  moveImpl = async (params) => { params.commit(params.targets); return { ok: true, moved: params.targets.length, missing: 0 } }
  registerShellHandlers()
})

describe('保存先を選ぶ（storage:chooseRoot）', () => {
  it('移すものがあれば、移さずに件数と容量を返して画面の確認を待つ', async () => {
    const result = await choose()
    expect(result).toEqual({ ok: false, reason: 'needs-confirm', path: 'D:\\new-captures', count: 2, bytes: 2000 })
    expect(moveCalls).not.toHaveBeenCalled()
    expect(saveSettingsMock).not.toHaveBeenCalled()
  })

  it('フォルダを選ばなかったら何もしない', async () => {
    pickFolder.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await choose()).toEqual({ ok: false, reason: 'canceled' })
    expect(saveSettingsMock).not.toHaveBeenCalled()
  })

  it('保存先にできない場所は、理由を返して何もしない', async () => {
    rootProblem.mockReturnValue('drive-root')
    expect(await choose()).toEqual({ ok: false, reason: 'invalid' })
    expect(saveSettingsMock).not.toHaveBeenCalled()
  })

  it('書き込めない場所は、理由を返して何もしない', async () => {
    writeFileMock.mockRejectedValue(new Error('EACCES'))
    expect(await choose()).toEqual({ ok: false, reason: 'unwritable' })
    expect(saveSettingsMock).not.toHaveBeenCalled()
  })

  it('移すものが無ければ、その場で保存先だけ変える', async () => {
    imagePaths = []
    expect(await choose()).toEqual({ ok: true, path: 'D:\\new-captures', moved: 0, missing: 0 })
    expect(saveSettingsMock).toHaveBeenCalledWith(expect.objectContaining({ captureRoot: 'D:\\new-captures' }))
  })
})

describe('確認のあとに移す（storage:moveToRoot）', () => {
  it('移し終えてから保存先を変え、前の場所を控えに残す', async () => {
    settings.captureRoot = 'C:\\old-captures'
    const result = await move('D:\\new-captures')
    expect(result).toEqual({ ok: true, path: 'D:\\new-captures', moved: 2, missing: 0 })
    expect(setImagePathsMock).toHaveBeenCalledTimes(1)
    expect(saveSettingsMock).toHaveBeenCalledWith(expect.objectContaining({
      captureRoot: 'D:\\new-captures', previousCaptureRoots: ['C:\\old-captures'],
    }))
  })

  it('移している途中で失敗したら、保存先を変えない', async () => {
    moveImpl = async () => ({ ok: false, reason: 'failed' })
    expect(await move('D:\\new-captures')).toEqual({ ok: false, reason: 'move-failed' })
    expect(saveSettingsMock).not.toHaveBeenCalled()
  })

  it('移動先に同じ名前のファイルがあったら、どれとぶつかったかを返し、保存先を変えない', async () => {
    moveImpl = async () => ({ ok: false, reason: 'conflict', failedPath: 'D:\\new-captures\\2026-11\\a.png' })
    expect(await move('D:\\new-captures')).toEqual({ ok: false, reason: 'move-conflict', conflictPath: 'D:\\new-captures\\2026-11\\a.png' })
    expect(saveSettingsMock).not.toHaveBeenCalled()
  })

  it('移している途中で「やめて」と言われたら、移動に伝わり、保存先を変えない', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    moveImpl = async (params) => { await gate; return params.isCanceled?.() ? { ok: false, reason: 'canceled' } : { ok: true, moved: 2, missing: 0 } }
    const running = move('D:\\new-captures')
    // 画面の「中止」は移動の進み具合が出てから現れるので、移動が始まってから送る。
    // （始まる前の「やめて」は、前の回の残りとして始めるときに下ろされる。）
    while (moveCalls.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 0))
    await handlers.get('storage:cancelMove')!({})
    release()
    expect(await running).toEqual({ ok: false, reason: 'move-canceled' })
    expect(saveSettingsMock).not.toHaveBeenCalled()
  })

  it('移している最中は、もう一度選んでも移しても、2 つ目は始まらない', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    moveImpl = async (params) => { await gate; params.commit(params.targets); return { ok: true, moved: 2, missing: 0 } }
    const running = move('D:\\new-captures')
    await Promise.resolve()
    expect(await move('D:\\other')).toEqual({ ok: false, reason: 'canceled' })
    expect(await choose()).toEqual({ ok: false, reason: 'canceled' })
    expect(pickFolder).not.toHaveBeenCalled()
    release()
    await running
    expect(moveCalls).toHaveBeenCalledTimes(1)
  })

  it('移している間だけ、終了の確認に載る', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    moveImpl = async () => { await gate; return { ok: true, moved: 2, missing: 0 } }
    const running = move('D:\\new-captures')
    await new Promise((r) => setTimeout(r, 0))
    expect(hasActiveTasks()).toBe(true)
    release()
    await running
    expect(hasActiveTasks()).toBe(false)
  })

  it('選んだあとで書き込めなくなっていたら、移さない', async () => {
    writeFileMock.mockRejectedValue(new Error('drive removed'))
    expect(await move('D:\\new-captures')).toEqual({ ok: false, reason: 'unwritable' })
    expect(moveCalls).not.toHaveBeenCalled()
  })

  it('場所が文字列でなければ移さない', async () => {
    expect(await move(42)).toEqual({ ok: false, reason: 'invalid' })
    expect(await move('')).toEqual({ ok: false, reason: 'invalid' })
    expect(moveCalls).not.toHaveBeenCalled()
  })
})
