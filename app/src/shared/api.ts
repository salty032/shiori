// preload が公開する window.api の唯一の型定義（単一の信頼できる情報源）。
// preload はこの型で実装を縛られ、renderer はこの型を Window.api として宣言する。
// 片方だけ変更すると型エラーになるため、両者がズレることはない。
import type {
  ImageRow, ImageTag, ImageTagSource, Settings,
  CaptureData, ExtensionTimecode, AppNotice,
  ImageQuery, ImageListRequest, DeleteImageResult,
} from './types'

export interface ShioriApi {
  listImages: (req: ImageListRequest) => Promise<ImageRow[]>
  countImages: (query: ImageQuery) => Promise<number>
  listAllImages: (query: ImageQuery) => Promise<ImageRow[]>
  listSites: () => Promise<string[]>
  listSiteCounts: () => Promise<Record<string, number>>
  listAllTags: (includeAi?: boolean) => Promise<ImageTag[]>
  listTagCounts: () => Promise<Record<string, number>>
  exportImages: (imageIds: number[]) => Promise<{ canceled: boolean; count?: number; truncated?: boolean }>
  // 進行中の imagesExport を中断する（数百枚規模のコピーが分単位になりうるため）。
  // count が届いている exportImages の戻り値と canceled: true の組み合わせで
  // 「途中まで書き出し済み」を判別する（フォルダ選択自体のキャンセルは count なし）。
  imagesExportCancel: () => Promise<void>
  onExportProgress: (cb: (data: { current: number; total: number }) => void) => () => void
  getImage: (id: number) => Promise<ImageRow | null>
  onCapture: (cb: (data: CaptureData) => void) => () => void
  onOpenSettings: (cb: () => void) => () => void
  onAppNotice: (cb: (data: AppNotice) => void) => () => void
  onExtensionTimecode: (cb: (data: ExtensionTimecode) => void) => () => void
  updateImageTitle: (id: number, title: string) => Promise<void>
  updateImageMemo: (id: number, memo: string) => Promise<void>
  deleteImage: (id: number) => Promise<DeleteImageResult>
  // DB 削除は main 側で 1 トランザクションにまとめる（B-7）。ゴミ箱移動はサーバ側で
  // 逐次ベストエフォート実行し、id ごとの成否を deleteImage と同じ形で返す。
  deleteImagesBulk: (ids: number[]) => Promise<DeleteImageResult[]>
  openUrl: (url: string) => Promise<void>
  showInFolder: (imageId: number) => Promise<void>
  showExtensionFolder: () => Promise<void>
  getSettings: () => Promise<Settings>
  // main 側で loadSettings() とマージしてから保存する部分パッチ（旧: 全体オブジェクト送信）。
  // renderer は自分が変更したいキーだけを渡せばよく、他キーを巻き戻す競合が構造的に起きない。
  setSettings: (patch: Partial<Settings>) => Promise<void>
  setCaptureHotkey: (hotkey: string) => Promise<boolean>
  getStartup: () => Promise<boolean>
  setStartup: (enabled: boolean) => Promise<void>
  getExtensionPath: () => Promise<string>
  onUpdateAvailable: (cb: (version: string) => void) => () => void
  taggerEnsure: () => Promise<void>
  taggerCancelDownload: () => Promise<void>
  taggerDelete: () => Promise<{ removedTags: number }>
  taggerIsLoaded: () => Promise<boolean>
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
  onTaggerReady: (cb: () => void) => () => void
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
  imagesListSiteCounts: 'images:listSiteCounts',
  imagesListAllTags: 'images:listAllTags',
  imagesListTagCounts: 'images:listTagCounts',
  imagesExport: 'images:export',
  imagesExportCancel: 'images:exportCancel',
  imagesGet: 'images:get',
  imagesUpdateTitle: 'images:updateTitle',
  imagesUpdateMemo: 'images:updateMemo',
  imagesDelete: 'images:delete',
  imagesDeleteBulk: 'images:deleteBulk',
  // shell
  shellOpenUrl: 'shell:openUrl',
  shellShowInFolder: 'shell:showInFolder',
  shellShowExtensionFolder: 'shell:showExtensionFolder',
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
  // tagger
  taggerEnsure: 'tagger:ensure',
  taggerCancelDownload: 'tagger:cancelDownload',
  taggerDelete: 'tagger:delete',
  taggerIsLoaded: 'tagger:isLoaded',
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
  taggerReady: 'tagger:ready',
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
  openSettings: 'open-settings',
  appNotice: 'app:notice',
  updaterAvailable: 'updater:available',
} as const
