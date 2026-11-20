import { ipcRenderer, webUtils } from 'electron'
import { listen } from './listen'
import type { ShioriApi } from '../shared/api'
import { CH } from '../shared/api'


export function buildCoreApi(): ShioriApi {
  return {
    listImages: (req) =>
      ipcRenderer.invoke(CH.imagesList, req),

    countImages: (query) =>
      ipcRenderer.invoke(CH.imagesCount, query),

    listAllImages: (query) =>
      ipcRenderer.invoke(CH.imagesListAll, query),

    listSites: () =>
      ipcRenderer.invoke(CH.imagesListSites),

    listAllTags: (includeAi) =>
      ipcRenderer.invoke(CH.imagesListAllTags, includeAi),

    exportImages: (imageIds) =>
      ipcRenderer.invoke(CH.imagesExport, imageIds),

    imagesExportCancel: () => ipcRenderer.invoke(CH.imagesExportCancel),
    imagesRepairThumbs: () => ipcRenderer.invoke(CH.imagesRepairThumbs),

    onExportProgress: (cb) =>
      listen(CH.exportProgress, cb),

    getImage: (id) =>
      ipcRenderer.invoke(CH.imagesGet, id),

    onCapture: (callback) =>
      listen(CH.captureDone, callback),

    onOpenSettings: (cb) => listen(CH.openSettings, cb),

    onAppNotice: (cb) => listen(CH.appNotice, cb),

    onWhatsNew: (cb) => listen(CH.whatsNew, cb),

    onExtensionTimecode: (cb) =>
      listen(CH.extensionTimecode, cb),

    updateImageTitle: (id, title) =>
      ipcRenderer.invoke(CH.imagesUpdateTitle, id, title),

    updateImageMemo: (id, memo) =>
      ipcRenderer.invoke(CH.imagesUpdateMemo, id, memo),

    getTimesheet: (imageId) =>
      ipcRenderer.invoke(CH.timesheetGet, imageId),

    saveTimesheet: (imageId, data) =>
      ipcRenderer.invoke(CH.timesheetSave, imageId, data),

    deleteImagesBulk: (ids) =>
      ipcRenderer.invoke(CH.imagesDeleteBulk, ids),

    startImageDrag: (ids) =>
      ipcRenderer.send(CH.imagesStartDrag, ids),

    onImagesDragTruncated: (cb) =>
      listen(CH.imagesDragTruncated, cb),

    openUrl: (url) =>
      ipcRenderer.invoke(CH.shellOpenUrl, url),

    showInFolder: (imageId) =>
      ipcRenderer.invoke(CH.shellShowInFolder, imageId),

    showExtensionFolder: () =>
      ipcRenderer.invoke(CH.shellShowExtensionFolder),

    chooseCaptureRoot: () =>
      ipcRenderer.invoke(CH.storageChooseRoot),

    moveCaptureRoot: (path) =>
      ipcRenderer.invoke(CH.storageMoveToRoot, path),

    cancelCaptureMove: () =>
      ipcRenderer.invoke(CH.storageCancelMove),

    onCaptureMoveProgress: (cb) =>
      listen(CH.storageMoveProgress, cb),

    getStorageInfo: () =>
      ipcRenderer.invoke(CH.storageGetInfo),

    getWsPort: () =>
      ipcRenderer.invoke(CH.wsGetPort),

    getSettings: () =>
      ipcRenderer.invoke(CH.settingsGet),

    setSettings: (patch) =>
      ipcRenderer.invoke(CH.settingsSet, patch),

    setCaptureHotkey: (hotkey) =>
      ipcRenderer.invoke(CH.captureSetHotkey, hotkey),

    getStartup: () =>
      ipcRenderer.invoke(CH.startupGet),

    setStartup: (enabled) =>
      ipcRenderer.invoke(CH.startupSet, enabled),

    getExtensionPath: () =>
      ipcRenderer.invoke(CH.extensionGetPath),

    getAppVersion: () =>
      ipcRenderer.invoke(CH.appGetVersion),

    onUpdateDownloaded: (cb) => listen(CH.updaterDownloaded, cb),

    getDownloadedUpdate: () => ipcRenderer.invoke(CH.updaterGetDownloaded),

    updaterQuitAndInstall: () => ipcRenderer.invoke(CH.updaterQuitAndInstall),

    taggerEnsure: () => ipcRenderer.invoke(CH.taggerEnsure),
    taggerCancelDownload: () => ipcRenderer.invoke(CH.taggerCancelDownload),
    taggerDelete: () => ipcRenderer.invoke(CH.taggerDelete),
    taggerIsDownloaded: () => ipcRenderer.invoke(CH.taggerIsDownloaded),
    taggerAddTag: (imageId, tagName, source) => ipcRenderer.invoke(CH.taggerAddTag, imageId, tagName, source),
    taggerRemoveTag: (imageId, tagName) => ipcRenderer.invoke(CH.taggerRemoveTag, imageId, tagName),
    taggerGetTags: (imageId) => ipcRenderer.invoke(CH.taggerGetTags, imageId),
    taggerGetTagsBulk: (imageIds) => ipcRenderer.invoke(CH.taggerGetTagsBulk, imageIds),
    taggerAddTagBulk: (imageIds, tagName, source) => ipcRenderer.invoke(CH.taggerAddTagBulk, imageIds, tagName, source),
    taggerRemoveTagBulk: (imageIds, tagName) => ipcRenderer.invoke(CH.taggerRemoveTagBulk, imageIds, tagName),
    taggerRemoveTagFromAll: (tagName) => ipcRenderer.invoke(CH.taggerRemoveTagFromAll, tagName),
    onTaggerDone: (cb) => listen(CH.taggerDone, cb),
    onFramesVerified: (cb) =>
      listen(CH.framesVerified, cb),
    onTaggerDownloadProgress: (cb) => listen(CH.taggerDownloadProgress, cb),
    onTaggerError: (cb) => listen(CH.taggerError, cb),

    taggerRetagAll: () => ipcRenderer.invoke(CH.taggerRetagAll),
    taggerRetagCancel: () => ipcRenderer.invoke(CH.taggerRetagCancel),
    onTaggerRetagProgress: (cb) =>
      listen(CH.taggerRetagProgress, cb),
    onTaggerRetagDone: (cb) =>
      listen(CH.taggerRetagDone, cb),

    shareExport: () =>
      ipcRenderer.invoke(CH.shareExport),

    shareExportCancel: () => ipcRenderer.invoke(CH.shareExportCancel),

    shareImport: (mode) =>
      ipcRenderer.invoke(CH.shareImport, mode),

    shareImportCancel: () => ipcRenderer.invoke(CH.shareImportCancel),

    onShareImportProgress: (cb) =>
      listen(CH.shareImportProgress, cb),

    importFiles: (paths) =>
      ipcRenderer.invoke(CH.importFiles, paths),

    clipboardPaste: () =>
      ipcRenderer.invoke(CH.clipboardPaste),

    clipboardCopyImage: (id) =>
      ipcRenderer.invoke(CH.clipboardCopyImage, id),

    getPathForFile: (file) => webUtils.getPathForFile(file),
  }
}
