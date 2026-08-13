import { describe, expect, it } from 'vitest'
import { normalizeCaptureHotkey } from './hotkey'

describe('normalizeCaptureHotkey', () => {
  describe('正常系', () => {
    it('Alt+S', () => expect(normalizeCaptureHotkey('Alt+S')).toBe('Alt+S'))
    it('小文字を正規化: alt+s → Alt+S', () => expect(normalizeCaptureHotkey('alt+s')).toBe('Alt+S'))
    it('ctrl+alt+s → Ctrl+Alt+S', () => expect(normalizeCaptureHotkey('ctrl+alt+s')).toBe('Ctrl+Alt+S'))
    it('Ctrl+Shift+A', () => expect(normalizeCaptureHotkey('Ctrl+Shift+A')).toBe('Ctrl+Shift+A'))
    it('ファンクションキー: Ctrl+F1', () => expect(normalizeCaptureHotkey('Ctrl+F1')).toBe('Ctrl+F1'))
    it('Alt+F12', () => expect(normalizeCaptureHotkey('Alt+F12')).toBe('Alt+F12'))
    it('数字キー: Alt+0', () => expect(normalizeCaptureHotkey('Alt+0')).toBe('Alt+0'))
    it('別名: option → Alt', () => expect(normalizeCaptureHotkey('option+s')).toBe('Alt+S'))
    it('別名: control → Ctrl', () => expect(normalizeCaptureHotkey('control+s')).toBe('Ctrl+S'))
    it('別名: cmd → Command', () => expect(normalizeCaptureHotkey('cmd+s')).toBe('Command+S'))
    it('重複修飾キーは除去: Alt+Alt+S → Alt+S', () => expect(normalizeCaptureHotkey('Alt+Alt+S')).toBe('Alt+S'))
    it('特殊キー: Alt+Space', () => expect(normalizeCaptureHotkey('Alt+Space')).toBe('Alt+Space'))
    it('特殊キー: Alt+Escape', () => expect(normalizeCaptureHotkey('Alt+Escape')).toBe('Alt+Escape'))
    it('矢印キー: Ctrl+Up', () => expect(normalizeCaptureHotkey('Ctrl+Up')).toBe('Ctrl+Up'))
    it('別名: arrowleft → Left', () => expect(normalizeCaptureHotkey('Ctrl+ArrowLeft')).toBe('Ctrl+Left'))
  })

  describe('異常系', () => {
    it('修飾キーなし → null', () => expect(normalizeCaptureHotkey('S')).toBeNull())
    it('修飾キーのみ → null', () => expect(normalizeCaptureHotkey('Alt+Ctrl')).toBeNull())
    it('禁止キー Plus → null', () => expect(normalizeCaptureHotkey('Alt+Plus')).toBeNull())
    it('不明なキー → null', () => expect(normalizeCaptureHotkey('Alt+Unk')).toBeNull())
    it('空文字 → null', () => expect(normalizeCaptureHotkey('')).toBeNull())
    it('文字列でない: 数値 → null', () => expect(normalizeCaptureHotkey(42)).toBeNull())
    it('null → null', () => expect(normalizeCaptureHotkey(null)).toBeNull())
    it('undefined → null', () => expect(normalizeCaptureHotkey(undefined)).toBeNull())
    it('メインキーが2つ → null', () => expect(normalizeCaptureHotkey('Alt+S+T')).toBeNull())
    it('パーツが6個以上 → null', () => expect(normalizeCaptureHotkey('Alt+Ctrl+Shift+Meta+Super+A')).toBeNull())
  })
})
