import { vi, describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn(), getAppPath: vi.fn() }, Notification: vi.fn() }))

import { copyExtensionUpdate } from './extension-updater'

// copyDir は上書き専用なので、prune が無いと旧バージョンの残骸が永久に溜まる。
describe('copyExtensionUpdate', () => {
  let root: string
  let src: string
  let dest: string

  const write = (dir: string, rel: string, body: string): void => {
    const path = join(dir, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shiori-ext-test-'))
    src = join(root, 'bundled')
    dest = join(root, 'installed')
    mkdirSync(src, { recursive: true })
    mkdirSync(dest, { recursive: true })
    write(src, 'manifest.json', '{"version":"0.5.0"}')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('新バージョンで消えたファイルを削除する', () => {
    write(dest, 'old-content.js', 'stale')
    write(src, 'content.js', 'fresh')

    copyExtensionUpdate(src, dest)

    expect(existsSync(join(dest, 'old-content.js'))).toBe(false)
    expect(existsSync(join(dest, 'content.js'))).toBe(true)
  })

  it('サブディレクトリの中も再帰的に prune する', () => {
    write(dest, 'icons/old.png', 'stale')
    write(src, 'icons/new.png', 'fresh')

    copyExtensionUpdate(src, dest)

    expect(existsSync(join(dest, 'icons', 'old.png'))).toBe(false)
    expect(existsSync(join(dest, 'icons', 'new.png'))).toBe(true)
  })

  it('バンドル側から消えたディレクトリを丸ごと削除する', () => {
    write(dest, 'legacy/a.js', 'stale')

    copyExtensionUpdate(src, dest)

    expect(existsSync(join(dest, 'legacy'))).toBe(false)
  })

  it('manifest.json はコミットマーカーとして最後に置かれる（prune で消さない）', () => {
    write(dest, 'manifest.json', '{"version":"0.4.0"}')

    copyExtensionUpdate(src, dest)

    expect(existsSync(join(dest, 'manifest.json'))).toBe(true)
  })

  it('初回インストール（dest が空）でも動く', () => {
    write(src, 'content.js', 'fresh')

    copyExtensionUpdate(src, dest)

    expect(existsSync(join(dest, 'content.js'))).toBe(true)
    expect(existsSync(join(dest, 'manifest.json'))).toBe(true)
  })
})
