import { useEffect, useState } from 'react'
import type { ShowToast } from './useToast'
import { t, tp } from '../i18n'

export function useTagger(showToast: ShowToast, onTagsDone: () => void) {
  const [taggerDoneKey, setTaggerDoneKey] = useState(0)
  const [taggerReady, setTaggerReady] = useState(false)
  const [taggerProgress, setTaggerProgress] = useState<number | null>(null)
  const [retagProgress, setRetagProgress] = useState<{ current: number; total: number } | null>(null)

  // モデルは初回タグ付けまでロードしない（S4-1）ため、「準備完了」はメモリ上のセッションではなく
  // モデルがダウンロード済みかどうかで判定する。
  useEffect(() => { window.api.taggerIsDownloaded().then(setTaggerReady) }, [])
  useEffect(() => window.api.onTaggerDownloadProgress((p) => {
    setTaggerProgress(p)
    if (p >= 1) { setTaggerProgress(null); setTaggerReady(true) }
  }), [])
  useEffect(() => window.api.onTaggerDone(() => {
    setTaggerDoneKey((k) => k + 1)
    onTagsDone()
  }), [])
  useEffect(() => window.api.onTaggerError((msg) =>
    showToast(t('toast.taggingError', { message: msg }), 'error')
  ), [])
  useEffect(() => window.api.onTaggerRetagProgress(setRetagProgress), [])
  useEffect(() => window.api.onTaggerRetagDone(({ tagged, canceled }) => {
    setRetagProgress(null)
    setTaggerDoneKey((k) => k + 1)
    onTagsDone()
    showToast(canceled ? tp('toast.taggingStopped', tagged) : tp('toast.tagged', tagged), canceled ? 'warning' : 'success')
  }), [])

  async function handleTaggerDelete(): Promise<void> {
    const { removedTags } = await window.api.taggerDelete()
    setTaggerReady(false)
    // AI由来のタグもDBから削除されるため、開いているDetailPanel・サイドバーのタグ一覧を再取得させる。
    setTaggerDoneKey((k) => k + 1)
    onTagsDone()
    if (removedTags > 0) showToast(tp('toast.aiTagsRemoved', removedTags), 'info')
  }

  async function handleTaggerDownload(): Promise<void> {
    setTaggerProgress(0)
    try {
      await window.api.taggerEnsure()
      setTaggerReady(true)
    } catch (err) {
      console.error('Tagger download failed', err)
      const message = err instanceof Error ? err.message : String(err)
      if (!/abort|cancel/i.test(message)) {
        showToast(t('toast.modelDownloadFailed'), 'error')
      }
    } finally {
      setTaggerProgress(null)
    }
  }

  async function handleTaggerCancelDownload(): Promise<void> {
    await window.api.taggerCancelDownload()
    setTaggerProgress(null)
    showToast(t('toast.modelDownloadCanceled'), 'warning')
  }

  // 進捗クリアとトーストは main 側の taggerRetagDone（canceled: true）を受けて
  // onTaggerRetagDone 側で行う。ここでは中止要求を送るだけ。
  async function handleTaggerRetagCancel(): Promise<void> {
    await window.api.taggerRetagCancel()
  }

  return { taggerDoneKey, taggerReady, taggerProgress, retagProgress, handleTaggerDelete, handleTaggerDownload, handleTaggerCancelDownload, handleTaggerRetagCancel }
}
