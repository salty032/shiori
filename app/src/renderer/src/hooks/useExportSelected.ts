// 選択した画像の書き出し。useSelection.ts から切り出した。
//
// **進捗と中止は images/share で 1 系統しかない。** 共有書き出しの最中に選択エクスポートを
// 始めると、進捗バーと中止ボタンがどちらのものか分からなくなる（B-6）。ここで片方に絞る。
//
// 動画をどの形式で置くかは設定（設定 > データ > 動画の書き出し形式）で決まる。ここは
// 形式を渡さない——main が書き出しの直前に設定を読む。
import type { ShowToast } from './useToast'
import { useExportStore } from '../stores/exportStore'
import { t, tp } from '../i18n'

export interface UseExportSelectedOptions {
  // 引数なしで呼ばれたときの対象。グリッドの選択をその場で読む。
  getDefaultIds: () => number[]
  showToast: ShowToast
}

export function useExportSelected({ getDefaultIds, showToast }: UseExportSelectedOptions) {
  return async function exportSelected(ids: number[] = getDefaultIds()): Promise<void> {
    // export:progress チャンネル・中止ボタンは images/share の1系統しかないため、共有書き出しが
    // 進行中に選択エクスポートを始めると進捗・中止が混線する（B-6）。片方が完了するまで待たせる。
    if (useExportStore.getState().exportKind !== null) {
      showToast(t('toast.exportBusy'), 'warning')
      return
    }
    useExportStore.getState().startExport('images')
    try {
      const result = await window.api.exportImages(ids)
      if (result.canceled) {
        // count がある = 中止ボタンでの途中キャンセル。ない = フォルダ選択自体のキャンセル（無言）。
        if (result.count != null) showToast(tp('toast.exportStopped', result.count), 'warning')
      } else if (result.count != null) {
        // U-2: エクスポートID上限（MAX_EXPORT_IDS）到達を明示する
        const truncatedMsg = result.truncated ? t('toast.exportTruncatedSuffix') : ''
        // H.264 を選んでいるのに変換できなかったぶん。**黙って webm を置くと、mp4 で
        // 出したつもりのまま気づけない。** 成功トーストに混ぜず警告色へ倒す。
        const notConverted = result.notConverted ?? 0
        const notConvertedMsg = notConverted > 0
          ? t('toast.exportNotConvertedSuffix', { count: String(notConverted) })
          : ''
        const warn = result.truncated || notConverted > 0
        showToast(tp('toast.exported', result.count) + truncatedMsg + notConvertedMsg, warn ? 'warning' : 'success')
      }
    } catch (err) {
      console.error('[export] failed', err)
      showToast(t('toast.exportFailed'), 'error')
    } finally {
      // 通常は onExportProgress 側（current>=total）でクリアされるが、途中キャンセル・
      // 進捗が1件も届かない失敗ケースの保険としてここでも念のためクリアする。
      useExportStore.getState().clearExport()
    }
  }
}
