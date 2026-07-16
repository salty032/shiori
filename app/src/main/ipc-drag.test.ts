import { vi, describe, expect, it } from 'vitest'
import { join, resolve } from 'path'

const { MOCK_TEMP } = vi.hoisted(() => ({ MOCK_TEMP: '/mock/temp' }))

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue(MOCK_TEMP) },
  nativeImage: { createFromPath: vi.fn(), createEmpty: vi.fn() },
}))
vi.mock('./db', () => ({ getImage: vi.fn() }))
vi.mock('./windows', () => ({ onTrusted: vi.fn() }))

import { isDragTempPath } from './ipc-drag'

// paths.test.ts と同じ理由で期待値も resolve() を通す（Windows ではドライブが補われる）。
const DRAG_DIR = resolve(MOCK_TEMP, 'shiori-drag')

// isDragTempPath が偽陰性を出すと、Shiori から出した画像を Shiori に落とし返したときに
// 同じ画像が二重に取り込まれる。偽陽性を出すと、ユーザーの本物のファイルが黙って
// 取り込まれなくなる。どちらも静かに壊れるためパス判定だけは固定しておく。
describe('isDragTempPath', () => {
  it('ドラッグ用 temp 直下の複製 → true（取り込みから除外される）', () => {
    expect(isDragTempPath(join(DRAG_DIR, 'title_20260716_120000.png'))).toBe(true)
  })

  it('ライブラリの原本 → false（ここを誤ると通常の取り込みが壊れる）', () => {
    expect(isDragTempPath(resolve('/mock/userData/captures/2026-07/cap_1.png'))).toBe(false)
  })

  it('ユーザーが temp 隣に置いた別ファイル → false', () => {
    expect(isDragTempPath(join(resolve(MOCK_TEMP), 'shiori-drag-memo.png'))).toBe(false)
  })

  it('ドラッグ用 temp ディレクトリ自体 → false', () => {
    expect(isDragTempPath(DRAG_DIR)).toBe(false)
  })

  it('.. で temp の外を指すパス → false', () => {
    expect(isDragTempPath(join(DRAG_DIR, '..', '..', 'evil.png'))).toBe(false)
  })
})
