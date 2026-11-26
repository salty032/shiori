// グローバルホットキー 1 つぶんの登録と変更。**静止画（capture.ts）と録画（clip-hotkey.ts）で同じ実装を使う。**
// 別々に書いていた頃は、変更に失敗して元のキーへ戻すのにも失敗したとき、静止画側だけが知らせ、
// 録画側は黙ってホットキーを失っていた。
//
// ここで知らせるのは「登録できなかった」ことだけ。押したあとの処理（撮影・録画）の失敗は呼び出し側で出す
// ——同じ口から出すと、登録失敗の重複を抑える仕組み（notify-until-fixed.ts）に撮影の失敗まで抑えられる。
import { globalShortcut } from 'electron'

export interface HotkeySlot {
  register: (hotkey: string, onPress: () => void, onRegisterError?: (message: string) => void) => boolean
  // 新しいキーで登録し直す。登録できなければ元のキーへ戻し、戻せなかったことも onRegisterError で知らせる。
  change: (hotkey: string, onRegisterError?: (message: string) => void) => boolean
}

export function createHotkeySlot(opts: {
  logTag: string
  initialHotkey: string
  failedMessage: (hotkey: string) => string
}): HotkeySlot {
  let current = opts.initialHotkey
  let currentOnPress: () => void = () => {}

  function register(hotkey: string, onPress: () => void, onRegisterError?: (message: string) => void): boolean {
    currentOnPress = onPress
    const ok = globalShortcut.register(hotkey, onPress)
    if (!ok) {
      console.warn(`[${opts.logTag}] hotkey ${hotkey} registration failed`)
      onRegisterError?.(opts.failedMessage(hotkey))
    } else {
      current = hotkey
      console.log(`[${opts.logTag}] hotkey registered: ${hotkey}`)
    }
    return ok
  }

  function change(hotkey: string, onRegisterError?: (message: string) => void): boolean {
    const previous = current
    globalShortcut.unregister(previous)
    const ok = register(hotkey, currentOnPress, onRegisterError)
    if (!ok) register(previous, currentOnPress, onRegisterError)
    return ok
  }

  return { register, change }
}
