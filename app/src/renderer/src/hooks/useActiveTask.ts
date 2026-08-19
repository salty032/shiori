// 進捗バーに出す「今動いているタスク」を1つ選ぶ。App.tsx から切り出した。
//
// **並び順が仕様**：モデル取得 → AI タグ付け → ライブラリ取り込み → 書き出し。同時に走ることが
// あるので、先に書いたものが勝つ。バーは 1 本しか無いため、ここで選ばれなかったタスクは
// 画面から見えない。並べ替えるときは「止めたくなる可能性が高い方を上」で判断すること。
import { useMemo } from 'react'
import { useExportStore } from '../stores/exportStore'
import { t } from '../i18n'

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export interface UseActiveTaskOptions {
  // AI タグ付けモデルのダウンロード進捗（0〜1）。走っていなければ null。
  taggerProgress: number | null
  onCancelDownload: () => void
  // AI タグ付けの進捗（処理済み / 総数）。走っていなければ null。
  retagProgress: { current: number; total: number } | null
  onCancelRetag: () => void
}

export function useActiveTask({ taggerProgress, onCancelDownload, retagProgress, onCancelRetag }: UseActiveTaskOptions) {
  // 書き出し・共有取り込みの進捗はストアから直接読む（App を経由させる意味が無い）。
  const exportProgress = useExportStore((st) => st.exportProgress)
  const exportKind = useExportStore((st) => st.exportKind)
  const shareImportProgress = useExportStore((st) => st.shareImportProgress)

  const activeTask = useMemo(() => {
    if (taggerProgress !== null) {
      return {
        label: t('task.modelDownloading'),
        detail: `${Math.round(taggerProgress * 100)}%`,
        progress: clamp01(taggerProgress),
        onCancel: onCancelDownload,
      }
    }
    if (retagProgress) {
      const { current, total } = retagProgress
      return {
        label: t('task.retagging'),
        detail: `${current}/${total}`,
        progress: total > 0 ? clamp01(current / total) : 0,
        onCancel: onCancelRetag,
      }
    }
    if (shareImportProgress) {
      const { current, total } = shareImportProgress
      return {
        label: t('task.libraryImporting'),
        detail: `${current}/${total}`,
        progress: total > 0 ? clamp01(current / total) : 0,
        onCancel: () => window.api.shareImportCancel(),
      }
    }
    if (!exportProgress) return null

    const { current, total } = exportProgress
    return {
      // W-4: share 起点の進捗は SettingsModal の「エクスポート中...」と表示を揃える
      label: t(exportKind === 'share' ? 'task.libraryExporting' : 'task.exporting'),
      detail: `${current}/${total}`,
      progress: total > 0 ? clamp01(current / total) : 0,
      onCancel: exportKind === 'share' ? () => window.api.shareExportCancel() : () => window.api.imagesExportCancel(),
    }
  }, [onCancelDownload, onCancelRetag, retagProgress, taggerProgress, shareImportProgress, exportProgress, exportKind])

  return activeTask
}
