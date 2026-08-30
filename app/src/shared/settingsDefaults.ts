import type { Settings } from './types'

// main の DEFAULTS と renderer の初期表示値が別々に手書きされていると、片方だけ変えたときに
// 初回描画の暫定値がズレる（C-4）。allowedExtensionIds だけは main 側で拡張IDを注入するため
// ここでは空配列にしておく。
export const SETTINGS_DEFAULTS: Settings = {
  titleStrip: [],
  // グリッドの最小セル幅。Sidebar の THUMB_SIZES の M と同じ値にしておく
  // （既定で開いたときに S/M/L のどれも選ばれていない見た目になるのを避ける）。
  thumbnailSize: 230,
  frameFps: 24,
  frameFpsAuto: true,
  smartFolders: [],
  captureHotkey: 'Alt+S',
  clipHotkey: 'Alt+D',
  clipMaxSeconds: 30,
  clipNotify: true,
  captureNotify: true,
  allowedExtensionIds: [],
  serviceOrder: [],
  showAiTags: false,
  // UX-7: OSのライト/ダーク設定に自動追従する 'system' を新規インストール時の初期値にする。
  // 無効値・破損設定からの復旧時のフォールバック（settings.ts の themeValue）は
  // 従来通り 'dark' のまま変更しない（挙動が変わるのは初回起動時のみ）。
  theme: 'system',
  // 静的な既定は 'ja'。新規インストール時だけ main/settings.ts が OS ロケールを見て
  // 上書きするため、ここを 'en' にしても新規ユーザーの初期値は変わらない。
  // この値が実際に効くのは「settings.json はあるが language キーが無い」＝
  // 言語設定より前のバージョンからのアップグレード組で、従来どおり日本語で起動させる。
  language: 'ja',
  // 既定は「そのまま」。H.264 は非可逆の作り直しなので、更新しただけで今までと違う
  // ファイルが出るようにはしない（設定で選んだ人にだけ変換が起きる）。
  videoExportFormat: 'original',
  // 既定は「引き伸ばしぶんを保存しない」。**細かさは 1 ドットも減らない**ので、
  // 更新しただけでこれに変わっても誰も細かさを失わない（4K 画面で 1080p 配信を撮ると
  // ファイルが約 1/4 になるだけ）。本物の細かさが落ちる 'fhd'/'hd' は自分で選んだときだけ。
  captureResize: 'source',
  captureRoot: null,
  previousCaptureRoots: [],
  lastRunVersion: null,
}
