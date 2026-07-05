import { vi, describe, expect, it } from 'vitest'
import { join, resolve } from 'path'

const { MOCK_USER_DATA } = vi.hoisted(() => ({ MOCK_USER_DATA: '/mock/userData' }))

vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue(MOCK_USER_DATA) } }))

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

  it('画像専用ビルドは動画拡張子(webm/mp4)を拒否', () => {
    expect(resolveCapturePath(join(CAPTURE_DIR, 'clip.webm'))).toBeNull()
    expect(resolveCapturePath(join(CAPTURE_DIR, 'clip.mp4'))).toBeNull()
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
