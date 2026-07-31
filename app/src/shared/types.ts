// Shared between main/preload and renderer. No DOM or Node APIs — pure data types only.

// 表示言語。日英の 2 択に固定する（汎用のロケール解決は持たない）。
// i18n/index.ts 側はここから読む。逆向きに import すると、型定義を使いたいだけの
// モジュールが辞書 2 枚を巻き込むことになるため、定義元はこちらに置く。
export type Lang = 'ja' | 'en'

export type TagMode = 'and' | 'or'
export type SortOrder = 'date_desc' | 'date_asc' | 'random'
export type ImageTagSource = 'manual' | 'ai'
export type ImageSource = 'capture' | 'import'

// レンダラーへ公開する画像行の唯一の契約。DB 専用カラム（width/height/host）は
// 含めない。main 側の完全な DB 行（db.ts の ImageRow）はこの型を拡張して定義する。
export type ImageRow = {
  id: number
  filepath: string
  captured_at: number
  title: string | null
  current_time: number | null
  url: string | null
  colors: string | null
  memo: string | null
  media_type: 'image' | 'video' | null
  duration: number | null
  fps: number | null
  thumb_path: string | null
  source: ImageSource
}

export type ImageTag = { name: string; source: ImageTagSource }

// ライブラリ全体のタグ一覧（listAllTags）専用。count はそのタグが付いている画像の枚数。
// サイドバーは「枚数がしきい値以上のタグ」を出すため件数を必要とする（順位で切ると、
// 画像を足すたびに順位が動いて境界のタグが出たり消えたりする）。
export type TagWithCount = ImageTag & { count: number }

export type SmartFolder = {
  id: string
  name: string
  tags: string[]
  tagMode: TagMode
  site: string | null
  search: string
}

export type Theme = 'system' | 'dark' | 'light'

export type Settings = {
  titleStrip: string[]
  thumbnailSize: number
  frameFps: number
  frameFpsAuto: boolean
  smartFolders: SmartFolder[]
  captureHotkey: string
  clipHotkey: string
  clipMaxSeconds: number
  clipNotify: boolean
  captureNotify: boolean
  allowedExtensionIds: string[]
  serviceOrder: string[]
  showAiTags: boolean
  theme: Theme
  // 表示言語。新規インストール時のみ OS ロケールから決まり（main/settings.ts の
  // osDefaultLang）、以降はユーザーが設定画面で選んだ値をそのまま保持する。
  // 既存の settings.json に language が無い場合は 'ja'（従来の挙動）へ倒す。
  language: Lang
  // 前回起動時のアプリバージョン。起動時に現行バージョンと比較し、自動アップデートが
  // （サイレント適用も含め）行われたことを一度だけ通知するために使う。初回起動は null。
  lastRunVersion: string | null
}

// 一覧のフィルタ条件。renderer が組み立て、main が検証し、SQL に落とすまでの
// 「フィルタとは何か」を表す唯一の契約。位置引数で各層に散らさず、この型で受け渡す。
export type ImageQuery = {
  search?: string
  after?: number
  site?: string
  mediaType?: 'image' | 'video'
  tags?: string[]
  tagMode?: TagMode
  toDate?: number
}

// グリッド一覧のカーソルページング込みの取得リクエスト。
// before/beforeId は「この位置より後ろ」を表すカーソル。listImages にのみ渡す。
export type ImageListRequest = ImageQuery & {
  limit?: number
  before?: number
  beforeId?: number
  sortOrder?: SortOrder
}

export type CaptureData = { id: number | null; imagePath: string }
export type DeleteImageResult = { ok: true; id: number } | { ok: false; id: number; error: string }
export type ExtensionTimecode = {
  title: string
  currentTime: number | null
  url: string | null
  // インストール済み拡張が、アプリにバンドルされた最新版と食い違っているかどうか
  // （main 側で version と bundled 版を比較して算出。UX-9）。
  versionMismatch?: boolean
}
export type AppNotice = { level: 'info' | 'warning' | 'error'; message: string }
export type WhatsNewData = { version: string; notes: string[] }
