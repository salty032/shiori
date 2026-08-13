// 終了時の設定フラッシュ（flushSettings）の回帰テスト。
// saveSettings はディスク反映を待たずに返るため、フラッシュ無しで終了すると
// 最後の設定変更だけが巻き戻る。normalizeSettings 側の純粋なテストとは
// fs のモックが必要な点が違うので、settings.test.ts とはファイルを分けている。
import { vi, describe, expect, it, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/userData') } }))
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  renameSync: vi.fn()
}))

const writeFile = vi.fn<(path: string, data: string, enc: string) => Promise<void>>()
const rename = vi.fn<(from: string, to: string) => Promise<void>>()
const unlink = vi.fn<(path: string) => Promise<void>>()

vi.mock('fs/promises', () => ({
  writeFile: (...args: unknown[]) => writeFile(...(args as Parameters<typeof writeFile>)),
  rename: (...args: unknown[]) => rename(...(args as Parameters<typeof rename>)),
  unlink: (...args: unknown[]) => unlink(...(args as Parameters<typeof unlink>))
}))

// settings.ts は _persistChain / _settingsCache をモジュール変数で持つため、
// テスト間で引きずらないよう毎回読み込み直す。
async function freshSettings(): Promise<typeof import('./settings')> {
  vi.resetModules()
  return import('./settings')
}

beforeEach(() => {
  writeFile.mockReset().mockResolvedValue(undefined)
  rename.mockReset().mockResolvedValue(undefined)
  unlink.mockReset().mockResolvedValue(undefined)
})

describe('flushSettings', () => {
  it('書き込みが終わるまで解決しない（終了前に await すれば巻き戻らない）', async () => {
    const { saveSettings, flushSettings } = await freshSettings()

    let finishWrite: () => void = () => {}
    writeFile.mockImplementation(() => new Promise<void>((resolve) => { finishWrite = () => resolve() }))

    saveSettings({ theme: 'light' })

    let flushed = false
    const pending = flushSettings().then(() => { flushed = true })

    await Promise.resolve()
    expect(flushed).toBe(false)   // 書き込み中はまだ待たせる

    finishWrite()
    await pending
    expect(flushed).toBe(true)
    expect(rename).toHaveBeenCalled()  // tmp → 本体の差し替えまで完了している
  })

  it('最後に保存した値がディスクへ書かれている', async () => {
    const { saveSettings, flushSettings } = await freshSettings()

    saveSettings({ theme: 'light', thumbnailSize: 200 })
    saveSettings({ theme: 'system', thumbnailSize: 240 })
    await flushSettings()

    const lastWritten = writeFile.mock.calls.at(-1)?.[1] as string
    expect(JSON.parse(lastWritten)).toMatchObject({ theme: 'system', thumbnailSize: 240 })
  })

  it('連続保存を積んでもすべて書き終えてから解決する', async () => {
    const { saveSettings, flushSettings } = await freshSettings()

    saveSettings({ theme: 'light' })
    saveSettings({ theme: 'dark' })
    saveSettings({ theme: 'system' })
    await flushSettings()

    expect(rename).toHaveBeenCalledTimes(3)
  })

  // persistToDisk は永続化失敗を握り潰す設計（saveSettings を throw させない）。
  // flushSettings が reject すると before-quit の finally 経路が乱れるので、
  // 失敗時も必ず解決すること。
  it('書き込みが失敗しても reject せず解決する', async () => {
    const { saveSettings, flushSettings } = await freshSettings()

    writeFile.mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }))

    saveSettings({ theme: 'light' })
    await expect(flushSettings()).resolves.toBeUndefined()
  })

  it('保存していなければ即座に解決する', async () => {
    const { flushSettings } = await freshSettings()

    await expect(flushSettings()).resolves.toBeUndefined()
    expect(writeFile).not.toHaveBeenCalled()
  })
})
