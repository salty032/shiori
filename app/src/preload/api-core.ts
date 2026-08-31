import { ipcRenderer, webUtils } from 'electron'
import type { ImageRow, TagWithCount, Settings, CaptureData, ExtensionTimecode, AppNotice, WhatsNewData, ImageQuery, ImageListRequest, StorageInfo, ChooseCaptureRootResult } from '../shared/types'
import type { ShioriApi } from '../shared/api'
import { CH } from '../shared/api'

function listen<T>(channel: string, callback: (data: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, data: T): void => callback(data)
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.off(channel, listener) }
}

export function buildCoreApi(): ShioriApi {
  return {
    listImages: (req: ImageListRequest): Promise<ImageRow[]> =>
      ipcRenderer.invoke(CH.imagesList, req),

    countImages: (query: ImageQuery): Promise<number> =>
      ipcRenderer.invoke(CH.imagesCount, query),

    listAllImages: (query: ImageQuery): Promise<ImageRow[]> =>
      ipcRenderer.invoke(CH.imagesListAll, query),

    listSites: (): Promise<string[]> =>
      ipcRenderer.invoke(CH.imagesListSites),

    listAllTags: (includeAi?: boolean): Promise<TagWithCount[]> =>
      ipcRenderer.invoke(CH.imagesListAllTags, includeAi),

    exportImages: (imageIds: number[]): Promise<{ canceled: boolean; count?: number; truncated?: boolean; notConverted?: number }> =>
      ipcRenderer.invoke(CH.imagesExport, imageIds),

    imagesExportCancel: (): Promise<void> => ipcRenderer.invoke(CH.imagesExportCancel),
    imagesRepairThumbs: (): Promise<{ repaired: number; failed: number }> => ipcRenderer.invoke(CH.imagesRepairThumbs),

    onExportProgress: (cb: (data: { current: number; total: number }) => void) =>
      listen<{ current: number; total: number }>(CH.exportProgress, cb),

    getImage: (id: number): Promise<ImageRow | null> =>
      ipcRenderer.invoke(CH.imagesGet, id),

    onCapture: (callback: (data: CaptureData) => void) =>
      listen<CaptureData>(CH.captureDone, callback),

    onOpenSettings: (cb: () => void) => listen<void>(CH.openSettings, cb),

    onAppNotice: (cb: (data: AppNotice) => void) => listen<AppNotice>(CH.appNotice, cb),

    onWhatsNew: (cb: (data: WhatsNewData) => void) => listen<WhatsNewData>(CH.whatsNew, cb),

    onExtensionTimecode: (cb: (data: ExtensionTimecode) => void) =>
      listen<ExtensionTimecode>(CH.extensionTimecode, cb),

    updateImageTitle: (id: number, title: string): Promise<void> =>
      ipcRenderer.invoke(CH.imagesUpdateTitle, id, title),

    updateImageMemo: (id: number, memo: string): Promise<void> =>
      ipcRenderer.invoke(CH.imagesUpdateMemo, id, memo),

    getTimesheet: (imageId: number): Promise<string | null> =>
      ipcRenderer.invoke(CH.timesheetGet, imageId),

    saveTimesheet: (imageId: number, data: string): Promise<void> =>
      ipcRenderer.invoke(CH.timesheetSave, imageId, data),

    deleteImagesBulk: (ids: number[]) =>
      ipcRenderer.invoke(CH.imagesDeleteBulk, ids),

    startImageDrag: (ids: number[]): void =>
      ipcRenderer.send(CH.imagesStartDrag, ids),

    onImagesDragTruncated: (cb: (data: { requested: number; copied: number }) => void) =>
      listen<{ requested: number; copied: number }>(CH.imagesDragTruncated, cb),

    openUrl: (url: string): Promise<void> =>
      ipcRenderer.invoke(CH.shellOpenUrl, url),

    showInFolder: (imageId: number): Promise<void> =>
      ipcRenderer.invoke(CH.shellShowInFolder, imageId),

    showExtensionFolder: (): Promise<void> =>
      ipcRenderer.invoke(CH.shellShowExtensionFolder),

    chooseCaptureRoot: (): Promise<ChooseCaptureRootResult> =>
      ipcRenderer.invoke(CH.storageChooseRoot),

    cancelCaptureMove: (): Promise<void> =>
      ipcRenderer.invoke(CH.storageCancelMove),

    onCaptureMoveProgress: (cb: (data: { current: number; total: number }) => void) =>
      listen<{ current: number; total: number }>(CH.storageMoveProgress, cb),

    getStorageInfo: (): Promise<StorageInfo> =>
      ipcRenderer.invoke(CH.storageGetInfo),

    getWsPort: (): Promise<number | null> =>
      ipcRenderer.invoke(CH.wsGetPort),

    getSettings: (): Promise<Settings> =>
      ipcRenderer.invoke(CH.settingsGet),

    setSettings: (patch: Partial<Settings>): Promise<void> =>
      ipcRenderer.invoke(CH.settingsSet, patch),

    setCaptureHotkey: (hotkey: string): Promise<boolean> =>
      ipcRenderer.invoke(CH.captureSetHotkey, hotkey),

    getStartup: (): Promise<boolean> =>
      ipcRenderer.invoke(CH.startupGet),

    setStartup: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(CH.startupSet, enabled),

    getExtensionPath: (): Promise<string> =>
      ipcRenderer.invoke(CH.extensionGetPath),

    getAppVersion: (): Promise<string> =>
      ipcRenderer.invoke(CH.appGetVersion),

    onUpdateDownloaded: (cb: (version: string) => void) => listen<string>(CH.updaterDownloaded, cb),

    updaterQuitAndInstall: (): Promise<void> => ipcRenderer.invoke(CH.updaterQuitAndInstall),

    taggerEnsure: (): Promise<void> => ipcRenderer.invoke(CH.taggerEnsure),
    taggerCancelDownload: (): Promise<void> => ipcRenderer.invoke(CH.taggerCancelDownload),
    taggerDelete: (): Promise<{ removedTags: number }> => ipcRenderer.invoke(CH.taggerDelete),
    taggerIsDownloaded: (): Promise<boolean> => ipcRenderer.invoke(CH.taggerIsDownloaded),
    taggerAddTag: (imageId: number, tagName: string, source?: 'manual' | 'ai'): Promise<void> => ipcRenderer.invoke(CH.taggerAddTag, imageId, tagName, source),
    taggerRemoveTag: (imageId: number, tagName: string): Promise<void> => ipcRenderer.invoke(CH.taggerRemoveTag, imageId, tagName),
    taggerGetTags: (imageId: number): Promise<{ name: string; source: 'manual' | 'ai' }[]> => ipcRenderer.invoke(CH.taggerGetTags, imageId),
    taggerGetTagsBulk: (imageIds: number[]): Promise<Record<number, { name: string; source: 'manual' | 'ai' }[]>> => ipcRenderer.invoke(CH.taggerGetTagsBulk, imageIds),
    taggerAddTagBulk: (imageIds: number[], tagName: string, source?: 'manual' | 'ai'): Promise<void> => ipcRenderer.invoke(CH.taggerAddTagBulk, imageIds, tagName, source),
    taggerRemoveTagBulk: (imageIds: number[], tagName: string): Promise<void> => ipcRenderer.invoke(CH.taggerRemoveTagBulk, imageIds, tagName),
    taggerRemoveTagFromAll: (tagName: string): Promise<number> => ipcRenderer.invoke(CH.taggerRemoveTagFromAll, tagName),
    onTaggerDone: (cb: (data: { imageId: number }) => void) => listen(CH.taggerDone, cb),
    onFramesVerified: (cb: (data: { id: number; uncaptured: number | null; ambiguous: number | null; total: number | null; unreported: number | null; misaligned: number | null; unreportedMeasured: boolean }) => void) =>
      listen(CH.framesVerified, cb),
    onTaggerDownloadProgress: (cb: (progress: number) => void) => listen<number>(CH.taggerDownloadProgress, cb),
    onTaggerError: (cb: (msg: string) => void) => listen<string>(CH.taggerError, cb),

    taggerRetagAll: (): Promise<void> => ipcRenderer.invoke(CH.taggerRetagAll),
    taggerRetagCancel: (): Promise<void> => ipcRenderer.invoke(CH.taggerRetagCancel),
    onTaggerRetagProgress: (cb: (data: { current: number; total: number }) => void) =>
      listen<{ current: number; total: number }>(CH.taggerRetagProgress, cb),
    onTaggerRetagDone: (cb: (data: { tagged: number; canceled: boolean }) => void) =>
      listen<{ tagged: number; canceled: boolean }>(CH.taggerRetagDone, cb),

    shareExport: (): Promise<{ canceled: boolean; count?: number; path?: string }> =>
      ipcRenderer.invoke(CH.shareExport),

    shareExportCancel: (): Promise<void> => ipcRenderer.invoke(CH.shareExportCancel),

    shareImport: (): Promise<{ canceled: boolean; count?: number; errors?: string[]; importedFolders?: number }> =>
      ipcRenderer.invoke(CH.shareImport),

    shareImportCancel: (): Promise<void> => ipcRenderer.invoke(CH.shareImportCancel),

    onShareImportProgress: (cb: (data: { current: number; total: number }) => void) =>
      listen<{ current: number; total: number }>(CH.shareImportProgress, cb),

    importFiles: (paths: string[]): Promise<{ count: number; errors: string[]; truncated: boolean }> =>
      ipcRenderer.invoke(CH.importFiles, paths),

    clipboardPaste: (): Promise<{ ok: true; id: number } | { ok: false; reason: 'empty' | 'error' }> =>
      ipcRenderer.invoke(CH.clipboardPaste),

    clipboardCopyImage: (id: number): Promise<boolean> =>
      ipcRenderer.invoke(CH.clipboardCopyImage, id),

    getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  }
}
