import type { Settings } from './types'

// main の DEFAULTS と renderer の初期表示値が別々に手書きされていると、片方だけ変えたときに
// 初回描画の暫定値がズレる（C-4）。allowedExtensionIds だけは main 側で拡張IDを注入するため
// ここでは空配列にしておく。
// サムネイルの大きさの 3 段（グリッドの最小セル幅 px）。サイドバーの S/M/L と、旧値の読み替え先
// （main の settings.ts）がここを読む。
// 数値は「全画面でも見える」を優先して 120/160/220 から引き上げてある。
// 1920幅の全画面（サイドバー210）で S=10列 / M=7列 / L=5列 になる並び。
export const THUMB_SIZE_STEPS = { S: 150, M: 230, L: 320 } as const

// コマ送りの fps として受け付ける範囲。設定の読み込み（main の settings.ts）と設定画面の入力欄が同じ値で切る。
export const SETTINGS_DEFAULTS: Settings = {
  // 既定は「中」。段のどれかを指さないと、既定で開いたときに S/M/L のどれも選ばれていない見た目になる。
  thumbnailSize: THUMB_SIZE_STEPS.M,
  smartFolders: [],
  captureHotkey: 'Alt+S',
  clipHotkey: 'Alt+D',
  clipMaxSeconds: 30,
  clipNotify: true,
  captureNotify: true,
  // 既定は従来どおり常駐させる。開くたびに読み込み直す代償は、選んだ人にだけ払わせる。
  lowMemoryMode: false,
  allowedExtensionIds: [],
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
