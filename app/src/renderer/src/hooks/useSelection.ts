import { useEffect, useRef, useState } from 'react'
import type { ImageRow, DeleteImageResult } from '../types'
import type { DismissToast, ShowToast, UpdateToast } from './useToast'
import type { RemovedImagesSnapshot } from '../stores/imageStore'
import { markPendingDelete, unmarkPendingDelete } from '../stores/imageStore'
import { selectQueryKey, getCommitted, useFilterStore } from '../stores/filterStore'
import { buildImageQuery } from '../stores/imageQuery'
import { useExportStore } from '../stores/exportStore'
import { useLatestRef } from './useLatestRef'
import { MAX_BULK_IDS } from '../../../shared/constants'
import { t, tp, currentLocale } from '../i18n'

const AUTO_SCROLL_EDGE = 72
const AUTO_SCROLL_MAX_SPEED = 18
const SELECTION_HISTORY_LIMIT = 30
const DELETE_UNDO_MS = 4000
const GRID_NAV_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'] as const

function sameIds(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

export interface GridLayout {
  gridRef: React.RefObject<HTMLDivElement | null>
  timelineRef: React.RefObject<HTMLDivElement | null>
  scrollRef: React.RefObject<HTMLDivElement | null>
  columns: number
  cellWidth: number
  cellHeight: number
  rowHeight: number
  // 実描画（App.tsx の COL_GAP/ROW_GAP）と同じ値を渡すこと。ここが実描画とズレると、
  // 列数が多いとき矩形選択の当たり判定が右端付近で数px〜数十pxずれる。
  colGap: number
  rowGap: number
}

export function hitTestBox(
  ax: number, ay: number, cx: number, cy: number,
  images: ImageRow[],
  columns: number, cellWidth: number, cellHeight: number, rowHeight: number,
  colGap: number, rowGap: number,
): Set<number> {
  const box = { left: Math.min(ax, cx), top: Math.min(ay, cy), right: Math.max(ax, cx), bottom: Math.max(ay, cy) }
  const next = new Set<number>()
  if (columns <= 0 || cellWidth <= 0) return next
  images.forEach((img, i) => {
    const row = Math.floor(i / columns)
    const col = i % columns
    const left = col * (cellWidth + colGap)
    const top = row * rowHeight
    const hitHeight = Math.max(cellHeight, rowHeight - rowGap)
    if (left < box.right && left + cellWidth > box.left && top < box.bottom && top + hitHeight > box.top) {
      next.add(img.id)
    }
  })
  return next
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

export interface UseSelectionOptions {
  // 現在アクティブな一覧（グリッド or タイムラインの並び）。選択・矢印移動の基準。
  images: ImageRow[]
  viewerIdx: number | null
  // ビューアの表示対象は id で持つ（App）。位置ではなく id を渡すことで、削除・Undo・
  // 一覧の差し替えを跨いでも「どの画像を見ているか」がそのまま保たれる。null で閉じる。
  setViewerId: (id: number | null) => void
  showToast: ShowToast
  updateToast: UpdateToast
  dismissToast: DismissToast
  gridLayout: GridLayout
  navigationColumnsRef: React.MutableRefObject<number>
  scrollToIndex: (idx: number) => void
  // 削除を両リスト＋件数に一元反映する（imageStore.removeImages）。
  removeImages: (ids: Set<number>) => RemovedImagesSnapshot
  restoreImages: (snapshot: RemovedImagesSnapshot, ids?: Set<number>) => void
  // グリッド表示中のみ true。矩形選択はグリッドでは仮想リスト用の座標計算、
  // タイムラインでは実 DOM のサムネイル矩形を使って当たり判定する。
  gridActiveRef: React.MutableRefObject<boolean>
  // 削除が DB に確定した後のサイドバー再取得（タグ一覧・サービス一覧）。画像が消えれば
  // その画像にしか付いていなかったタグ・サービスはライブラリから消えるが、renderer が
  // 持っている集計は起動時・タグ操作時にしか更新されないため、ここで明示的に取り直す。
  onLibraryChanged: () => void
}

export function useSelection({
  images,
  viewerIdx,
  setViewerId,
  showToast,
  updateToast,
  dismissToast,
  gridLayout,
  navigationColumnsRef,
  scrollToIndex,
  removeImages,
  restoreImages,
  gridActiveRef,
  onLibraryChanged,
}: UseSelectionOptions) {
  const [selectedIds, setSelectedIdsState] = useState<Set<number>>(new Set())
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set())
  const [selBox, setSelBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  // 確定フィルタの同一性。変化したら選択をクリアする（下の useEffect）。
  const filterQueryKey = useFilterStore(selectQueryKey)
  // 「次のフィルタ変更ではクリアしない」一度きりのフラグ（色フィルタ等で選択維持）。
  const preserveSelectionRef = useRef(false)

  const selectionHistory = useRef<Set<number>[]>([])
  const selectionRedoHistory = useRef<Set<number>[]>([])
  const rubberAnchor = useRef<{ clientX: number; clientY: number; localX: number; localY: number } | null>(null)
  const rubberStartedFromThumb = useRef(false)
  // サムネから始まったドラッグの起点となった画像 id（他アプリへのドラッグ&ドロップ用）。
  // 選択状態（selectedIds）は mousedown 直後だと latestRef にまだ反映されていないことが
  // あるため、この id を単独ドラッグのフォールバックとして使う。
  const dragThumbId = useRef<number | null>(null)
  // 自分のウィンドウから始めた画像ドラッグが進行中か。落とし返されたときにドロップ枠を
  // 出さないための表示用フラグ（App.tsx）。二重取り込みを防ぐ本体は main 側のパス判定
  // （ipc-drag.ts の isDragTempPath）で、こちらが取りこぼしても取り込みは起きない。
  const selfDragRef = useRef(false)
  // 複数選択中のサムネを修飾キーなしで押したとき、「この1枚だけの選択に畳む」処理を
  // mouseup まで保留するための index。押した瞬間に畳んでしまうと、複数選択をまとめて
  // 掴みたいだけなのに 1 枚に減ってから始まってしまう（エクスプローラ等は離すまで畳まない）。
  const collapseOnMouseUp = useRef<number | null>(null)
  const rubberCurrent = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const rubberCtrl = useRef(false)
  const autoScrollFrame = useRef<number | null>(null)
  const autoScrollSpeed = useRef(0)
  const rubberHitFrame = useRef<number | null>(null)
  const anchorIdx = useRef<number | null>(null)
  const focusIdx = useRef<number | null>(null)
  // focusIdx はキー入力の同期処理用（ref のみだと再描画されない）。視覚表示（フォーカス枠）が
  // 必要なときだけ setFocusIdx 経由で React state 側にも反映し、それ以外の内部計算は
  // 従来どおり focusIdx.current を直接読む（毎ステップ再描画を避けるため）。
  const [focusedIndex, setFocusedIndexState] = useState<number | null>(null)
  function setFocusIdx(next: number | null): void {
    focusIdx.current = next
    setFocusedIndexState(next)
  }
  const latestRef = useRef({ selectedIds, images, viewerIdx })
  useEffect(() => { latestRef.current = { selectedIds, images, viewerIdx } })
  // 削除の確定は猶予タイマー・pagehide（空依存 effect）からも走るため、そのときの
  // クロージャに固まった古い関数ではなく常に最新のものを呼ぶ。
  const libraryChangedRef = useLatestRef(onLibraryChanged)
  const pendingDeleteRef = useRef<{
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
  } | null>(null)

  const latestLayoutRef = useRef(gridLayout)
  useEffect(() => { latestLayoutRef.current = gridLayout })

  const scrollToIndexRef = useRef(scrollToIndex)
  useEffect(() => { scrollToIndexRef.current = scrollToIndex })

  function setSelectedIds(update: React.SetStateAction<Set<number>>): void {
    setSelectedIdsState((prev) => {
      const next = typeof update === 'function' ? update(prev) : update
      if (sameIds(prev, next)) return prev
      selectionHistory.current.push(new Set(prev))
      if (selectionHistory.current.length > SELECTION_HISTORY_LIMIT) selectionHistory.current.shift()
      selectionRedoHistory.current = []
      return next
    })
  }

  // フィルタ確定値が変わったら選択をクリアする。旧 App の clearSelectionRef を
  // useSelection に内製化したもの（imageList→selection の循環依存を解消）。
  // フィルタ前に preserveSelectionOnce() を呼ぶと、その 1 回だけクリアをスキップする。
  useEffect(() => {
    if (preserveSelectionRef.current) { preserveSelectionRef.current = false; return }
    setSelectedIds(new Set())
    anchorIdx.current = null
    setFocusIdx(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterQueryKey])

  function preserveSelectionOnce(): void { preserveSelectionRef.current = true }

  function clearSelection(): void {
    setSelectedIds(new Set())
    anchorIdx.current = null
    setFocusIdx(null)
  }

  function undoSelection(): void {
    const previous = selectionHistory.current.pop()
    if (!previous) return
    setSelectedIdsState((current) => {
      selectionRedoHistory.current.push(new Set(current))
      if (selectionRedoHistory.current.length > SELECTION_HISTORY_LIMIT) selectionRedoHistory.current.shift()
      return previous
    })
  }

  function redoSelection(): void {
    const next = selectionRedoHistory.current.pop()
    if (!next) return
    setSelectedIdsState((current) => {
      selectionHistory.current.push(new Set(current))
      if (selectionHistory.current.length > SELECTION_HISTORY_LIMIT) selectionHistory.current.shift()
      return next
    })
  }

  function selectAfterDelete(ids: Set<number>): RemovedImagesSnapshot {
    const images = latestRef.current.images
    const minIdx = images.findIndex((img) => ids.has(img.id))
    const remaining = images.filter((img) => !ids.has(img.id))
    selectionHistory.current = []
    selectionRedoHistory.current = []
    if (remaining.length > 0) {
      const nextIdx = Math.min(minIdx >= 0 ? minIdx : 0, remaining.length - 1)
      setSelectedIdsState(new Set([remaining[nextIdx].id]))
      anchorIdx.current = nextIdx
      setFocusIdx(nextIdx)
    } else {
      setSelectedIdsState(new Set())
      anchorIdx.current = null
      setFocusIdx(null)
    }
    // 配列の除去・件数調整は両リストを束ねるストアに委譲（grid/timeline 同時反映）。
    return removeImages(ids)
  }

  function restoreSelectionAfterUndo(selectedBefore: Set<number>): void {
    setSelectedIdsState(new Set(selectedBefore))
    anchorIdx.current = null
    setFocusIdx(null)
  }

  function commitPendingDelete(pending: NonNullable<typeof pendingDeleteRef.current>, showProgress = true): void {
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

  function undoPendingDelete(): boolean {
    const pending = pendingDeleteRef.current
    if (!pending) return false
    pendingDeleteRef.current = null
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

  // 削除直後の短時間はダブルクリックでのビューアオープンを無視する（openIndex 参照）。
  const lastDeleteAtRef = useRef(0)
  // 「選択→急いで Delete」を素早く行うと、削除で一覧が詰まって同じ画面位置に別の画像が
  // スライドしてくるため、2クリック目がその新しい画像への意図しないダブルクリックとして
  // 判定され、ビューアが開いてしまうことがある。削除直後の短時間はオープンを無視して防ぐ。
  const SUPPRESS_OPEN_AFTER_DELETE_MS = 400

  function queueDelete(ids: Set<number>): void {
    if (ids.size === 0) return
    lastDeleteAtRef.current = performance.now()
    const previous = pendingDeleteRef.current
    if (previous) {
      pendingDeleteRef.current = null
      // 前回分はもう Undo 対象ではなくなる（早期確定）ので、出しっぱなしの
      // 「元に戻す」トーストも一緒に消す（放置すると押しても無反応のまま残る）。
      if (previous.toastId != null) dismissToast(previous.toastId)
      commitPendingDelete(previous, false)
    }
    const selectedBefore = new Set(latestRef.current.selectedIds)
    const snapshot = selectAfterDelete(ids)
    markPendingDelete(ids)
    const pending: NonNullable<typeof pendingDeleteRef.current> = {
      ids,
      snapshot,
      selectedBefore,
      timer: window.setTimeout(() => {
        if (pendingDeleteRef.current !== pending) return
        pendingDeleteRef.current = null
        commitPendingDelete(pending)
      }, DELETE_UNDO_MS),
    }
    pendingDeleteRef.current = pending
    // ms はここだけ既定値（トーンごとの自動値）に任せず DELETE_UNDO_MS を明示する。
    // トーストの表示時間と「まだ元に戻せる」実際の猶予（上の setTimeout）を必ず一致させるため。
    pending.toastId = showToast(
      tp('toast.deleted', ids.size),
      'success',
      DELETE_UNDO_MS,
      { label: t('action.undo'), onClick: undoPendingDelete },
    )
  }

  // ビューア表示中に Delete された1枚だけを対象にした削除。削除後に同じ位置へ来る画像
  // （末尾なら1つ前、残り0枚なら閉じる）を先に決め、その id へ移してから削除する。
  function deleteViewerImage(id: number, currentViewerIdx: number): void {
    const remaining = latestRef.current.images.filter((img) => img.id !== id)
    const next = remaining.length > 0 ? remaining[Math.min(currentViewerIdx, remaining.length - 1)] : null
    queueDelete(new Set([id]))
    // queueDelete が pendingDeleteRef に積んだ直後なので、この削除だけを Undo したとき
    // ビューアが元の画像へ戻れるよう印を付けておく。
    if (pendingDeleteRef.current) pendingDeleteRef.current.viewerRestoreId = id
    setViewerId(next?.id ?? null)
  }

  function openIndex(idx: number): void {
    if (performance.now() - lastDeleteAtRef.current < SUPPRESS_OPEN_AFTER_DELETE_MS) return
    const img = latestRef.current.images[idx]
    if (img) setViewerId(img.id)
  }

  function selectIndex(idx: number, modifiers?: { shift?: boolean; ctrl?: boolean; meta?: boolean }): void {
    const images = latestRef.current.images
    if (idx < 0 || idx >= images.length) return
    const id = images[idx].id
    const additive = Boolean(modifiers?.ctrl || modifiers?.meta)
    const rangeMode = Boolean(modifiers?.shift)

    if (rangeMode && anchorIdx.current !== null) {
      const from = Math.min(anchorIdx.current, idx)
      const to = Math.max(anchorIdx.current, idx)
      const range = new Set(images.slice(from, to + 1).map((img) => img.id))
      if (additive) {
        setSelectedIds((prev) => { const next = new Set(prev); range.forEach((id) => next.add(id)); return next })
      } else {
        setSelectedIds(range)
      }
      setFocusIdx(idx)
    } else if (additive) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id); else next.add(id)
        if (next.size === 0) {
          anchorIdx.current = null
          setFocusIdx(null)
        } else {
          anchorIdx.current = idx
          setFocusIdx(idx)
        }
        return next
      })
    } else {
      setSelectedIds(new Set([id]))
      anchorIdx.current = idx
      setFocusIdx(idx)
    }
  }

  function selectionRoot(): HTMLDivElement | null {
    const { gridRef, timelineRef } = latestLayoutRef.current
    return gridActiveRef.current ? gridRef.current : timelineRef.current
  }

  function clientToSelectionLocal(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = selectionRoot()?.getBoundingClientRect()
    return rect ? { x: clientX - rect.left, y: clientY - rect.top } : null
  }

  function isInSelectionArea(clientX: number, clientY: number, target: EventTarget | null): boolean {
    const rootRect = selectionRoot()?.getBoundingClientRect()
    const scrollRect = latestLayoutRef.current.scrollRef.current?.getBoundingClientRect()
    if (!rootRect || !scrollRect) return false
    const targetEl = target instanceof HTMLElement ? target : null
    const startsFromScrollBackground = targetEl === latestLayoutRef.current.scrollRef.current
    const top = startsFromScrollBackground ? scrollRect.top : rootRect.top
    return (
      clientX >= scrollRect.left &&
      clientX <= scrollRect.right &&
      clientY >= top &&
      clientY <= scrollRect.bottom
    )
  }

  function hitTestDomBox(ax: number, ay: number, cx: number, cy: number): Set<number> {
    const root = selectionRoot()
    const next = new Set<number>()
    if (!root) return next
    const rootRect = root.getBoundingClientRect()
    const box = { left: Math.min(ax, cx), top: Math.min(ay, cy), right: Math.max(ax, cx), bottom: Math.max(ay, cy) }
    root.querySelectorAll<HTMLElement>('[data-img-id]').forEach((el) => {
      const rect = el.getBoundingClientRect()
      const item = {
        left: rect.left - rootRect.left,
        top: rect.top - rootRect.top,
        right: rect.right - rootRect.left,
        bottom: rect.bottom - rootRect.top,
      }
      if (item.left < box.right && item.right > box.left && item.top < box.bottom && item.bottom > box.top) {
        const id = Number(el.dataset.imgId)
        if (Number.isFinite(id)) next.add(id)
      }
    })
    return next
  }

  function hitTestSelectionBox(ax: number, ay: number, cx: number, cy: number): Set<number> {
    if (!gridActiveRef.current) return hitTestDomBox(ax, ay, cx, cy)
    const { columns, cellWidth, cellHeight, rowHeight, colGap, rowGap } = latestLayoutRef.current
    return hitTestBox(ax, ay, cx, cy, latestRef.current.images, columns, cellWidth, cellHeight, rowHeight, colGap, rowGap)
  }

  function updateRubberHit(clientX: number, clientY: number): void {
    const anchor = rubberAnchor.current
    if (!anchor) return
    const current = clientToSelectionLocal(clientX, clientY)
    if (!current) return
    setSelBox({
      x: Math.min(anchor.localX, current.x),
      y: Math.min(anchor.localY, current.y),
      w: Math.abs(current.x - anchor.localX),
      h: Math.abs(current.y - anchor.localY),
    })
    setPendingIds(hitTestSelectionBox(anchor.localX, anchor.localY, current.x, current.y))
  }

  // updateRubberHit は読み込み済み画像全件を走査するため、生の mousemove レート
  // （高ポーリングマウスだと数百Hz）でそのまま呼ぶとライブラリが大きい時にカクつく。
  // 1フレームに1回（最新座標のみ）に間引く。
  function cancelScheduledRubberHit(): void {
    if (rubberHitFrame.current !== null) {
      window.cancelAnimationFrame(rubberHitFrame.current)
      rubberHitFrame.current = null
    }
  }

  function scheduleRubberHit(): void {
    if (rubberHitFrame.current !== null) return
    rubberHitFrame.current = window.requestAnimationFrame(() => {
      rubberHitFrame.current = null
      if (!rubberAnchor.current) return
      updateRubberHit(rubberCurrent.current.x, rubberCurrent.current.y)
    })
  }

  function stopAutoScroll(): void {
    autoScrollSpeed.current = 0
    if (autoScrollFrame.current !== null) {
      window.cancelAnimationFrame(autoScrollFrame.current)
      autoScrollFrame.current = null
    }
  }

  function tickAutoScroll(): void {
    if (!rubberAnchor.current || autoScrollSpeed.current === 0) {
      autoScrollFrame.current = null
      return
    }
    const scroller = latestLayoutRef.current.scrollRef.current
    if (scroller) {
      const before = scroller.scrollTop
      scroller.scrollTop += autoScrollSpeed.current
      if (scroller.scrollTop !== before) {
        updateRubberHit(rubberCurrent.current.x, rubberCurrent.current.y)
      }
    }
    autoScrollFrame.current = window.requestAnimationFrame(tickAutoScroll)
  }

  function updateAutoScroll(clientY: number): void {
    const scroller = latestLayoutRef.current.scrollRef.current
    if (!scroller) { stopAutoScroll(); return }
    const rect = scroller.getBoundingClientRect()
    let speed = 0
    if (clientY < rect.top + AUTO_SCROLL_EDGE) {
      const ratio = Math.min(1, Math.max(0, (rect.top + AUTO_SCROLL_EDGE - clientY) / AUTO_SCROLL_EDGE))
      speed = -Math.max(2, Math.round(ratio * AUTO_SCROLL_MAX_SPEED))
    } else if (clientY > rect.bottom - AUTO_SCROLL_EDGE) {
      const ratio = Math.min(1, Math.max(0, (clientY - (rect.bottom - AUTO_SCROLL_EDGE)) / AUTO_SCROLL_EDGE))
      speed = Math.max(2, Math.round(ratio * AUTO_SCROLL_MAX_SPEED))
    }
    autoScrollSpeed.current = speed
    if (speed !== 0 && autoScrollFrame.current === null) {
      autoScrollFrame.current = window.requestAnimationFrame(tickAutoScroll)
    } else if (speed === 0 && autoScrollFrame.current !== null) {
      stopAutoScroll()
    }
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const { viewerIdx, images } = latestRef.current
      const tag = (e.target as HTMLElement).tagName
      const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable
      if (viewerIdx !== null) {
        if (!isEditing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          const next = viewerIdx + (e.key === 'ArrowRight' ? 1 : -1)
          if (next >= 0 && next < images.length) setViewerId(images[next].id)
          return
        }
        if (!isEditing && e.key === 'Delete') {
          const img = images[viewerIdx]
          if (img) deleteViewerImage(img.id, viewerIdx)
          return
        }
        // ビューア表示中でも Undo/Redo（削除の取り消し含む）だけは共通ハンドラへ通す。
        // それ以外（Ctrl+A・Esc・Enter・グリッドナビゲーション等）は従来どおり無効。
        const isUndoRedoKey = !isEditing && (e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')
        if (!isUndoRedoKey) return
      }
      if (!isEditing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (!e.shiftKey && undoPendingDelete()) return
        if (e.shiftKey) redoSelection(); else undoSelection()
        return
      }
      if (!isEditing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redoSelection()
        return
      }
      if (!isEditing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        const loaded = latestRef.current.images
        if (loaded.length === 0) return
        anchorIdx.current = 0
        setFocusIdx(loaded.length - 1)
        // グリッドはカーソルページングで一部しか読み込まれていないため、`images`（表示済み分だけ）
        // ではなく現在のフィルタに一致する全件を取り直して選択する（タイムラインは既に全件読み込み
        // 済みだが、query は同一なので同じ経路で問題ない）。
        // 発行時点のフィルタを覚えておき、resolve 時に変わっていたら結果を捨てる（B-3）。
        // 取得を待つ間にフィルタを変更すると、フィルタ変更による選択クリア（上の filterQueryKey
        // effect）の後にこの then/catch が古いフィルタの ID 集合で setSelectedIds を上書きし、
        // 新しいフィルタ表示の上に旧フィルタの選択が復活してしまう。
        const issuedQueryKey = selectQueryKey(useFilterStore.getState())
        const isStale = (): boolean => selectQueryKey(useFilterStore.getState()) !== issuedQueryKey
        const selectAllQuery = buildImageQuery(getCommitted(useFilterStore.getState()))
        Promise.all([window.api.listAllImages(selectAllQuery), window.api.countImages(selectAllQuery)])
          .then(([rows, count]) => {
            if (isStale()) return
            setSelectedIds(new Set(rows.map((r) => r.id)))
            // B10: listAllImages は上限（5000件）でキャップされるため、実件数がそれを
            // 超えている場合は「全選択のつもりが一部しか選ばれていない」ことを明示する。
            if (count > rows.length) {
              showToast(t('toast.selectAllTruncated', { shown: rows.length.toLocaleString(currentLocale()), total: count.toLocaleString(currentLocale()) }), 'warning')
            }
          })
          .catch((err) => {
            console.error('[selection] selectAll failed', err)
            if (isStale()) return
            setSelectedIds(new Set(loaded.map((i) => i.id)))
          })
        return
      }
      if (e.key === 'Escape' && !isEditing) { clearSelection(); return }
      // Enter と Space はどちらも「フォーカス中/選択中の画像を開く」（Space は Quick Look 的な
      // クイックプレビュー慣習に合わせた追加口。ビューア内では Space はビューアを閉じる方に使うため、
      // ここ（viewerIdx === null のときだけ到達）でのみ「開く」に割り当てて競合を避ける）。
      if ((e.key === 'Enter' || e.code === 'Space') && !isEditing && !e.isComposing) {
        const { images, selectedIds } = latestRef.current
        if (images.length === 0) return
        const focused = focusIdx.current
        const selectedIdx = selectedIds.size > 0 ? images.findIndex((img) => selectedIds.has(img.id)) : -1
        const openIdx = focused !== null && focused >= 0 && focused < images.length ? focused : selectedIdx
        if (openIdx < 0) return
        e.preventDefault()
        setViewerId(images[openIdx].id)
        return
      }
      if ((GRID_NAV_KEYS as readonly string[]).includes(e.key)) {
        if (isEditing) return
        e.preventDefault()
        const { images } = latestRef.current
        if (images.length === 0) return
        const columns = Math.max(1, navigationColumnsRef.current)
        const cur = focusIdx.current ?? anchorIdx.current ?? -1
        const pageRows = Math.max(1, Math.floor((latestLayoutRef.current.scrollRef.current?.clientHeight ?? latestLayoutRef.current.rowHeight) / latestLayoutRef.current.rowHeight))
        const pageStep = Math.max(columns, pageRows * columns)
        let next = cur < 0 ? 0 : cur
        if (e.key === 'Home') next = 0
        else if (e.key === 'End') next = images.length - 1
        else if (e.key === 'PageUp') next = Math.max(0, next - pageStep)
        else if (e.key === 'PageDown') next = Math.min(images.length - 1, next + pageStep)
        else {
          const step = (e.key === 'ArrowLeft' || e.key === 'ArrowRight') ? 1 : columns
          next = (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
            ? Math.max(0, cur < 0 ? 0 : cur - step)
            : Math.min(images.length - 1, cur < 0 ? 0 : cur + step)
        }
        setFocusIdx(next)
        // Ctrl+Shift+矢印（選択に範囲を追加）は廃止した。修飾キーの組み合わせは
        // 下の shift 節に吸われるので、押しても Shift+矢印 と同じ「範囲を選び直す」になる。
        if (e.shiftKey) {
          const anchor = anchorIdx.current ?? next
          const from = Math.min(anchor, next); const to = Math.max(anchor, next)
          setSelectedIds(new Set(images.slice(from, to + 1).map((img) => img.id)))
        } else if (e.ctrlKey) {
          // フォーカスのみ移動・選択変更なし
        } else {
          setSelectedIds(new Set([images[next].id]))
          anchorIdx.current = next
        }
        scrollToIndexRef.current(next)
        return
      }
      if (isEditing || e.key !== 'Delete') return
      const { selectedIds } = latestRef.current
      if (selectedIds.size === 0) return
      const ids = new Set(selectedIds)
      queueDelete(ids)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // サムネを掴んで動かしたときに、選択中の画像を他アプリへドラッグ&ドロップで渡す。
  // main 側が OS のドラッグを開始した時点でマウスは OS のドラッグループに奪われ、以降
  // renderer には mousemove/mouseup が届かない。矩形選択の途中状態をここで畳んでおかないと
  // 選択枠が出しっぱなしのまま固まる。
  function startFileDrag(): void {
    const { selectedIds } = latestRef.current
    const originId = dragThumbId.current
    const ids = originId !== null && !selectedIds.has(originId) ? [originId] : [...selectedIds]

    rubberAnchor.current = null
    rubberStartedFromThumb.current = false
    dragThumbId.current = null
    selfDragRef.current = true
    // 掴んで動かした = 選択を畳む意思はない。保留を破棄して複数選択のまま渡す。
    collapseOnMouseUp.current = null
    cancelScheduledRubberHit()
    stopAutoScroll()
    setPendingIds(new Set())
    setSelBox(null)

    if (ids.length > 0) window.api.startImageDrag(ids)
  }

  useEffect(() => {
    function onMouseMove(e: MouseEvent): void {
      // OS のドラッグ中は renderer に mousemove が届かない。ボタンを離した状態で再び
      // 届いた = ドラッグが終わった、なのでここで下ろす。下ろし忘れると、この後に
      // エクスプローラから本物のファイルをドラッグしてきてもドロップ枠が出なくなる。
      if (selfDragRef.current && e.buttons === 0) selfDragRef.current = false
      if (!rubberAnchor.current) return
      rubberCurrent.current = { x: e.clientX, y: e.clientY }
      // サムネ上で押して動かした = 画像そのものを掴んだ、と解釈して他アプリへのドラッグに入る
      // （エクスプローラ等と同じ挙動）。矩形選択は何もない場所からの開始に限る。
      if (rubberStartedFromThumb.current && Math.abs(e.clientX - rubberAnchor.current.clientX) + Math.abs(e.clientY - rubberAnchor.current.clientY) > 4) {
        startFileDrag()
        return
      }
      scheduleRubberHit()
      updateAutoScroll(e.clientY)
    }
    function onMouseUp(): void {
      selfDragRef.current = false
      // ドラッグせずに離した = ただのクリック。ここで初めて選択をその1枚に畳む。
      if (collapseOnMouseUp.current !== null) {
        selectIndex(collapseOnMouseUp.current)
        collapseOnMouseUp.current = null
      }
      cancelScheduledRubberHit()
      if (rubberAnchor.current) {
        const { x: cx, y: cy } = rubberCurrent.current
        const current = clientToSelectionLocal(cx, cy)
        if (current && (Math.abs(cx - rubberAnchor.current.clientX) > 4 || Math.abs(cy - rubberAnchor.current.clientY) > 4)) {
          const result = hitTestSelectionBox(rubberAnchor.current.localX, rubberAnchor.current.localY, current.x, current.y)
          if (rubberCtrl.current) {
            setSelectedIds((prev) => { const next = new Set(prev); result.forEach((id) => next.add(id)); return next })
          } else {
            setSelectedIds(result)
            if (result.size === 0) {
              anchorIdx.current = null
              setFocusIdx(null)
            }
          }
        }
        rubberAnchor.current = null
      }
      rubberStartedFromThumb.current = false
      stopAutoScroll()
      setPendingIds(new Set())
      setSelBox(null)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      stopAutoScroll()
      cancelScheduledRubberHit()
    }
  }, [])

  function handleGridMouseDown(e: React.MouseEvent<HTMLDivElement>): void {
    if (e.button !== 0) return
    if (!isInSelectionArea(e.clientX, e.clientY, e.target)) return
    const thumbEl = (e.target as HTMLElement).closest('[data-img-id]') as HTMLElement | null
    const local = clientToSelectionLocal(e.clientX, e.clientY)
    if (!local) return
    rubberAnchor.current = { clientX: e.clientX, clientY: e.clientY, localX: local.x, localY: local.y }
    rubberCurrent.current = { x: e.clientX, y: e.clientY }
    rubberCtrl.current = e.ctrlKey || e.metaKey
    if (!thumbEl) {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA') return
      e.preventDefault()
      if (!rubberCtrl.current) clearSelection()
      rubberStartedFromThumb.current = false
      dragThumbId.current = null
      return
    }
    e.preventDefault()
    const id = Number(thumbEl.dataset.imgId)
    const idx = latestRef.current.images.findIndex((img) => img.id === id)

    // 修飾キーなしで「既に選択済みの1枚」を押した場合だけ、選択の畳み込みを mouseup へ回す。
    // そのまま動かせば複数選択のドラッグ、動かさず離せばその1枚を選び直したことになる。
    const plainClick = !e.shiftKey && !e.ctrlKey && !e.metaKey
    const { selectedIds } = latestRef.current
    if (plainClick && selectedIds.size > 1 && selectedIds.has(id)) {
      collapseOnMouseUp.current = idx
    } else {
      collapseOnMouseUp.current = null
      selectIndex(idx, { shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey })
    }
    rubberStartedFromThumb.current = true
    dragThumbId.current = Number.isFinite(id) ? id : null
  }

  async function deleteSelected(): Promise<void> {
    const ids = new Set(selectedIds)
    queueDelete(ids)
  }

  // ids を明示すれば selectedIds を無視してその画像だけ書き出す。ビューア表示中に
  // DetailPanel の「エクスポート」を押した場合は、グリッド選択ではなくビューアの
  // 現在画像を対象にするため呼び出し元（App.tsx）から渡す（P1）。
  async function exportSelected(ids: number[] = [...selectedIds]): Promise<void> {
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
        showToast(tp('toast.exported', result.count) + truncatedMsg, result.truncated ? 'warning' : 'success')
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

  useEffect(() => {
    const flushPendingDelete = (): void => {
      const pending = pendingDeleteRef.current
      if (!pending) return
      pendingDeleteRef.current = null
      commitPendingDelete(pending, false)
    }
    // トレイの「終了」等でウィンドウごと畳まれる場合、この effect のクリーンアップは
    // JS コンテキストごと破棄されるため走らない。pagehide はウィンドウが閉じる過程で
    // React のアンマウントより前に確実に発火するので、Undo 猶予（4秒）の途中で
    // 終了しても「削除しました」の内容どおり削除が実行されるようにする
    // （main 側の IPC ハンドラは応答を待たれなくても独立して完走する）。
    window.addEventListener('pagehide', flushPendingDelete)
    return () => {
      window.removeEventListener('pagehide', flushPendingDelete)
      flushPendingDelete()
    }
  }, [])

  return { selectedIds, setSelectedIds, pendingIds, selBox, focusedIndex, handleGridMouseDown, selectIndex, openIndex, clearSelection, deleteSelected, deleteViewerImage, exportSelected, preserveSelectionOnce, selfDragRef }
}
