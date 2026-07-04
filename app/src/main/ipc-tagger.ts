// WD Tagger 関連の IPC ハンドラ（モデル DL・手動タグ CRUD・一括再タグ付け）。
import { handleTrusted, sendToRenderer } from './windows'
import { ensureModel, runTagger, isModelLoaded, isModelDownloaded, deleteModel, cancelModelDownload } from './tagger'
import { addTag, getImageTags, removeImageTag, addTagsBulk, listImagesForRetag, getImageTagsBulk, addTagBulk, removeTagBulk, deleteAllAiTags } from './db'
import { optionalPositiveInteger, optionalText, normalizeTagName, tagSource, MAX_TAG_LENGTH } from './ipc-validation'
import { resolveRealCapturePath } from './paths'
import { CH } from '../shared/api'
import { MAX_BULK_IDS } from '../shared/constants'
import { createProgressThrottle } from './progress-throttle'

let isRetagging = false
let isRetagCanceled = false

function validImageIds(imageIds: unknown): number[] {
  if (!Array.isArray(imageIds)) return []
  return [...new Set(imageIds.map(optionalPositiveInteger).filter((id): id is number => id != null))].slice(0, MAX_BULK_IDS)
}

export function registerTaggerHandlers(): void {
  handleTrusted(CH.taggerEnsure, async () => {
    await ensureModel((progress) => {
      sendToRenderer(CH.taggerDownloadProgress, progress)
    })
  })
  handleTrusted(CH.taggerCancelDownload, () => cancelModelDownload())
  handleTrusted(CH.taggerIsLoaded, () => isModelLoaded())
  handleTrusted(CH.taggerIsDownloaded, () => isModelDownloaded())
  handleTrusted(CH.taggerDelete, async () => {
    await deleteModel()
    const removedTags = deleteAllAiTags()
    return { removedTags }
  })
  handleTrusted(CH.taggerAddTag, (_event, imageId: number, tagName: string, source: 'manual' | 'ai' = 'ai') => {
    const id = optionalPositiveInteger(imageId)
    if (!id) return
    const cleaned = normalizeTagName(tagName, MAX_TAG_LENGTH)
    if (cleaned) addTag(id, cleaned, tagSource(source))
  })
  handleTrusted(CH.taggerGetTags, (_event, imageId: number) => {
    const id = optionalPositiveInteger(imageId)
    return id ? getImageTags(id) : []
  })
  handleTrusted(CH.taggerRemoveTag, (_event, imageId: number, tagName: string) => {
    const id = optionalPositiveInteger(imageId)
    if (!id) return
    const cleaned = optionalText(tagName, MAX_TAG_LENGTH)
    if (cleaned) removeImageTag(id, cleaned)
  })
  handleTrusted(CH.taggerGetTagsBulk, (_event, imageIds: number[]) => {
    const ids = validImageIds(imageIds)
    return getImageTagsBulk(ids)
  })
  handleTrusted(CH.taggerAddTagBulk, (_event, imageIds: number[], tagName: string, source: 'manual' | 'ai' = 'manual') => {
    const ids = validImageIds(imageIds)
    const cleaned = normalizeTagName(tagName, MAX_TAG_LENGTH)
    if (cleaned) addTagBulk(ids, cleaned, tagSource(source))
  })
  handleTrusted(CH.taggerRemoveTagBulk, (_event, imageIds: number[], tagName: string) => {
    const ids = validImageIds(imageIds)
    const cleaned = optionalText(tagName, MAX_TAG_LENGTH)
    if (cleaned) removeTagBulk(ids, cleaned)
  })

  handleTrusted(CH.taggerRetagAll, async () => {
    if (isRetagging) return
    isRetagging = true
    isRetagCanceled = false
    try {
      const targets = listImagesForRetag()
      const total = targets.length
      sendToRenderer(CH.taggerRetagProgress, { current: 0, total })
      const shouldSend = createProgressThrottle(total)
      let tagged = 0
      let i = 0
      for (; i < targets.length; i++) {
        if (isRetagCanceled) break
        const { id, filepath, thumb_path } = targets[i]
        try {
          // 動画クリップは thumb_path（静止画サムネイル）でタグ付けする。サムネ未生成ならスキップ。
          const srcPath = filepath.endsWith('.webm') ? thumb_path : filepath
          if (!srcPath) throw new Error('no tagger source (thumb not yet generated)')
          const resolvedPath = await resolveRealCapturePath(srcPath)
          if (!resolvedPath) throw new Error('path not resolvable')
          const tags = await runTagger(resolvedPath)
          addTagsBulk(id, tags.map((t) => ({ name: t.name, source: 'ai' as const })))
          tagged++
        } catch (err) {
          console.error(`[tagger] retagAll skip id=${id}`, err)
        }
        if (shouldSend(i + 1)) sendToRenderer(CH.taggerRetagProgress, { current: i + 1, total })
      }
      sendToRenderer(CH.taggerRetagDone, { tagged, canceled: isRetagCanceled })
    } finally {
      isRetagging = false
    }
  })
  handleTrusted(CH.taggerRetagCancel, () => { isRetagCanceled = true })
}
