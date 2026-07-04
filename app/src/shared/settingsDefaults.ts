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
  captureNotify: true,
  allowedExtensionIds: [],
  serviceOrder: [],
}
