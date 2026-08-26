import { beforeEach, describe, expect, it, vi } from 'vitest'

const { initDb, showErrorBox } = vi.hoisted(() => ({
  initDb: vi.fn(),
  showErrorBox: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { relaunch: vi.fn(), exit: vi.fn() },
  dialog: { showErrorBox, showMessageBoxSync: vi.fn() },
}))
vi.mock('../db-schema', () => ({
  initDb,
  databasePath: () => '/mock/userData/Shiori.db',
}))
vi.mock('./i18n', () => ({
  currentLang: () => 'ja',
  t: (key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params ?? {})}`,
}))

import { openDatabaseOrRecover } from './db-startup'
import { DatabaseMigrationBackupError, DatabaseVersionTooNewError } from './db-maintenance'

beforeEach(() => {
  initDb.mockReset()
  showErrorBox.mockReset()
})

describe('更新時にDBへ書き込まず停止する分岐', () => {
  it('新しいDBを旧版で開いた場合は、最新版へ戻す案内を出す', () => {
    initDb.mockImplementation(() => { throw new DatabaseVersionTooNewError(4, 3) })

    expect(openDatabaseOrRecover()).toBe(false)
    expect(showErrorBox).toHaveBeenCalledWith(
      'Shiori', expect.stringContaining('error.dbVersionTooNew')
    )
  })

  it('構造変更前バックアップが失敗した場合は、移行せず空き容量の案内を出す', () => {
    initDb.mockImplementation(() => {
      throw new DatabaseMigrationBackupError('/mock/userData/Shiori.db')
    })

    expect(openDatabaseOrRecover()).toBe(false)
    expect(showErrorBox).toHaveBeenCalledWith(
      'Shiori', expect.stringContaining('error.dbMigrationBackupFailed')
    )
  })
})
