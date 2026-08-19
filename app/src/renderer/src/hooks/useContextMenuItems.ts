// 右クリックメニューの項目組み立て。App.tsx から切り出した。
//
// 出る項目は選択の状態で変わる：**単一選択のときだけ**「コピー」「エクスプローラーで表示」と
// 機能側の追加項目（トリミング等）が出る。複数選択では書き出しと削除だけ。
// 「コピー」は静止画のみ（動画をクリップボードへ置く手段が無い）。
import { useMemo } from 'react'
import type { MenuItem } from '../components/ContextMenu'
import type { ImageRow } from '../types'
import type { ShowToast } from './useToast'
import { getExtraContextMenuItems } from '../features/registry'
import { t } from '../i18n'

export interface UseContextMenuItemsOptions {
  // メニューが開いているか。閉じているときは組み立てない。
  open: boolean
  // 単一選択のときだけその画像。複数・0 件なら null。
  single: ImageRow | null
  onExport: () => void
  onDelete: () => void
  showToast: ShowToast
}

export function useContextMenuItems({ open, single, onExport, onDelete, showToast }: UseContextMenuItemsOptions): MenuItem[] {
  // 選択状態に応じてメニュー項目を組み立てる。単一選択時のみトリミング/Explorer を出す。
  const ctxMenuItems = useMemo<MenuItem[]>(() => {
    if (!open) return []
    const items: MenuItem[] = []
    if (single && single.media_type !== 'video') {
      items.push({
        label: t('action.copy'),
        onClick: () => {
          window.api.clipboardCopyImage(single.id).then(
            (ok) => showToast(ok ? t('toast.copiedToClipboard') : t('toast.copyFailed'), ok ? 'success' : 'warning'),
            (err) => { console.error('[copy] clipboard write failed', err); showToast(t('toast.copyFailed'), 'warning') },
          )
        },
      })
    }
    if (single) {
      items.push({ label: t('action.showInFolder'), onClick: () => window.api.showInFolder(single.id) })
    }
    if (single) items.push(...getExtraContextMenuItems(single))
    items.push({ label: t('action.export'), onClick: onExport })
    items.push({ label: t('action.delete'), onClick: onDelete, danger: true })
    return items
    // activeImages は組み立てに使っていないので依存から外した（旧コードの残り）。
  }, [open, single, onExport, onDelete, showToast])

  return ctxMenuItems
}
