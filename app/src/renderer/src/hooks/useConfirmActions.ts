import type { SmartFolder } from '../types'
import type { ShowToast } from './useToast'
import { useImageStore } from '../stores/imageStore'

export type ConfirmDialogState = {
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
}

export interface UseConfirmActionsOptions {
  setConfirmDialog: (state: ConfirmDialogState | null) => void
  showToast: ShowToast
  deleteSmartFolder: (id: string) => void | Promise<void>
  setTagFilters: (v: string[] | ((prev: string[]) => string[])) => void
  refreshTags: () => void
  removeSearchTag: (tag: string) => void
  taggerDelete: () => void | Promise<void>
}

// M-3: App.tsx から「確認ダイアログを組み立てて開く」系のドメインロジックだけを切り出したもの。
// 配線（JSX への props 渡し）は App.tsx に残し、ここには確認文言の組み立てと確定時の実処理を置く。
export function useConfirmActions(opts: UseConfirmActionsOptions) {
  const { setConfirmDialog, showToast, deleteSmartFolder, setTagFilters, refreshTags, removeSearchTag, taggerDelete } = opts

  function confirmSmartFolderDelete(folder: SmartFolder): void {
    setConfirmDialog({
      title: 'スマートフォルダを削除',
      message: `「${folder.name}」を削除しますか？\n保存した絞り込み条件だけが削除され、画像は削除されません。`,
      confirmLabel: '削除',
      danger: true,
      onConfirm: () => deleteSmartFolder(folder.id),
    })
  }

  async function deleteTagFromAllImages(tag: string): Promise<void> {
    try {
      // listAllImages で ID を列挙してから bulk 削除する経路だと MAX_TIMELINE_LIMIT（5000件）で
      // 打ち切られ、超過分にタグが残ってしまう。DB 側でタグ名から直接全件削除する専用 IPC を使う。
      const removedCount = await window.api.taggerRemoveTagFromAll(tag)
      setTagFilters((prev) => prev.filter((t) => t !== tag))
      removeSearchTag(tag)
      refreshTags()
      useImageStore.getState().reloadGrid(showToast)
      useImageStore.getState().reloadTimeline(showToast)
      showToast(`タグ「${tag}」を${removedCount}枚から削除しました`, 'success')
    } catch (err) {
      console.error('[tag] deleteTagFromAllImages failed', err)
      showToast('タグの削除に失敗しました', 'warning')
    }
  }

  async function confirmDeleteTagGlobally(tag: string): Promise<void> {
    // サイドバーの件数バッジ廃止に伴い常時取得の tagCounts をやめ、削除確認時にオンデマンドで数える（F-7）。
    const count = await window.api.countImages({ tags: [tag] })
    setConfirmDialog({
      title: 'タグを削除',
      message: `タグ「${tag}」を${count}枚の画像すべてから削除しますか？この操作は元に戻せません。`,
      confirmLabel: '削除',
      danger: true,
      onConfirm: () => deleteTagFromAllImages(tag),
    })
  }

  function confirmTaggerDelete(): void {
    setConfirmDialog({
      title: 'AIタグ付けモデルを削除',
      message: '再度使うには約600MBのモデルをダウンロードする必要があります。これまでに付与されたAIタグ（手動タグは除く）もライブラリ全体から削除されます。この操作は元に戻せません。',
      confirmLabel: '削除',
      danger: true,
      onConfirm: taggerDelete,
    })
  }

  return { confirmSmartFolderDelete, confirmDeleteTagGlobally, confirmTaggerDelete }
}
