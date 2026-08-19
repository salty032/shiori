// 削除の猶予・確定・取り消し。useSelection.ts から切り出した。
//
// 削除は押した瞬間には確定しない。一覧からは即座に外し（見た目は消える）、猶予のあいだ
// スナップショットを持ったまま待ってから DB へ流す。この「見えていないが消えていない」
// 状態を持つのがこのファイルの役目で、選択・矩形選択とは独立している。
//
// 選択の付け替え（削除後にどれを選ぶか・Undo でどれに戻すか）は選択側の担当なので、
// selectAfterDelete / restoreSelectionAfterUndo として呼び出し元から受け取る。
import { useEffect, useRef } from 'react'
import type { ImageRow, DeleteImageResult } from '../types'
import type { DismissToast, ShowToast, UpdateToast } from './useToast'
import type { RemovedImagesSnapshot } from '../stores/imageStore'
import { markPendingDelete, unmarkPendingDelete } from '../stores/imageStore'
import { MAX_BULK_IDS } from '../../../shared/constants'
import { t, tp } from '../i18n'

// 削除の取り消し猶予。トーストが消えた後も Ctrl+Z で戻せるよう、**表示時間より長くとる**。
// トースト自体を猶予いっぱい出しっぱなしにすると、連続削除で同じ通知が積み上がって邪魔になる。
// 見えている間だけしか戻せないわけではないことは、トーストの文言（toast.deleted）で伝える。
const DELETE_UNDO_MS = 15000
const DELETE_TOAST_MS = 4000

// 猶予（DELETE_UNDO_MS）が明けるまで確定しない削除 1 件分。
type PendingDelete = {
  ids: Set<number>
  snapshot: RemovedImagesSnapshot
  selectedBefore: Set<number>
  timer: number
  // 「元に戻す」付きトーストの id。Undo（クリック／Ctrl+Z どちらでも）が成立したら
  // このトーストを即座に消す。放置すると Undo 後も「元に戻す」ボタンが残り、
  // 押しても何も起きない（既に戻し済み）状態になる（BUG-8）。
  toastId?: number
  // ビューア内削除（deleteViewerImage）由来のときだけ、削除した画像の id を持つ。
  // この削除が Undo されたとき、ビューアをその画像へ戻すために使う。
  viewerRestoreId?: number
}

async function deleteImages(
  ids: Set<number>,
  showToast: ShowToast,
  updateToast: UpdateToast,
  dismissToast: DismissToast,
  onFailed?: (ids: Set<number>) => void,
  showProgress = true,
): Promise<void> {
  const idList = [...ids]
  // DB 削除は main 側で 1 トランザクションにまとめ、ファイル削除も main 側で逐次ベストエフォート
  // 実行する（B-7）。件数が多いと時間がかかるため、少し待っても終わらない場合だけ
  // 「削除中...」を表示する（すぐ終わるなら出さずチラつきを避ける）。完了時は同じトースト
  // （progressToastId）を updateToast で差し替える（トーストがスタック化されて以降、新規
  // showToast だと「削除中...」と完了メッセージが両方残ってしまうため）。
  let progressTimer: number | null = null
  let progressToastId: number | null = null
  if (showProgress) {
    progressTimer = window.setTimeout(() => {
      progressTimer = null
      progressToastId = showToast(tp('toast.deleting', idList.length), 'info', 60000)
    }, 400)
  }

  let results: DeleteImageResult[]
  try {
    // main 側の images:deleteBulk は1回あたり MAX_BULK_IDS 件までしか受け付けないため
    // （他の bulk IPC と揃えた上限）、Ctrl+A の最大5000件のような大きな選択はチャンクに分けて呼ぶ。
    results = []
    for (let i = 0; i < idList.length; i += MAX_BULK_IDS) {
      const chunk = idList.slice(i, i + MAX_BULK_IDS)
      try {
        results.push(...await window.api.deleteImagesBulk(chunk))
      } catch (err) {
        // このチャンクの invoke 自体が失敗すると成否が不明（前のチャンクは DB 削除済みの可能性が
        // 高い）。ここで throw して呼び出し元に snapshot 全体を復元させると、既に削除済みの分が
        // 「DB に無いのに一覧には残る」ゴースト表示になる（N-3）。以降を全て未処理扱いにして
        // ループを打ち切り、既存の ok:false 経路（onFailed による部分復元）に乗せる。
        console.error('[delete] chunk invoke failed', err)
        for (const id of idList.slice(i)) results.push({ ok: false, id, error: 'ipc failed' })
        break
      }
    }
  } finally {
    if (progressTimer !== null) window.clearTimeout(progressTimer)
  }

  const notify = (message: string, tone: Parameters<ShowToast>[1], ms?: number): void => {
    if (progressToastId !== null) updateToast(progressToastId, message, tone, ms)
    else showToast(message, tone, ms)
  }

  const deletedIds = new Set(results.filter((result) => result.ok).map((result) => result.id))
  const failedCount = results.length - deletedIds.size
  if (failedCount > 0) {
    const failedIds = new Set(results.filter((result) => !result.ok).map((result) => result.id))
    onFailed?.(failedIds)
    const message = deletedIds.size > 0
      ? t('toast.deletedPartial', { deleted: deletedIds.size, failed: failedCount })
      : t('toast.deleteFailed')
    notify(message, failedCount === results.length ? 'error' : 'warning')
    return
  }
  // 成功時の通知はしない。deleteImages は必ず queueDelete が「元に戻す」付きの
  // 楽観的トーストを出した後にしか呼ばれないため（呼び出し元は commitPendingDelete のみ）、
  // ここでも成功を告げると同じ内容のトーストが時間差で二重に出てしまう。
  if (progressToastId !== null) dismissToast(progressToastId)
}

// 削除直後の短時間はダブルクリックでのビューアオープンを無視する（openSuppressed）。
// 「選択→急いで Delete」を素早く行うと、削除で一覧が詰まって同じ画面位置に別の画像が
// スライドしてくるため、2クリック目がその新しい画像への意図しないダブルクリックとして
// 判定され、ビューアが開いてしまうことがある。
const SUPPRESS_OPEN_AFTER_DELETE_MS = 400

export interface UsePendingDeletionOptions {
  // 選択・一覧・ビューア位置の最新値。猶予タイマーや pagehide から遅れて読むため ref で持つ。
  latestRef: React.MutableRefObject<{ selectedIds: Set<number>; images: ImageRow[]; viewerIdx: number | null }>
  setViewerId: (id: number | null) => void
  showToast: ShowToast
  updateToast: UpdateToast
  dismissToast: DismissToast
  restoreImages: (snapshot: RemovedImagesSnapshot, ids?: Set<number>) => void
  // 削除が DB に確定した後のサイドバー再取得。猶予タイマー・pagehide からも走るため ref。
  libraryChangedRef: React.MutableRefObject<() => void>
  // 一覧から外し、次に選ぶものを決める（選択側の担当）。戻り値は復元用スナップショット。
  selectAfterDelete: (ids: Set<number>) => RemovedImagesSnapshot
  restoreSelectionAfterUndo: (selectedBefore: Set<number>) => void
}

export function usePendingDeletion({
  latestRef,
  setViewerId,
  showToast,
  updateToast,
  dismissToast,
  restoreImages,
  libraryChangedRef,
  selectAfterDelete,
  restoreSelectionAfterUndo,
}: UsePendingDeletionOptions) {
  // 猶予中の削除は**同時に複数持てる**（古い順）。以前は1件だけ保持し、次の削除が来た瞬間に
  // 前の分を確定させていたため、続けて2枚消すと1枚目はもう戻せなかった（しかも画面上は
  // 「元に戻す」トーストが消えるだけで、戻せなくなったとは分からない）。
  const pendingDeletesRef = useRef<PendingDelete[]>([])

  function commitPendingDelete(pending: PendingDelete, showProgress = true): void {
    window.clearTimeout(pending.timer)
    deleteImages(
      pending.ids,
      showToast,
      updateToast,
      dismissToast,
      (failedIds) => {
        restoreImages(pending.snapshot, failedIds)
        unmarkPendingDelete(failedIds)
      },
      showProgress,
    ).then(() => {
      // 成功した分・既に onFailed で解除済みの分を含め、保留マークを確実に外す
      // （Set.delete は存在しない id に対しても安全）。
      unmarkPendingDelete(pending.ids)
    }).catch((err) => {
      console.error('[delete] failed', err)
      restoreImages(pending.snapshot)
      unmarkPendingDelete(pending.ids)
      showToast(t('toast.deleteFailed'), 'error')
    }).then(() => {
      // 成否によらず取り直す。一部だけ削除できた場合も集計は変わっており、全滅した場合も
      // 「取り直した結果が同じ」だけで害はない。ここを成功時だけにすると、部分失敗の
      // 経路でサイドバーが古いままになる。
      libraryChangedRef.current()
    })
  }

  // 取り消すのは常に一番新しい削除から。連続で消したときは、押した回数だけ新しい順に戻る。
  function undoPendingDelete(): boolean {
    const pending = pendingDeletesRef.current.pop()
    if (!pending) return false
    window.clearTimeout(pending.timer)
    unmarkPendingDelete(pending.ids)
    if (pending.toastId != null) dismissToast(pending.toastId)
    // ビューアを開いたまま削除して Undo したなら、その画像へ戻す（復元で一覧に戻るため、
    // id を指し直すだけで表示位置は自動的に付いてくる）。
    if (pending.viewerRestoreId != null && latestRef.current.viewerIdx !== null) {
      setViewerId(pending.viewerRestoreId)
    }
    restoreImages(pending.snapshot)
    restoreSelectionAfterUndo(pending.selectedBefore)
    showToast(t('toast.deleteUndone'), 'info')
    return true
  }

  const lastDeleteAtRef = useRef(0)

  function queueDelete(ids: Set<number>): void {
    if (ids.size === 0) return
    lastDeleteAtRef.current = performance.now()
    const selectedBefore = new Set(latestRef.current.selectedIds)
    const snapshot = selectAfterDelete(ids)
    markPendingDelete(ids)
    const pending: PendingDelete = {
      ids,
      snapshot,
      selectedBefore,
      timer: window.setTimeout(() => {
        const list = pendingDeletesRef.current
        const idx = list.indexOf(pending)
        if (idx < 0) return
        list.splice(idx, 1)
        commitPendingDelete(pending)
      }, DELETE_UNDO_MS),
    }
    pendingDeletesRef.current.push(pending)
    // トーストは猶予（DELETE_UNDO_MS）より短く出す。長く出すと連続削除で積み上がるため。
    // 消えた後も Ctrl+Z で戻せることは文言側（toast.deleted）に書いてある。
    pending.toastId = showToast(
      tp('toast.deleted', ids.size),
      'success',
      DELETE_TOAST_MS,
      { label: t('action.undo'), onClick: undoPendingDelete },
    )
  }

  // ビューア表示中に Delete された1枚だけを対象にした削除。削除後に同じ位置へ来る画像
  // （末尾なら1つ前、残り0枚なら閉じる）を先に決め、その id へ移してから削除する。
  function deleteViewerImage(id: number, currentViewerIdx: number): void {
    const remaining = latestRef.current.images.filter((img) => img.id !== id)
    const next = remaining.length > 0 ? remaining[Math.min(currentViewerIdx, remaining.length - 1)] : null
    queueDelete(new Set([id]))
    // queueDelete が積んだ直後なので、末尾がこの削除。Undo したときビューアが
    // 元の画像へ戻れるよう印を付けておく。
    const queued = pendingDeletesRef.current.at(-1)
    if (queued) queued.viewerRestoreId = id
    setViewerId(next?.id ?? null)
  }

  useEffect(() => {
    const flushPendingDelete = (): void => {
      const list = pendingDeletesRef.current
      if (list.length === 0) return
      pendingDeletesRef.current = []
      for (const pending of list) commitPendingDelete(pending, false)
    }
    // トレイの「終了」等でウィンドウごと畳まれる場合、この effect のクリーンアップは
    // JS コンテキストごと破棄されるため走らない。pagehide はウィンドウが閉じる過程で
    // React のアンマウントより前に確実に発火するので、Undo 猶予の途中で
    // 終了しても「削除しました」の内容どおり削除が実行されるようにする
    // （main 側の IPC ハンドラは応答を待たれなくても独立して完走する）。
    window.addEventListener('pagehide', flushPendingDelete)
    return () => {
      window.removeEventListener('pagehide', flushPendingDelete)
      flushPendingDelete()
    }
  }, [])

  // 削除直後か（ダブルクリックでのビューアオープンを無視する判定）。
  function openSuppressed(): boolean {
    return performance.now() - lastDeleteAtRef.current < SUPPRESS_OPEN_AFTER_DELETE_MS
  }

  return { queueDelete, deleteViewerImage, undoPendingDelete, openSuppressed }
}
