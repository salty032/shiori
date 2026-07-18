import type { Settings } from './types'

// main の DEFAULTS と renderer の初期表示値が別々に手書きされていると、片方だけ変えたときに
// 初回描画の暫定値がズレる（C-4）。allowedExtensionIds だけは main 側で拡張IDを注入するため
// ここでは空配列にしておく。
export const SETTINGS_DEFAULTS: Settings = {
  titleStrip: [],
  thumbnailSize: 160,
  frameFps: 24,
  frameFpsAuto: true,
  smartFolders: [],
  captureHotkey: 'Alt+S',
  clipHotkey: 'Alt+R',
  clipMaxSeconds: 60,
  clipNotify: true,
  captureNotify: true,
  allowedExtensionIds: [],
  serviceOrder: [],
  showAiTags: false,
  // UX-7: OSのライト/ダーク設定に自動追従する 'system' を新規インストール時の初期値にする。
  // 無効値・破損設定からの復旧時のフォールバック（settings.ts の themeValue）は
  // 従来通り 'dark' のまま変更しない（挙動が変わるのは初回起動時のみ）。
  theme: 'system',
  lastRunVersion: null,
}
