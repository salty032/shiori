// 録画クリップ開始/停止用のグローバルホットキー登録。
import { globalShortcut } from 'electron'

let currentClipHotkey = 'Alt+R'

export function registerClipHotkey(hotkey: string, onToggle: () => void, onError?: (message: string) => void): boolean {
  const ok = globalShortcut.register(hotkey, onToggle)
  if (!ok) {
    console.warn(`[clip] hotkey ${hotkey} registration failed`)
    onError?.(`録画ホットキー ${hotkey} を登録できませんでした。他のアプリで使われている可能性があります。`)
  } else {
    currentClipHotkey = hotkey
    console.log(`[clip] hotkey registered: ${hotkey}`)
  }
  return ok
}

export function unregisterClipHotkey(): void {
  globalShortcut.unregister(currentClipHotkey)
}

export function changeClipHotkey(newHotkey: string, onToggle: () => void, onError?: (message: string) => void): boolean {
  const previousHotkey = currentClipHotkey
  unregisterClipHotkey()
  const ok = registerClipHotkey(newHotkey, onToggle, onError)
  if (!ok) registerClipHotkey(previousHotkey, onToggle)
  return ok
}
