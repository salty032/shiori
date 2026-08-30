import { vi, describe, expect, it, afterEach } from 'vitest'
import { join, resolve } from 'path'

const { MOCK_USER_DATA } = vi.hoisted(() => ({ MOCK_USER_DATA: '/mock/userData' }))

vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue(MOCK_USER_DATA) } }))

// 保存先は設定から来る。既定（captureRoot=null）で始め、テストごとに差し替える。
const { settings } = vi.hoisted(() => ({
  settings: { captureRoot: null as string | null, previousCaptureRoots: [] as string[] }
}))
vi.mock('./settings', () => ({ loadSettings: () => settings }))

import { resolveCapturePath } from './paths'

// resolveCapturePath 内部は resolve() で絶対化するため、期待値も resolve() を通す
// （Windows では resolve('/mock/userData') がカレントドライブを補って C:\mock\userData になる）。
const CAPTURE_DIR = resolve(MOCK_USER_DATA, 'captures')

describe('resolveCapturePath', () => {
  it('captureDir 直下の正常パス → そのまま解決', () => {
    const p = join(CAPTURE_DIR, 'cap_123.png')
    expect(resolveCapturePath(p)).toBe(p)
  })

  it('年月サブフォルダ配下も許可', () => {
    const p = join(CAPTURE_DIR, '2026-07', 'cap_123.png')
    expect(resolveCapturePath(p)).toBe(p)
  })

  it('.. を含むトラバーサルは拒否', () => {
    const p = join(CAPTURE_DIR, '..', 'evil.png')
    expect(resolveCapturePath(p)).toBeNull()
  })

  it('captureDir 自体(rel === "")は拒否', () => {
    expect(resolveCapturePath(CAPTURE_DIR)).toBeNull()
  })

  it('兄弟ディレクトリ(prefix一致だが実際は別ディレクトリ)は拒否', () => {
    const p = join(MOCK_USER_DATA, 'captures-evil', 'x.png')
    expect(resolveCapturePath(p)).toBeNull()
  })

  it('許可外拡張子は拒否', () => {
    const p = join(CAPTURE_DIR, 'cap_123.txt')
    expect(resolveCapturePath(p)).toBeNull()
  })

  it('動画拡張子(webm/mp4)は許可する', () => {
    const webm = join(CAPTURE_DIR, 'clip.webm')
    const mp4 = join(CAPTURE_DIR, 'clip.mp4')
    expect(resolveCapturePath(webm)).toBe(webm)
    expect(resolveCapturePath(mp4)).toBe(mp4)
  })

  it('thumbnailDir 配下も許可(サムネと原本の両方が許可ベース)', () => {
    const p = resolve(MOCK_USER_DATA, 'thumbnails', 'cap_123_t.jpg')
    expect(resolveCapturePath(p)).toBe(p)
  })

  it('非文字列入力(number)は拒否', () => {
    expect(resolveCapturePath(123)).toBeNull()
  })

  it('非文字列入力(null)は拒否', () => {
    expect(resolveCapturePath(null)).toBeNull()
  })

  it('非文字列入力(undefined)は拒否', () => {
    expect(resolveCapturePath(undefined)).toBeNull()
  })

  it('空文字は拒否', () => {
    expect(resolveCapturePath('')).toBeNull()
  })
})

// 保存先を変えても、それまでに撮ったものは開けなければならない。**記録しているのは
// 絶対パスなので、許可を今の保存先だけに絞ると、変えた瞬間に全部開けなくなる。**
describe('保存先を変えたとき', () => {
  afterEach(() => {
    settings.captureRoot = null
    settings.previousCaptureRoots = []
  })

  it('新しい保存先の配下を許可する', () => {
    settings.captureRoot = resolve('/mock/other/captures')
    const p = join(resolve('/mock/other/captures'), '2026-08', 'cap_1.png')
    expect(resolveCapturePath(p)).toBe(p)
  })

  it('既定の場所は、保存先を変えた後も開ける', () => {
    settings.captureRoot = resolve('/mock/other/captures')
    const p = join(CAPTURE_DIR, 'cap_1.png')
    expect(resolveCapturePath(p)).toBe(p)
  })

  it('過去に使った保存先も開ける', () => {
    settings.captureRoot = resolve('/mock/other/captures')
    settings.previousCaptureRoots = [resolve('/mock/old/captures')]
    const p = join(resolve('/mock/old/captures'), 'cap_1.png')
    expect(resolveCapturePath(p)).toBe(p)
  })

  it('どの保存先でもない場所は拒否する', () => {
    settings.captureRoot = resolve('/mock/other/captures')
    expect(resolveCapturePath(join(resolve('/mock/elsewhere'), 'cap_1.png'))).toBeNull()
  })
})
