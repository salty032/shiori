// 選択した画像の書き出し。useSelection.ts から切り出した。
//
// **進捗と中止は images/share で 1 系統しかない。** 共有書き出しの最中に選択エクスポートを
// 始めると、進捗バーと中止ボタンがどちらのものか分からなくなる（B-6）。ここで片方に絞る。
//
// 動画をどの形式で置くかは設定（設定 > データ > 動画の書き出し形式）で決まる。ここは
// 形式を渡さない——main が書き出しの直前に設定を読む。
//
// **書き出しを途中で欠けさせない**（ipc-images.ts）。元ファイルの無い画像があれば何も書かずに
// 戻ってくるので、残りを書き出すかここで聞く。書き出し先に保存できなければ、書いた分も消えて戻る。
import type { ShowToast } from './useToast'
import type { ConfirmDialogState } from './useConfirmActions'
import { useExportStore } from '../stores/exportStore'
import { t, tp } from '../i18n'

export interface UseExportSelectedOptions {
  // 引数なしで呼ばれたときの対象。グリッドの選択をその場で読む。
  getDefaultIds: () => number[]
  showToast: ShowToast
  setConfirmDialog: (state: ConfirmDialogState | null) => void
}

export function useExportSelected({ getDefaultIds, showToast, setConfirmDialog }: UseExportSelectedOptions) {
  async function run(ids: number[], skipMissing: boolean): Promise<void> {
    // export:progress チャンネル・中止ボタンは images/share の1系統しかないため、共有書き出しが
    // 進行中に選択エクスポートを始めると進捗・中止が混線する（B-6）。片方が完了するまで待たせる。
    if (useExportStore.getState().exportKind !== null) {
      showToast(t('toast.exportBusy'), 'warning')
      return
    }
    useExportStore.getState().startExport('images')
    try {
      const result = await window.api.exportImages(ids, skipMissing ? { skipMissing: true } : undefined)
      if (result.canceled) {
        // count がある = 中止ボタンでの途中キャンセル。ない = フォルダ選択自体のキャンセル（無言）。
        if (result.count != null) showToast(tp('toast.exportStopped', result.count), 'warning')
      } else if ('missing' in result) {
        if (result.exportable === 0) {
          showToast(t('toast.exportAllMissing'), 'error')
        } else {
          setConfirmDialog({
            title: t('action.export'),
            message: t('dialog.exportMissing.message', { missing: String(result.missing), rest: String(result.exportable) }),
            confirmLabel: t('dialog.exportMissing.proceed'),
            onConfirm: () => { void run(ids, true) },
          })
        }
      } else if ('writeFailed' in result) {
        showToast(t('toast.exportWriteFailed'), 'error')
      } else {
        // U-2: エクスポートID上限（MAX_EXPORT_IDS）到達を明示する
        const truncatedMsg = result.truncated ? t('toast.exportTruncatedSuffix') : ''
        // H.264 を選んでいるのに変換できなかったぶん。**黙って webm を置くと、mp4 で
        // 出したつもりのまま気づけない。** 成功トーストに混ぜず警告色へ倒す。
        const notConvertedMsg = result.notConverted > 0
          ? t('toast.exportNotConvertedSuffix', { count: String(result.notConverted) })
          : ''
        const warn = result.truncated || result.notConverted > 0
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

  return async function exportSelected(ids: number[] = getDefaultIds()): Promise<void> {
    if (ids.length === 0) {
      showToast(t('toast.exportNothingSelected'), 'warning')
      return
    }
    await run(ids, false)
  }
}
