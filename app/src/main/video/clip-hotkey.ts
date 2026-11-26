// 録画クリップ開始/停止用のグローバルホットキー登録。登録・変更の実装は静止画と共通（hotkey-slot.ts）。
import { t } from '../system/i18n'
import { createHotkeySlot } from '../system/hotkey-slot'

const clipHotkey = createHotkeySlot({
  logTag: 'clip',
  initialHotkey: 'Alt+D',
  failedMessage: (hotkey) => t('error.clipHotkeyRegisterFailed', { hotkey }),
})

export function registerClipHotkey(hotkey: string, onToggle: () => void, onRegisterError?: (message: string) => void): boolean {
  return clipHotkey.register(hotkey, onToggle, onRegisterError)
}

export function changeClipHotkey(newHotkey: string, onRegisterError?: (message: string) => void): boolean {
  return clipHotkey.change(newHotkey, onRegisterError)
}
