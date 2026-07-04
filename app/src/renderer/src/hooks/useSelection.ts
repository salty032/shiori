import { useEffect, useRef, useState } from 'react'
import type { ImageRow, DeleteImageResult } from '../types'
import type { DismissToast, ShowToast, UpdateToast } from './useToast'
import type { RemovedImagesSnapshot } from '../stores/imageStore'
import { selectQueryKey, getCommitted, useFilterStore } from '../stores/filterStore'
import { buildImageQuery } from '../stores/imageQuery'
import { useExportStore } from '../stores/exportStore'

const GAP = 8
const AUTO_SCROLL_EDGE = 72
const AUTO_SCROLL_MAX_SPEED = 18
const SELECTION_HISTORY_LIMIT = 30
const DELETE_UNDO_MS = 4000
// ゴミ箱移動の同時実行数。並列しすぎると Windows のシェル操作が一時的に失敗するため絞る。
const DELETE_CONCURRENCY = 4
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
}

function hitTestBox(
  ax: number, ay: number, cx: number, cy: number,
  images: ImageRow[],
  columns: number, cellWidth: number, cellHeight: number, rowHeight: number,
): Set<number> {
  const box = { left: Math.min(ax, cx), top: Math.min(ay, cy), right: Math.max(ax, cx), bottom: Math.max(ay, cy) }
  const next = new Set<number>()
  if (columns <= 0 || cellWidth <= 0) return next
  images.forEach((img, i) => {
    const row = Math.floor(i / columns)
    const col = i % columns
    const left = col * (cellWidth + GAP)
    const top = row * rowHeight
    const hitHeight = Math.max(cellHeight, rowHeight - GAP)
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
  // ゴミ箱への移動を OS シェルへ一気に並列投入すると、Windows ではまれに一部が一時的に
  // 失敗扱いとなり「◯枚は移動できませんでした」という誤った警告が出る。同時実行数を絞って
  // 干渉を避けつつ、完全な逐次よりは速く処理する。
  // 件数が多いと時間がかかるため、少し待っても終わらない場合だけ「削除中…」を表示する
  // （すぐ終わるなら出さずチラつきを避ける）。完了時は同じトースト（progressToastId）を
  // updateToast で差し替える（トーストがスタック化されて以降、新規 showToast だと
  // 「削除中…」と完了メッセージが両方残ってしまうため）。
  let progressTimer: number | null = null
  let progressToastId: number | null = null
  if (showProgress) {
    progressTimer = window.setTimeout(() => {
      progressTimer = null
      progressToastId = showToast(`${idList.length}枚を削除中…`, 'info', 60000)
    }, 400)
  }

  const results: DeleteImageResult[] = []
  try {
    // 共有カーソルを複数ワーカーで進め、同時に走る削除を DELETE_CONCURRENCY 件までに制限する。
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < idList.length) {
        const id = idList[cursor++]
        results.push(await window.api.deleteImage(id))
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(DELETE_CONCURRENCY, idList.length) }, worker),
    )
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
      ? `${deletedIds.size}枚をゴミ箱へ移動しました。${failedCount}枚は移動できませんでした。`
      : '画像をゴミ箱へ移動できませんでした。ファイルの状態を確認してください。'
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
  setViewerIdx: React.Dispatch<React.SetStateAction<number | null>>
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
  // ビューア内削除で viewerIdx を自前で更新したことを App 側の id 追従 effect に伝える
  // 1 回限りのフラグ。立っていれば effect は「配列から消えた」と誤認せず何もしない。
  skipViewerAutoTrackRef: React.MutableRefObject<boolean>
  // ビューア内削除の Undo で「この id の画像へ戻ってほしい」ことを App 側の id 追従 effect に伝える。
  // 立っていれば effect は通常の（表示中画像を id で追う）ロジックの代わりにこの id を探しに行く。
  viewerRestoreFollowIdRef: React.MutableRefObject<number | null>
}

export function useSelection({
  images,
  viewerIdx,
  setViewerIdx,
  showToast,
  updateToast,
  dismissToast,
  gridLayout,
  navigationColumnsRef,
  scrollToIndex,
  removeImages,
  restoreImages,
  gridActiveRef,
  skipViewerAutoTrackRef,
  viewerRestoreFollowIdRef,
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
  const pendingDeleteRef = useRef<{
    ids: Set<number>
    snapshot: RemovedImagesSnapshot
    selectedBefore: Set<number>
    timer: number
    // ビューア内削除（deleteViewerImage）由来のときだけ、削除した画像の id を持つ。
    // この削除が Undo されたとき、ビューアが開いていればその画像へ戻すために使う。
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
      (failedIds) => restoreImages(pending.snapshot, failedIds),
      showProgress,
    ).catch((err) => {
      console.error('[delete] failed', err)
      restoreImages(pending.snapshot)
      showToast('画像をゴミ箱へ移動できませんでした。ファイルの状態を確認してください。', 'error')
    })
  }

  function undoPendingDelete(): boolean {
    const pending = pendingDeleteRef.current
    if (!pending) return false
    pendingDeleteRef.current = null
    window.clearTimeout(pending.timer)
    if (pending.viewerRestoreId != null) viewerRestoreFollowIdRef.current = pending.viewerRestoreId
    restoreImages(pending.snapshot)
    restoreSelectionAfterUndo(pending.selectedBefore)
    showToast('ゴミ箱への移動を取り消しました', 'info')
    return true
  }

  function queueDelete(ids: Set<number>): void {
    if (ids.size === 0) return
    const previous = pendingDeleteRef.current
    if (previous) {
      pendingDeleteRef.current = null
      commitPendingDelete(previous, false)
    }
    const selectedBefore = new Set(latestRef.current.selectedIds)
    const snapshot = selectAfterDelete(ids)
    const pending = {
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
    showToast(
      ids.size === 1 ? '画像をゴミ箱へ移動しました' : `${ids.size}枚をゴミ箱へ移動しました`,
      'success',
      DELETE_UNDO_MS,
      { label: '元に戻す', onClick: undoPendingDelete },
    )
  }

  // ビューア表示中に Delete された1枚だけを対象にした削除。グリッド選択は
  // queueDelete→selectAfterDelete が既存ロジックのまま「次の画像」を選択状態にするので、
  // ここでは同じ index 計算で viewerIdx を進める（末尾なら1つ前、残り0枚なら閉じる）。
  function deleteViewerImage(id: number, currentViewerIdx: number): void {
    const remaining = latestRef.current.images.filter((img) => img.id !== id)
    const nextViewerIdx = remaining.length > 0 ? Math.min(currentViewerIdx, remaining.length - 1) : null
    skipViewerAutoTrackRef.current = true
    queueDelete(new Set([id]))
    // queueDelete が pendingDeleteRef に積んだ直後なので、この削除だけを Undo したとき
    // ビューアが id で復元画像へ戻れるよう印を付けておく。
    if (pendingDeleteRef.current) pendingDeleteRef.current.viewerRestoreId = id
    setViewerIdx(nextViewerIdx)
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
    const { columns, cellWidth, cellHeight, rowHeight } = latestLayoutRef.current
    return hitTestBox(ax, ay, cx, cy, latestRef.current.images, columns, cellWidth, cellHeight, rowHeight)
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
        if (!isEditing && e.key === 'ArrowLeft') { setViewerIdx((i) => (i !== null && i > 0 ? i - 1 : i)); return }
        if (!isEditing && e.key === 'ArrowRight') { setViewerIdx((i) => (i !== null && i < images.length - 1 ? i + 1 : i)); return }
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
        anchorIdx.current = 0
        setFocusIdx(loaded.length - 1)
        // グリッドはカーソルページングで一部しか読み込まれていないため、`images`（表示済み分だけ）
        // ではなく現在のフィルタに一致する全件を取り直して選択する（タイムラインは既に全件読み込み
        // 済みだが、query は同一なので同じ経路で問題ない）。
        const selectAllQuery = buildImageQuery(getCommitted(useFilterStore.getState()))
        Promise.all([window.api.listAllImages(selectAllQuery), window.api.countImages(selectAllQuery)])
          .then(([rows, count]) => {
            setSelectedIds(new Set(rows.map((r) => r.id)))
            // B10: listAllImages は上限（5000件）でキャップされるため、実件数がそれを
            // 超えている場合は「全選択のつもりが一部しか選ばれていない」ことを明示する。
            if (count > rows.length) {
              showToast(`表示上限のため ${rows.length.toLocaleString()} / ${count.toLocaleString()} 件のみ選択されました`, 'warning')
            }
          })
          .catch((err) => {
            console.error('[selection] selectAll failed', err)
            setSelectedIds(new Set(loaded.map((i) => i.id)))
          })
        return
      }
      if (e.key === 'Escape' && !isEditing) { clearSelection(); return }
      // Enter と Space はどちらも「フォーカス中/選択中の画像を開く」（Space は Quick Look 的な
      // クイックプレビュー慣習に合わせた追加口。ビューア内では Space は動画の再生/停止に使うため、
      // ここ（viewerIdx === null のときだけ到達）でのみ「開く」に割り当てて競合を避ける）。
      if ((e.key === 'Enter' || e.code === 'Space') && !isEditing && !e.isComposing) {
        const { images, selectedIds } = latestRef.current
        if (images.length === 0) return
        const focused = focusIdx.current
        const selectedIdx = selectedIds.size > 0 ? images.findIndex((img) => selectedIds.has(img.id)) : -1
        const openIdx = focused !== null && focused >= 0 && focused < images.length ? focused : selectedIdx
        if (openIdx < 0) return
        e.preventDefault()
        setViewerIdx(openIdx)
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
        if (e.ctrlKey && e.shiftKey) {
          const anchor = anchorIdx.current ?? next
          const from = Math.min(anchor, next); const to = Math.max(anchor, next)
          const range = new Set(images.slice(from, to + 1).map((img) => img.id))
          setSelectedIds((prev) => { const n = new Set(prev); range.forEach((id) => n.add(id)); return n })
        } else if (e.shiftKey) {
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

  useEffect(() => {
    function onMouseMove(e: MouseEvent): void {
      if (!rubberAnchor.current) return
      rubberCurrent.current = { x: e.clientX, y: e.clientY }
      if (rubberStartedFromThumb.current && Math.abs(e.clientX - rubberAnchor.current.clientX) + Math.abs(e.clientY - rubberAnchor.current.clientY) > 4) {
        if (!rubberCtrl.current) clearSelection()
        rubberStartedFromThumb.current = false
      }
      scheduleRubberHit()
      updateAutoScroll(e.clientY)
    }
    function onMouseUp(): void {
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
      return
    }
    e.preventDefault()
    const id = Number(thumbEl.dataset.imgId)
    const idx = latestRef.current.images.findIndex((img) => img.id === id)

    selectIndex(idx, { shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey })
    rubberStartedFromThumb.current = true
  }

  async function deleteSelected(): Promise<void> {
    const ids = new Set(selectedIds)
    queueDelete(ids)
  }

  // ids を明示すれば selectedIds を無視してその画像だけ書き出す。ビューア表示中に
  // DetailPanel の「エクスポート」を押した場合は、グリッド選択ではなくビューアの
  // 現在画像を対象にするため呼び出し元（App.tsx）から渡す（P1）。
  async function exportSelected(ids: number[] = [...selectedIds]): Promise<void> {
    useExportStore.getState().startExport('images')
    try {
      const result = await window.api.exportImages(ids)
      if (result.canceled) {
        // count がある = 中止ボタンでの途中キャンセル。ない = フォルダ選択自体のキャンセル（無言）。
        if (result.count != null) showToast(`${result.count}枚でエクスポートを中止しました`, 'warning')
      } else if (result.count != null) {
        // U-2: エクスポートID上限（MAX_EXPORT_IDS）到達を明示する
        const truncatedMsg = result.truncated ? '（上限のため一部は対象外です）' : ''
        showToast(`${result.count}枚をエクスポートしました${truncatedMsg}`, result.truncated ? 'warning' : 'success')
      }
    } catch (err) {
      console.error('[export] failed', err)
      showToast('エクスポートに失敗しました。保存先やファイルの状態を確認してください。', 'error')
    } finally {
      // 通常は onExportProgress 側（current>=total）でクリアされるが、途中キャンセル・
      // 進捗が1件も届かない失敗ケースの保険としてここでも念のためクリアする。
      useExportStore.getState().clearExport()
    }
  }

  useEffect(() => {
    return () => {
      const pending = pendingDeleteRef.current
      if (!pending) return
      pendingDeleteRef.current = null
      commitPendingDelete(pending, false)
    }
  }, [])

  return { selectedIds, setSelectedIds, pendingIds, selBox, focusedIndex, handleGridMouseDown, selectIndex, clearSelection, deleteSelected, deleteViewerImage, exportSelected, preserveSelectionOnce }
}
