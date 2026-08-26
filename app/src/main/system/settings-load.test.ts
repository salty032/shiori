import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SETTINGS_DEFAULTS } from '../../shared/settingsDefaults'

// settings.json が読めなかったときの分岐を確かめる。
//
// **なぜこのテストが要るか** — 「壊れている」と「一瞬読めなかった」を混ぜると、ウイルス対策が
// ファイルを掴んでいた瞬間に起動しただけで、無事な設定が .corrupt- へ退避されて初期値に戻る。
// 画面には「破損していました」としか出ないので、原因を追う手がかりが残らない。
let dir: string

vi.mock('electron', () => ({ app: { getPath: () => dir } }))

// 読み込みを指定回数だけ EPERM で失敗させる。Windows の一時ロックの再現。
let readFailures = 0
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (readFailures > 0) {
        readFailures -= 1
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      }
      return actual.readFileSync(...args)
    },
  }
})

const VALID = JSON.stringify({ theme: 'light', language: 'en' })

function settingsFile(): string {
  return join(dir, 'settings.json')
}

function corruptCopies(): string[] {
  return readdirSync(dir).filter((name) => name.includes('.corrupt-'))
}

// loadSettings は 1 プロセス 1 回しか読まない（_settingsCache）ので、毎回モジュールごと作り直す。
async function freshSettingsModule() {
  vi.resetModules()
  return import('./settings')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shiori-settings-'))
  readFailures = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadSettings の失敗の扱い', () => {
  it('読めれば設定を返し、何も退避しない', async () => {
    writeFileSync(settingsFile(), VALID, 'utf-8')
    const { loadSettings, consumeSettingsLoadProblem } = await freshSettingsModule()

    expect(loadSettings().theme).toBe('light')
    expect(consumeSettingsLoadProblem()).toBeNull()
    expect(corruptCopies()).toHaveLength(0)
  })

  it('一時的に読めなくてもリトライで読み切る（設定は戻らない）', async () => {
    writeFileSync(settingsFile(), VALID, 'utf-8')
    readFailures = 2
    const { loadSettings, consumeSettingsLoadProblem } = await freshSettingsModule()

    expect(loadSettings().theme).toBe('light')
    expect(consumeSettingsLoadProblem()).toBeNull()
    expect(corruptCopies()).toHaveLength(0)
  })

  it('リトライしても読めなければ、ファイルには触らず「読めなかった」と伝える', async () => {
    writeFileSync(settingsFile(), VALID, 'utf-8')
    readFailures = 99
    const { loadSettings, consumeSettingsLoadProblem } = await freshSettingsModule()

    expect(loadSettings().theme).toBe(SETTINGS_DEFAULTS.theme)
    expect(consumeSettingsLoadProblem()).toBe('unreadable')
    // ここが肝心：無事なファイルを退避も改名もしない（原因が消えれば元の設定が戻る）
    expect(existsSync(settingsFile())).toBe(true)
    expect(corruptCopies()).toHaveLength(0)
  })

  it('読めなかったセッションで設定を変えても、元ファイルを上書きしない', async () => {
    writeFileSync(settingsFile(), VALID, 'utf-8')
    readFailures = 99
    const { loadSettings, saveSettings, flushSettings } = await freshSettingsModule()

    loadSettings()
    saveSettings({ theme: 'dark', language: 'ja' })
    await flushSettings()

    // ロックが外れた次回起動で元設定へ戻れることが安全側。今のセッションの変更は一時値。
    readFailures = 0
    const text = await (await import('fs/promises')).readFile(settingsFile(), 'utf8')
    expect(JSON.parse(text)).toEqual({
      theme: 'light', language: 'en'
    })
  })

  it('JSON として壊れているときだけ退避する', async () => {
    writeFileSync(settingsFile(), '{ "theme": "light"', 'utf-8')
    const { loadSettings, consumeSettingsLoadProblem } = await freshSettingsModule()

    expect(loadSettings().theme).toBe(SETTINGS_DEFAULTS.theme)
    expect(consumeSettingsLoadProblem()).toBe('corrupt')
    // 無言で初期化すると次の設定変更で上書きされて復旧不能になるため、中身は残す
    expect(existsSync(settingsFile())).toBe(false)
    expect(corruptCopies()).toHaveLength(1)
  })

  it('設定ファイルが無い（新規インストール）ときは何も言わない', async () => {
    const { loadSettings, consumeSettingsLoadProblem } = await freshSettingsModule()

    expect(loadSettings().theme).toBe(SETTINGS_DEFAULTS.theme)
    expect(consumeSettingsLoadProblem()).toBeNull()
    expect(corruptCopies()).toHaveLength(0)
  })
})
