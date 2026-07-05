import { useEffect } from 'react'
import { useLatestRef } from './useLatestRef'
import type { ImageRow } from '../types'
import type { ShowToast } from './useToast'

export interface GlobalKeysOptions {
  searchInputRef: React.RefObject<HTMLInputElement | null>
  setShowSettings: React.Dispatch<React.SetStateAction<boolean>>
  viewerIdx: number | null
  // ビューアの並び基準（Ctrl+C で現在画像をコピーするために参照）
  activeImages: ImageRow[]
  // グリッド上で選択中の画像 ID（Ctrl+C でビューア外でもコピーするために参照）
  selectedIds: Set<number>
  onQuickTag: () => boolean
  // クリップボード取り込みでライブラリが変わったときのサイドバー再取得
  onLibraryChanged: () => void
  showToast: ShowToast
}

function isEditingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

// アプリ全体のグローバルキー操作をまとめて担当する。
// 空依存で 1 回だけ登録し、最新の props は useLatestRef 経由で読む
// （旧 App の viewerIdxRef / activeImagesRef ミラーをここへ内包）。
export function useGlobalKeys(opts: GlobalKeysOptions): void {
  const ref = useLatestRef(opts)

  // Ctrl+V でクリップボード画像をインポート（テキスト入力中は無視）
  useEffect(() => {
    const handler = async (e: KeyboardEvent): Promise<void> => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'v') return
      if (isEditingTarget(e.target)) return
      const result = await window.api.clipboardPaste()
      if (result.ok) {
        ref.current.onLibraryChanged()
        ref.current.showToast('クリップボードからインポートしました', 'success')
      } else if (result.reason === 'empty') {
        ref.current.showToast('クリップボードに画像がありません', 'info')
      } else {
        ref.current.showToast('クリップボードからの取り込みに失敗しました', 'error')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [ref])

  // /キーで検索フォーカス・T でクイックタグ・Ctrl+, で設定・ビューア開放中の Ctrl+C で画像コピー
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const { searchInputRef, setShowSettings, onQuickTag, viewerIdx, activeImages } = ref.current
      const editing = isEditingTarget(e.target)
      if (!editing && e.key === '/' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault()
        searchInputRef.current?.focus()
        return
      }
      if (!editing && e.key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (onQuickTag()) e.preventDefault()
        return
      }
      if (!editing && (e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault()
        setShowSettings(true)
        return
      }
      if (!editing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        const { viewerIdx, activeImages, selectedIds, showToast } = ref.current
        let target: ImageRow | undefined
        if (viewerIdx !== null) {
          target = activeImages[viewerIdx]
        } else if (selectedIds.size === 1) {
          const [id] = selectedIds
          target = activeImages.find((img) => img.id === id)
        }
        if (!target) return
        e.preventDefault()
        window.api.clipboardCopyImage(target.id).then(
          (ok) => showToast(ok ? 'クリップボードにコピーしました' : '画像のコピーに失敗しました', ok ? 'success' : 'warning'),
          (err) => { console.error('[copy] clipboard write failed', err); showToast('画像のコピーに失敗しました', 'warning') },
        )
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [ref])
}
