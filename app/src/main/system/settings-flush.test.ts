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

// 保存 IPC はディスク反映を待たずに成功で返る（そうしないと、AV の一時的なロックのたびに
// renderer が楽観更新を巻き戻して「設定がたまに反映されない」になる）。その代わり、
// 書き込みを諦めたことは必ず外へ出す——黙って諦めると、症状は次に起動したときの
// 「設定が戻っている」だけになり、利用者にも原因が辿れない。
describe('永続化を諦めたときの通知', () => {
  // ENOSPC は一時的なロックではないのでリトライ待ち（最大 800ms）に入らず、
  // すぐ最終手段の直接書き込みへ進む。テストを待たせないための選択。
  const fatal = (): Promise<never> => Promise.reject(Object.assign(new Error('no space'), { code: 'ENOSPC' }))

  it('リトライを使い切ったら知らせる', async () => {
    const { saveSettings, flushSettings, onSettingsPersistFailed } = await freshSettings()
    const notified = vi.fn()
    onSettingsPersistFailed(notified)

    writeFile.mockImplementation(fatal)
    saveSettings({ theme: 'light' })
    await flushSettings()

    expect(notified).toHaveBeenCalledTimes(1)
  })

  it('続けて失敗しても同じ知らせは重ねない', async () => {
    const { saveSettings, flushSettings, onSettingsPersistFailed } = await freshSettings()
    const notified = vi.fn()
    onSettingsPersistFailed(notified)

    writeFile.mockImplementation(fatal)
    saveSettings({ theme: 'light' })
    await flushSettings()
    saveSettings({ theme: 'dark' })
    await flushSettings()

    expect(notified).toHaveBeenCalledTimes(1)
  })

  it('一度書けたら状態は戻り、次に失敗したらまた知らせる', async () => {
    const { saveSettings, flushSettings, onSettingsPersistFailed } = await freshSettings()
    const notified = vi.fn()
    onSettingsPersistFailed(notified)

    writeFile.mockImplementation(fatal)
    saveSettings({ theme: 'light' })
    await flushSettings()

    writeFile.mockResolvedValue(undefined)
    saveSettings({ theme: 'dark' })
    await flushSettings()

    writeFile.mockImplementation(fatal)
    saveSettings({ theme: 'system' })
    await flushSettings()

    expect(notified).toHaveBeenCalledTimes(2)
  })

  it('書けなくてもセッション内の値は確定している', async () => {
    const { saveSettings, flushSettings, loadSettings } = await freshSettings()

    writeFile.mockImplementation(fatal)
    // 180 のような旧 S/M/L の値を使うと normalizeSettings の読み替えに巻き込まれ、
    // 「書けなかった」ではなく読み替えで落ちるテストになる。無関係な値を使う。
    saveSettings({ theme: 'light', thumbnailSize: 200 })
    await flushSettings()

    expect(loadSettings().thumbnailSize).toBe(200)
  })
})
