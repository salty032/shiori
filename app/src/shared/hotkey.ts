// キャプチャホットキーの正規化・検証。main（実際の登録・最終防衛）と renderer
// （SettingsModal のキー入力キャプチャ）の両方から使う単一の情報源（Q4）。
// ここに electron/node 依存を持ち込むと renderer から import できなくなるため、
// 純粋関数のみを置く。
const MODIFIER_ALIASES = new Map<string, string>([
  ['ctrl', 'Ctrl'],
  ['control', 'Ctrl'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
  ['shift', 'Shift'],
  ['cmd', 'Command'],
  ['command', 'Command'],
  ['meta', 'Meta'],
  ['super', 'Super'],
  ['cmdorctrl', 'CommandOrControl'],
  ['commandorcontrol', 'CommandOrControl']
])

const NAMED_KEYS = new Map<string, string>([
  ['space', 'Space'],
  ['tab', 'Tab'],
  ['enter', 'Enter'],
  ['return', 'Return'],
  ['escape', 'Escape'],
  ['esc', 'Escape'],
  ['backspace', 'Backspace'],
  ['delete', 'Delete'],
  ['insert', 'Insert'],
  ['home', 'Home'],
  ['end', 'End'],
  ['pageup', 'PageUp'],
  ['pagedown', 'PageDown'],
  ['up', 'Up'],
  ['down', 'Down'],
  ['left', 'Left'],
  ['right', 'Right'],
  ['arrowup', 'Up'],
  ['arrowdown', 'Down'],
  ['arrowleft', 'Left'],
  ['arrowright', 'Right']
])

const DISALLOWED_KEYS = new Set(['Plus', '+'])

// extension/background.js の NAMED_CAPTURE_KEYS（バンドラ無しのためコピー実装）と対になる
// 正規化後キー名の集合。片側だけキーを増減すると静かに食い違うため、ws-server.test.ts の
// パリティテストがここと background.js のテキストを比較して検知する（M-1）。
export const NAMED_CAPTURE_KEY_VALUES = new Set(NAMED_KEYS.values())

function normalizeMainKey(value: string): string | null {
  if (/^[a-z]$/i.test(value)) return value.toUpperCase()
  if (/^[0-9]$/.test(value)) return value
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(value)) return value.toUpperCase()
  return NAMED_KEYS.get(value.toLowerCase()) ?? null
}

// 正規化済みホットキー文字列（例 "Alt+S"）からメインキー（例 "S"）だけを取り出す。
// content.js のキー抑止（suppressCaptureKey）が実際のホットキーに追随するために使う。
export function captureHotkeyMainKey(hotkey: string): string {
  const parts = hotkey.split('+')
  return parts[parts.length - 1] ?? 'S'
}

export function normalizeCaptureHotkey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length < 2 || parts.length > 5) return null

  const modifiers: string[] = []
  let mainKey: string | null = null

  for (const part of parts) {
    if (DISALLOWED_KEYS.has(part)) return null
    const modifier = MODIFIER_ALIASES.get(part.toLowerCase())
    if (modifier) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier)
      continue
    }

    const key = normalizeMainKey(part)
    if (!key || mainKey) return null
    mainKey = key
  }

  return modifiers.length > 0 && mainKey ? [...modifiers, mainKey].join('+') : null
}
