// preload が公開する window.api の唯一の型定義（単一の信頼できる情報源）。
// preload はこの型で実装を縛られ、renderer はこの型を Window.api として宣言する。
// 片方だけ変更すると型エラーになるため、両者がズレることはない。
import type {
  ImageRow, ImageTag, TagWithCount, ImageTagSource, Settings,
  CaptureData, ExtensionTimecode, AppNotice, WhatsNewData, StorageInfo,
  ImageQuery, ImageListRequest, DeleteImageResult,
} from './types'

export interface ShioriApi {
  listImages: (req: ImageListRequest) => Promise<ImageRow[]>
  countImages: (query: ImageQuery) => Promise<number>
  listAllImages: (query: ImageQuery) => Promise<ImageRow[]>
  listSites: () => Promise<string[]>
  listAllTags: (includeAi?: boolean) => Promise<TagWithCount[]>
  exportImages: (imageIds: number[]) => Promise<{ canceled: boolean; count?: number; truncated?: boolean }>
  // 進行中の imagesExport を中断する（数百枚規模のコピーが分単位になりうるため）。
  // count が届いている exportImages の戻り値と canceled: true の組み合わせで
  // 「途中まで書き出し済み」を判別する（フォルダ選択自体のキャンセルは count なし）。
  imagesExportCancel: () => Promise<void>
  // 全画像のサムネを検査し、欠けているものを再生成する（設定 > データ の手動操作）。
  imagesRepairThumbs: () => Promise<{ repaired: number; failed: number }>
  onExportProgress: (cb: (data: { current: number; total: number }) => void) => () => void
  getImage: (id: number) => Promise<ImageRow | null>
  onCapture: (cb: (data: CaptureData) => void) => () => void
  // 撮り逃したコマの検証（verify-clip.ts）は保存の後にバックグラウンドで走り、終わってから
  // 「N コマ未取得」を「N コマ要確認」へ変える。一覧は保存時点のスナップショットなので、
  // これを飛ばさないと**検証済みなのに未検証の表示のまま**になる（実測で 90コマ未取得 のまま
  // 64コマ要確認 に変わらなかった）。値は検証後の確定値。
  onFramesVerified: (cb: (data: { id: number; uncaptured: number | null; ambiguous: number | null; total: number | null; unreported: number | null }) => void) => () => void
  onOpenSettings: (cb: () => void) => () => void
  onAppNotice: (cb: (data: AppNotice) => void) => () => void
  onWhatsNew: (cb: (data: WhatsNewData) => void) => () => void
  onExtensionTimecode: (cb: (data: ExtensionTimecode) => void) => () => void
  updateImageTitle: (id: number, title: string) => Promise<void>
  updateImageMemo: (id: number, memo: string) => Promise<void>
  // 手打ちのタイムシート。中身は shared/timesheet.ts の encode/decode を通した JSON 文字列で、
  // main は素通しする（形の検証は両端の同じ関数が持ち、IPC の途中に 3 つ目の解釈を作らない）。
  getTimesheet: (imageId: number) => Promise<string | null>
  saveTimesheet: (imageId: number, data: string) => Promise<void>
  // DB 削除は main 側で 1 トランザクションにまとめる（B-7）。ファイル削除はサーバ側で
  // 逐次ベストエフォート実行し、id ごとの成否を返す。
  deleteImagesBulk: (ids: number[]) => Promise<DeleteImageResult[]>
  // 画像を他アプリへドラッグ&ドロップで渡す（main が OS のドラッグを開始する）。
  // 唯一の送りっぱなし IPC。Promise を待つとドラッグ開始に間に合わないため戻り値を持たない
  // （理由の詳細は main/ipc-drag.ts の先頭コメント）。
  startImageDrag: (ids: number[]) => void
  // 枚数上限（50枚）・累積バイト上限・個別コピー失敗のいずれかで、ドラッグしたつもりの
  // 枚数より実際に渡った枚数が少なかったとき main から通知される（UX-6）。OSドラッグ中は
  // ダイアログ/トーストを出せないため、ドロップ完了後にまとめて届く。
  onImagesDragTruncated: (cb: (data: { requested: number; copied: number }) => void) => () => void
  openUrl: (url: string) => Promise<void>
  showInFolder: (imageId: number) => Promise<void>
  showExtensionFolder: () => Promise<void>
  // 撮ったものが置いてあるフォルダを Explorer で開く。以前は拡張のフォルダだけが開けて、
  // 自分の何百枚の置き場所には辿り着けなかった。
  showCapturesFolder: () => Promise<void>
  // 保存場所と使用量。全ファイルを stat するため数万件では数秒かかる（画面側は「計算中」を出す）。
  getStorageInfo: () => Promise<StorageInfo>
  // 拡張との接続に実際に使っているポート。候補を全部確保できなかったときは null。
  // 繋がらないときに原因を画面から読むための情報なので、接続中でも表示する。
  getWsPort: () => Promise<number | null>
  getSettings: () => Promise<Settings>
  // main 側で loadSettings() とマージしてから保存する部分パッチ（旧: 全体オブジェクト送信）。
  // renderer は自分が変更したいキーだけを渡せばよく、他キーを巻き戻す競合が構造的に起きない。
  setSettings: (patch: Partial<Settings>) => Promise<void>
  setCaptureHotkey: (hotkey: string) => Promise<boolean>
  getStartup: () => Promise<boolean>
  setStartup: (enabled: boolean) => Promise<void>
  getExtensionPath: () => Promise<string>
  // 設定画面のバージョン表示用（自動アップデートが適用されたかを確認できる逃げ道）。
  getAppVersion: () => Promise<string>
  onUpdateDownloaded: (cb: (version: string) => void) => () => void
  updaterQuitAndInstall: () => Promise<void>
  taggerEnsure: () => Promise<void>
  taggerCancelDownload: () => Promise<void>
  taggerDelete: () => Promise<{ removedTags: number }>
  taggerIsDownloaded: () => Promise<boolean>
  taggerAddTag: (imageId: number, tagName: string, source?: ImageTagSource) => Promise<void>
  taggerRemoveTag: (imageId: number, tagName: string) => Promise<void>
  taggerGetTags: (imageId: number) => Promise<ImageTag[]>
  taggerGetTagsBulk: (imageIds: number[]) => Promise<Record<number, ImageTag[]>>
  taggerAddTagBulk: (imageIds: number[], tagName: string, source?: ImageTagSource) => Promise<void>
  taggerRemoveTagBulk: (imageIds: number[], tagName: string) => Promise<void>
  // 「すべてから削除」用。listAllImages で ID を列挙してから removeTagBulk する経路だと
  // MAX_TIMELINE_LIMIT で切り詰められるため、tag 名だけを渡し DB 側で全件消す。戻り値は削除枚数。
  taggerRemoveTagFromAll: (tagName: string) => Promise<number>
  onTaggerDone: (cb: (data: { imageId: number }) => void) => () => void
  onTaggerDownloadProgress: (cb: (progress: number) => void) => () => void
  onTaggerError: (cb: (msg: string) => void) => () => void
  taggerRetagAll: () => Promise<void>
  taggerRetagCancel: () => Promise<void>
  onTaggerRetagProgress: (cb: (data: { current: number; total: number }) => void) => () => void
  onTaggerRetagDone: (cb: (data: { tagged: number; canceled: boolean }) => void) => () => void
  shareExport: () => Promise<{ canceled: boolean; count?: number; path?: string }>
  // imagesExportCancel 同様、進行中の shareExport を中断する。
  shareExportCancel: () => Promise<void>
  shareImport: () => Promise<{ canceled: boolean; count?: number; errors?: string[]; importedFolders?: number }>
  // shareExportCancel 同様、進行中の shareImport を中断する（D-2）。
  shareImportCancel: () => Promise<void>
  onShareImportProgress: (cb: (data: { current: number; total: number }) => void) => () => void
  importFiles: (paths: string[]) => Promise<{ count: number; errors: string[]; truncated: boolean }>
  clipboardPaste: () => Promise<{ ok: true; id: number } | { ok: false; reason: 'empty' | 'error' }>
  clipboardCopyImage: (id: number) => Promise<boolean>
  getPathForFile: (file: File) => string
}

// IPC channel names shared by main, preload, and renderer.
export const CH = {
  // images
  imagesList: 'images:list',
  imagesCount: 'images:count',
  imagesListAll: 'images:listAll',
  imagesListSites: 'images:listSites',
  imagesListAllTags: 'images:listAllTags',
  imagesExport: 'images:export',
  imagesExportCancel: 'images:exportCancel',
  imagesRepairThumbs: 'images:repairThumbs',
  imagesGet: 'images:get',
  imagesUpdateTitle: 'images:updateTitle',
  imagesUpdateMemo: 'images:updateMemo',
  timesheetGet: 'timesheet:get',
  timesheetSave: 'timesheet:save',
  imagesDeleteBulk: 'images:deleteBulk',
  imagesStartDrag: 'images:startDrag',
  imagesDragTruncated: 'images:dragTruncated',
  // shell
  shellOpenUrl: 'shell:openUrl',
  shellShowInFolder: 'shell:showInFolder',
  shellShowExtensionFolder: 'shell:showExtensionFolder',
  shellShowCapturesFolder: 'shell:showCapturesFolder',
  // storage
  storageGetInfo: 'storage:getInfo',
  // ws
  wsGetPort: 'ws:getPort',
  // settings
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  // hotkeys
  captureSetHotkey: 'capture:setHotkey',
  // startup
  startupGet: 'startup:get',
  startupSet: 'startup:set',
  // extension
  extensionGetPath: 'extension:getPath',
  extensionTimecode: 'extension:timecode',
  // app
  appGetVersion: 'app:getVersion',
  // tagger
  taggerEnsure: 'tagger:ensure',
  taggerCancelDownload: 'tagger:cancelDownload',
  taggerDelete: 'tagger:delete',
  taggerIsDownloaded: 'tagger:isDownloaded',
  taggerAddTag: 'tagger:addTag',
  taggerRemoveTag: 'tagger:removeTag',
  taggerGetTags: 'tagger:getTags',
  taggerGetTagsBulk: 'tagger:getTagsBulk',
  taggerAddTagBulk: 'tagger:addTagBulk',
  taggerRemoveTagBulk: 'tagger:removeTagBulk',
  taggerRemoveTagFromAll: 'tagger:removeTagFromAll',
  taggerRetagAll: 'tagger:retagAll',
  taggerRetagCancel: 'tagger:retagCancel',
  taggerDone: 'tagger:done',
  taggerDownloadProgress: 'tagger:download-progress',
  taggerError: 'tagger:error',
  taggerRetagProgress: 'tagger:retag-progress',
  taggerRetagDone: 'tagger:retag-done',
  // share
  shareExport: 'share:export',
  shareExportCancel: 'share:exportCancel',
  shareImport: 'share:import',
  shareImportCancel: 'share:importCancel',
  shareImportProgress: 'share:importProgress',
  // import
  importFiles: 'import:files',
  // clipboard
  clipboardPaste: 'clipboard:paste',
  clipboardCopyImage: 'clipboard:copyImage',
  // export (images:export / share:export で共用)
  exportProgress: 'export:progress',
  // push (main 竊・renderer)
  captureDone: 'capture:done',
  framesVerified: 'frames:verified',
  openSettings: 'open-settings',
  appNotice: 'app:notice',
  whatsNew: 'app:whatsNew',
  updaterDownloaded: 'updater:downloaded',
  updaterQuitAndInstall: 'updater:quitAndInstall',
} as const
