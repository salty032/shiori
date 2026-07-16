// キャプチャ／クリップ／インポート／共有インポートで共通の
// 「insertImage → 失敗時unlink巻き戻し → captureDone送信 → autotag起動」を1箇所にまとめる。
// サムネ生成はベストエフォート可否が呼び出し側で異なるため、呼び出し側の責務のまま。
import { unlink } from 'fs/promises'
import { insertImage, addTagsBulk, getImage } from './db'
import { sendToRenderer } from './windows'
import { canAutoTag, ensureModel, runTagger } from './tagger'
import { CH } from '../shared/api'

type InsertImageParams = Parameters<typeof insertImage>[0]

export interface AutoTagOptions {
  path: string
  // taggerError を renderer に送るか。既存呼び出し元は画像キャプチャ以外は console.error のみだったため既定 false。
  reportError?: boolean
}

export interface RegisterCapturedMediaParams {
  insert: InsertImageParams
  // insertImage 失敗時に削除する実体ファイル・サムネ（呼び出し側が事前に書き出した後の巻き戻し用）
  filePath: string
  thumbPath?: string | null
  autoTag?: AutoTagOptions | null
  extraTags?: { name: string; source: 'manual' | 'ai' }[]
  // 既定 true。共有インポートのような一括投入では captureDone を送らない運用があるため false 指定を許す。
  broadcastCaptureDone?: boolean
}

export type RegisterCapturedMediaResult =
  | { ok: true; id: number }
  | { ok: false; error: unknown }

export async function registerCapturedMedia(
  params: RegisterCapturedMediaParams
): Promise<RegisterCapturedMediaResult> {
  const { insert, filePath, thumbPath, autoTag, extraTags, broadcastCaptureDone = true } = params

  let id: number
  try {
    id = insertImage(insert)
  } catch (err) {
    console.error('[captured-media] insertImage failed', err)
    try { await unlink(filePath) } catch (unlinkErr) {
      console.warn('[captured-media] failed to remove unregistered capture file', unlinkErr)
    }
    if (thumbPath) try { await unlink(thumbPath) } catch {}
    return { ok: false, error: err }
  }

  if (extraTags && extraTags.length > 0) addTagsBulk(id, extraTags)

  if (broadcastCaptureDone) sendToRenderer(CH.captureDone, { id, imagePath: filePath })

  if (autoTag && await canAutoTag()) {
    ensureModel().then(() => runTagger(autoTag.path)).then((tags) => {
      // タグ付けは非同期。完了前に画像が削除されていたら、存在しない image_id への
      // insert（FK違反）を試みてログを汚さないよう黙って捨てる。
      if (!getImage(id)) return
      addTagsBulk(id, tags.map((t) => ({ name: t.name, source: 'ai' as const })))
      sendToRenderer(CH.taggerDone, { imageId: id })
    }).catch((err) => {
      console.error('[tagger] runTagger failed', err)
      if (autoTag.reportError) sendToRenderer(CH.taggerError, String(err))
    })
  }

  return { ok: true, id }
}
