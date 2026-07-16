// OS 自動起動（ログイン時起動）の設定と、その起動かどうかの判定を集約する。
// 自動起動ではウィンドウを出さずトレイ常駐で待機したいので、登録時に目印となる
// 引数を渡し、起動時にそれを見て初期表示を切り替える。
import { app } from 'electron'

// 自動起動で立ち上がったことを示す目印。Windows ではレジストリの Run エントリに
// この引数付きで登録されるため、process.argv を見れば手動起動と区別できる。
const HIDDEN_FLAG = '--hidden'

export function isStartupLaunch(): boolean {
  // macOS は引数が渡らないため wasOpenedAtLogin も見る
  return process.argv.includes(HIDDEN_FLAG) || app.getLoginItemSettings().wasOpenedAtLogin === true
}

// Windows の openAtLogin は「exe パス＋引数」が一致したときだけ true になる。旧バージョンが
// 引数なしで登録したエントリを「無効」と誤判定しないよう、exe の起動有無も見る。
export function isOpenAtLogin(): boolean {
  const settings = app.getLoginItemSettings({ args: [HIDDEN_FLAG] })
  return settings.openAtLogin || settings.executableWillLaunchAtLogin === true
}

export function setOpenAtLogin(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true, // macOS 用
    args: [HIDDEN_FLAG] // Windows 用
  })
}

// 旧バージョンで登録されたエントリには目印の引数が無く、自動起動でもウィンドウが開いて
// しまう。引数付きで登録し直して補う（パッケージ版のみ。開発時は electron.exe のパスが
// 書き込まれてしまうため触らない）。
export function migrateStartupArgs(): void {
  if (!app.isPackaged) return
  const settings = app.getLoginItemSettings({ args: [HIDDEN_FLAG] })
  if (settings.openAtLogin || !settings.executableWillLaunchAtLogin) return
  setOpenAtLogin(true)
}
