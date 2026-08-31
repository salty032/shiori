// キャプチャ／クリップ／インポート／共有インポートで共通の
// 「insertImage → 失敗時unlink巻き戻し → captureDone送信 → autotag起動」を1箇所にまとめる。
// サムネ生成はベストエフォート可否が呼び出し側で異なるため、呼び出し側の責務のまま。
import { unlink } from 'fs/promises'
import { insertImage, getImage } from '../db'
import { addTagsBulk } from '../db-tags'
import { sendToRenderer, sendNotice } from '../system/windows'
import { t } from '../system/i18n'
import { canAutoTag, ensureModel, runTagger } from './tagger'
import { CH } from '../../shared/api'

type InsertImageParams = Parameters<typeof insertImage>[0]

interface AutoTagOptions {
  path: string
  // taggerError を renderer に送るか。既存呼び出し元は画像キャプチャ以外は console.error のみだったため既定 false。
  reportError?: boolean
}

interface RegisterCapturedMediaParams {
  insert: InsertImageParams
  // insertImage 失敗時に削除する実体ファイル・サムネ（呼び出し側が事前に書き出した後の巻き戻し用）
  filePath: string
  thumbPath?: string | null
  autoTag?: AutoTagOptions | null
  extraTags?: { name: string; source: 'manual' | 'ai' }[]
  // 既定 true。共有インポートのような一括投入では captureDone を送らない運用があるため false 指定を許す。
  broadcastCaptureDone?: boolean
}

type RegisterCapturedMediaResult =
  // tagsFailed: 行は作れたが、渡されたタグが付かなかった（画面には警告済み）。
  | { ok: true; id: number; tagsFailed: boolean }
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

  // **タグが付かなくても、撮ったもの自体は捨てない。**
  //
  // ここが投げるのは DB そのものが書けないとき（満杯・破損）。以前はそのまま外へ抜けて
  // いたので、呼び出し側の後始末で**実体ファイルだけ消えて DB の行が残る**（トリム）か、
  // **取り込みが途中で止まる**（共有インポート）ことになっていた。
  //
  // タグとクリップ本体では釣り合わない——トリムした動画を「タグを引き継げなかったから」で
  // 捨てるのは損が大きすぎる。行は残し、**付かなかったことを画面に出す**。黙って減らすのが
  // 一番まずい（タグが消えたことは、後から画面を見ても分からない）。
  let tagsFailed = false
  if (extraTags && extraTags.length > 0) {
    try {
      addTagsBulk(id, extraTags)
    } catch (err) {
      console.error('[captured-media] addTagsBulk failed', err)
      tagsFailed = true
      sendNotice('warning', t('notice.tagsNotSaved'))
    }
  }

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

  return { ok: true, id, tagsFailed }
}
