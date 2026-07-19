import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { buildTimeline, cleanTitle, computeGridLayout } from './utils'
import { s } from './styles'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import WhatsNewModal from './components/WhatsNewModal'
import DetailPanel from './components/DetailPanel'
import Viewer from './components/Viewer'
import QuickTagInput from './components/QuickTagInput'
import Sidebar from './components/Sidebar'
import Toolbar, { type ViewMode } from './components/Toolbar'
import ThumbCell from './components/ThumbCell'
import TimelineView, { CELL_GAP as TIMELINE_CELL_GAP, type TimelineViewHandle } from './components/TimelineView'
import ContextMenu, { type MenuItem } from './components/ContextMenu'
import { XIcon } from './components/Icon'
import { useToast } from './hooks/useToast'
import { useSettings } from './hooks/useSettings'
import { useFilters } from './hooks/useFilters'
import { useImageList } from './hooks/useImageList'
import { parseSearchQuery, moveFreeTextToEnd } from './stores/imageQuery'
import { useImageStore } from './stores/imageStore'
import { useExportStore } from './stores/exportStore'
import { useTimeline } from './hooks/useTimeline'
import { useSelection } from './hooks/useSelection'
import { useTagger } from './hooks/useTagger'
import { useLatestRef } from './hooks/useLatestRef'
import { useCaptureSync } from './hooks/useCaptureSync'
import { useGlobalKeys } from './hooks/useGlobalKeys'
import { useConfirmActions, type ConfirmDialogState } from './hooks/useConfirmActions'
import { getExtraContextMenuItems, getModals } from './features/registry'

// サムネイル同士の余白。縦（行間）は広め・横（列間）は狭めにする。
const COL_GAP = 6
const ROW_GAP = 10
const LABEL_HEIGHT = 20

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export default function App() {
  const toast = useToast()
  const settings = useSettings(toast.showToast)
  const filters = useFilters(settings.settings, settings.setSettings, toast.showToast)

  const [viewerIdx, setViewerIdx] = useState<number | null>(null)
  // ビューア内 Tab で DetailPanel を隠す（デフォルトは表示）。ビューアを開き直すたびに表示へ戻す。
  const [detailPanelHiddenInViewer, setDetailPanelHiddenInViewer] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    localStorage.getItem('shiori-view-mode') === 'timeline' ? 'timeline' : 'grid')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [quickTagTargetIds, setQuickTagTargetIds] = useState<number[] | null>(null)
  const [manualTagVersion, setManualTagVersion] = useState(0)
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false)
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null)
  const [whatsNew, setWhatsNew] = useState<{ version: string; notes: string[] } | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const mainRef = useRef<HTMLDivElement>(null)
  const toolbarWrapRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const timelineViewRef = useRef<TimelineViewHandle>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [gridOffsetTop, setGridOffsetTop] = useState(0)

  // フィルタ変更時の選択クリアは useSelection が filterStore を購読して自前で行う。
  const imageList = useImageList(toast.showToast)
  const timeline = useTimeline(viewMode === 'timeline', toast.showToast)

  // タイムライン表示中はグリッドの代わりに、作品別グルーピングした並びを「アクティブな一覧」として扱う。
  // ordered（フラット化した並び）が選択・ビューア移動のインデックス基準になる。
  const timelineBuilt = useMemo(
    () => buildTimeline(timeline.images, settings.settings.titleStrip, filters.sortOrder, filters.shuffleSeed),
    [timeline.images, settings.settings.titleStrip, filters.sortOrder, filters.shuffleSeed],
  )
  const activeImages = viewMode === 'timeline' ? timelineBuilt.ordered : imageList.images
  const timelineOrderedRef = useLatestRef(timelineBuilt.ordered)

  // activeImages の配列差し替え（grid⇔timeline切替・フィルタ中キャプチャの再取得・prepend等）が
  // 起きるたびに、ビューアが開いていれば「同じ画像を指し続ける」よう id で位置を引き直す。
  // 見つからなければ（フィルタ対象外になった等）ビューアを閉じる。
  // これにより grid/timeline で座標系（index vs flatIndex）が違うことや、reloadGrid/reloadTimeline
  // が配列を丸ごと差し替えることに起因する「ビューアが別の画像を指す」バグを構造的に防ぐ。
  const prevActiveImagesRef = useRef(activeImages)
  // ビューア内 Delete（useSelection.deleteViewerImage）で viewerIdx を自前で「次の画像」へ
  // 更新した直後は、このあとの effect が「配列から消えた＝閉じる」と誤認しないよう1回だけスキップする。
  const skipViewerAutoTrackRef = useRef(false)
  // ビューア内削除を Undo したとき「復元されたこの id の画像へ戻ってほしい」という指示。
  // 立っていれば、通常の「表示中画像を id で追う」ロジックの代わりにこの id を探して viewerIdx を合わせる。
  const viewerRestoreFollowIdRef = useRef<number | null>(null)
  useEffect(() => {
    const prevImages = prevActiveImagesRef.current
    prevActiveImagesRef.current = activeImages
    if (skipViewerAutoTrackRef.current) { skipViewerAutoTrackRef.current = false; return }
    const followId = viewerRestoreFollowIdRef.current
    if (followId !== null) {
      viewerRestoreFollowIdRef.current = null
      if (viewerIdx === null) return
      const idx = activeImages.findIndex((img) => img.id === followId)
      if (idx >= 0 && idx !== viewerIdx) setViewerIdx(idx)
      return
    }
    if (prevImages === activeImages || viewerIdx === null) return
    const prevImg = prevImages[viewerIdx]
    if (!prevImg) return
    const nextIdx = activeImages.findIndex((img) => img.id === prevImg.id)
    if (nextIdx !== viewerIdx) setViewerIdx(nextIdx >= 0 ? nextIdx : null)
  })

  // ビューアを開くたびに DetailPanel の表示状態をデフォルト（表示）へ戻す。
  // 画像間の移動（viewerIdx が非nullのまま変わる）では再実行しない。
  useEffect(() => {
    if (viewerIdx !== null) setDetailPanelHiddenInViewer(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerIdx !== null])

  // useSelection はグリッド/タイムラインで矩形選択の当たり判定を切り替えるため最新の viewMode を ref で参照する。
  const gridActiveRef = useLatestRef(viewMode === 'grid')

  // キャプチャ/クリップボード取り込みでライブラリが変わったときのサイドバー再取得。
  const onLibraryChanged = (): void => { filters.refreshSites() }

  useEffect(() => { localStorage.setItem('shiori-view-mode', viewMode) }, [viewMode])

  // タイトル/メモ編集の反映はストアに一元化（grid/timeline 両リストへ同時反映。
  // タイムラインはタイトル変更で再グルーピングされる）。
  const patchImage = useImageStore((s) => s.patchImage)

  const handleFileDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    dragCounterRef.current = 0
    setFileDragging(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.api.getPathForFile(f))
      .filter(Boolean)
    if (paths.length === 0) return
    const result = await window.api.importFiles(paths)
    if (result.count > 0) {
      filters.refreshSites()
      // B11/U-2: 200件上限で打ち切られた場合、超過分が黙って捨てられたことを明示する
      // CODE-REVIEW-v1.0.4 B-1: 一部失敗があった場合も成功一色にせず件数を明示する
      const truncatedMsg = result.truncated ? '（200件の上限を超えたため一部は取り込まれていません）' : ''
      const failedMsg = result.errors.length > 0 ? `（${result.errors.length}件は取り込めませんでした）` : ''
      const isPartial = result.truncated || result.errors.length > 0
      toast.showToast(`${result.count}枚を取り込みました${truncatedMsg}${failedMsg}`, isPartial ? 'warning' : 'success')
    } else if (result.errors.length > 0) {
      toast.showToast(`取り込めませんでした（${result.errors.length}件）`, 'warning')
    }
  }

  // ドロップ可能領域の視覚フィードバック（S7-15）。dragenter/leave はネストで多発するため
  // カウンタ方式で管理し、アプリ内 D&D（将来追加時）に誤反応しないよう Files 型のみ見る。
  const [fileDragging, setFileDragging] = useState(false)
  const dragCounterRef = useRef(0)

  function handleDragEnter(e: React.DragEvent): void {
    if (!e.dataTransfer.types.includes('Files')) return
    // 自分が始めた画像ドラッグが戻ってきただけ。取り込みは main 側で弾かれる（何も起きない）ので、
    // 「ドロップで取り込む」枠を出すと嘘になる。
    if (selection.selfDragRef.current) return
    dragCounterRef.current += 1
    setFileDragging(true)
  }

  function handleDragLeave(e: React.DragEvent): void {
    if (!e.dataTransfer.types.includes('Files')) return
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
    if (dragCounterRef.current === 0) setFileDragging(false)
  }

  const { columns, cellWidth, cellHeight } = computeGridLayout(containerWidth, settings.settings.thumbnailSize, COL_GAP)
  const rowHeight = cellHeight + LABEL_HEIGHT + ROW_GAP
  const rowCount = Math.ceil(imageList.images.length / columns)
  // タイムラインのキーボードナビゲーション用の列数は、TimelineView の実描画と同じ
  // gap(CELL_GAP)を使わないと、見た目の列数とナビゲーションの列数が静かにズレるため、
  // TimelineView からエクスポートされた定数をそのまま使う。
  const { columns: timelineColumns } = computeGridLayout(containerWidth, settings.settings.thumbnailSize, TIMELINE_CELL_GAP)
  const navigationColumnsRef = useLatestRef(viewMode === 'timeline' ? timelineColumns : columns)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => mainRef.current,
    estimateSize: () => rowHeight,
    overscan: Math.min(4, Math.max(1, Math.round(12 / columns))),
    scrollMargin: gridOffsetTop,
  })
  const virtualItems = virtualizer.getVirtualItems()

  const removeImages = useImageStore((s) => s.removeImages)
  const restoreImages = useImageStore((s) => s.restoreImages)
  const newIds = useImageStore((s) => s.newIds)
  const scrollToActiveIndex = useCallback((idx: number): void => {
    if (viewMode === 'timeline') {
      timelineViewRef.current?.scrollToFlatIndex(idx)
      return
    }
    virtualizer.scrollToIndex(Math.floor(idx / Math.max(1, columns)), { align: 'auto' })
  }, [columns, viewMode, virtualizer])

  const selection = useSelection({
    images: activeImages,
    viewerIdx,
    setViewerIdx,
    showToast: toast.showToast,
    updateToast: toast.updateToast,
    dismissToast: toast.dismissToast,
    gridLayout: { gridRef, timelineRef, scrollRef: mainRef, columns, cellWidth, cellHeight, rowHeight, colGap: COL_GAP, rowGap: ROW_GAP },
    navigationColumnsRef,
    scrollToIndex: scrollToActiveIndex,
    removeImages,
    restoreImages,
    gridActiveRef,
    skipViewerAutoTrackRef,
    viewerRestoreFollowIdRef,
  })

  useEffect(() => {
    if (selection.selectedIds.size === 0) return
    const handler = (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement | null
      if (!target) return
      if (target.closest('[data-img-id], [data-keep-selection]')) return
      selection.clearSelection()
    }
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [selection.selectedIds])

  const tagger = useTagger(toast.showToast, filters.refreshTags)
  const searchQuery = useMemo(() => parseSearchQuery(filters.search), [filters.search])
  // ハイライト表示は今の一覧結果（＝確定済みクエリ）に対して行うため、入力中の値ではなく
  // committedSearch から演算子構文を除いたキーワード部分だけを使う。
  const highlightQuery = useMemo(() => parseSearchQuery(filters.committedSearch).q ?? '', [filters.committedSearch])

  // images:export / share:export は export:progress チャンネルを共用（呼び出し元がどちらでも
  // 同じ帯に載る）。購読はここ1箇所だけ、書き込み先の exportStore は呼び出し側と共有する。
  // current>=total（最後の進捗）でここ自身がクリアする。呼び出し元の invoke() 解決を待って
  // クリアすると、sendToRenderer の逐次送信と invoke の返信は別経路で配信されるため、
  // 進捗イベントが invoke の解決より後に届いて表示が最後の値のまま残ることがある
  // （実機ログで確認済み）。呼び出し元の finally でのクリアは保険として残す。
  const exportProgress = useExportStore((st) => st.exportProgress)
  const exportKind = useExportStore((st) => st.exportKind)
  useEffect(() => window.api.onExportProgress((p) =>
    useExportStore.getState().setExportProgress(p.current >= p.total ? null : p)
  ), [])

  // 共有インポートの進捗も他の進捗（モデルDL・retag・export）と同じ下部の帯に出す（UX-3）。
  // ここで購読しておくことで、設定モーダルを閉じても進捗・中止ボタンが見える状態を保つ。
  const shareImportProgress = useExportStore((st) => st.shareImportProgress)
  useEffect(() => window.api.onShareImportProgress((p) =>
    useExportStore.getState().setShareImportProgress(p.current >= p.total ? null : p)
  ), [])

  function removeSearchTag(tag: string): void {
    const stripped = filters.search
        .replace(/(^|\s)tag:(\S+)/gi, (match, prefix: string, value: string) =>
          value.toLowerCase() === tag.toLowerCase() ? prefix : match)
        .replace(/\s+/g, ' ')
        .trim()
    const next = moveFreeTextToEnd(stripped)
    filters.setSearch(next)
    filters.commitSearch(next)
  }

  // Sidebar のタグクリックで絞り込むときも、検索欄のテキストに tag:xxx として残す。
  // 別の状態(tagFilters)に隠れて検索欄には何も見えない、という散逸を避けるため。
  // フィルタ(tag:/site:等)をまとめて前・フリーワードを末尾に揃えるのはプログラムによる
  // 追加/削除の直後だけ（手入力中のテキストは動かさない）。
  function addSearchTag(tag: string): void {
    const next = moveFreeTextToEnd(`${filters.search} tag:${tag}`)
    filters.setSearch(next)
    filters.commitSearch(next)
  }

  const openQuickTag = useCallback((): boolean => {
    if (viewerIdx !== null) {
      const img = activeImages[viewerIdx]
      if (!img) return false
      setQuickTagTargetIds([img.id])
      return true
    }
    if (selection.selectedIds.size === 0) return false
    setQuickTagTargetIds([...selection.selectedIds].sort((a, b) => a - b))
    return true
  }, [activeImages, selection.selectedIds, viewerIdx])

  // 新規キャプチャ通知 → 画像ストア・サイドバー・選択の同期（購読は専用フックに内包）。
  // ビューア表示中に同じ画像を指し続ける処理は activeImages の id 追従ロジックに任せる。
  useCaptureSync({
    onLibraryChanged,
    showToast: toast.showToast,
    timelineActive: viewMode === 'timeline',
  })

  // グローバルキー（/・Ctrl+C コピー・Ctrl+V 取り込み）も専用フックに内包
  useGlobalKeys({
    searchInputRef,
    setShowSettings: settings.setShowSettings,
    viewerIdx,
    activeImages,
    selectedIds: selection.selectedIds,
    onQuickTag: openQuickTag,
    onLibraryChanged,
    showToast: toast.showToast,
  })

  // メインプロセスからの通知 → トースト
  useEffect(() => {
    return window.api.onAppNotice(({ level, message }) => toast.showToast(message, level))
  }, [])

  // 更新後の初回起動時、RELEASE_NOTES にそのバージョンの文面があれば「変更点」モーダルを出す
  // （文面が無いバージョンでは main 側が上の app:notice トーストにフォールバックする）。
  useEffect(() => window.api.onWhatsNew(setWhatsNew), [])

  // 外部アプリへのドラッグ&ドロップが上限（枚数・累積バイト・個別コピー失敗）で
  // 一部しか渡らなかったとき通知する（UX-6）。OSドラッグ中は表示できないため、
  // ドロップ完了後にまとめて届く。
  useEffect(() => window.api.onImagesDragTruncated(({ requested, copied }) =>
    toast.showToast(`${requested}枚中${copied}枚のみドラッグしました（上限のため一部は対象外です）`, 'warning')
  ), [])

  // ResizeObserver: measure grid wrapper width + offsetTop for virtualizer
  // useLayoutEffect + 初回同期測定で、起動直後に ResizeObserver の初回発火を
  // 取りこぼして containerWidth が 0 のまま（＝グリッドが描画されない）になるのを防ぐ。
  // offsetTop は Toolbar の高さ（フィルタチップの折り返し等）
  // にも依存するため、grid/timeline 側の要素だけでなく Toolbar 側のサイズ変化でも再計測する
  // （Toolbar 自身の clientWidth/Height は変わっても gridRef/mainRef のサイズは変わらないため、
  // gridRef/mainRef だけを observe していると ResizeObserver が発火せず offsetTop がズレたままになる）。
  useLayoutEffect(() => {
    const el = viewMode === 'grid' ? gridRef.current : mainRef.current
    const toolbarEl = toolbarWrapRef.current
    if (!el) return
    const measure = (): void => {
      if (viewMode === 'grid') {
        setContainerWidth((prev) => prev === el.clientWidth ? prev : el.clientWidth)
        setGridOffsetTop((prev) => prev === el.offsetTop ? prev : el.offsetTop)
        return
      }
      const style = window.getComputedStyle(el)
      const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      const contentWidth = Math.max(0, el.clientWidth - horizontalPadding)
      setContainerWidth((prev) => prev === contentWidth ? prev : contentWidth)
      const nextOffsetTop = timelineRef.current?.offsetTop ?? 0
      setGridOffsetTop((prev) => prev === nextOffsetTop ? prev : nextOffsetTop)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (toolbarEl) ro.observe(toolbarEl)
    return () => ro.disconnect()
  }, [viewMode])

  // force virtualizer to re-measure when row height or column count changes
  useEffect(() => { virtualizer.measure() }, [rowHeight, columns])

  // infinite scroll: trigger requestMore when last visible row is near end
  useEffect(() => {
    if (viewMode !== 'grid' || !imageList.hasMore || imageList.loading) return
    const last = virtualItems[virtualItems.length - 1]
    if (last !== undefined && last.index >= rowCount - 2) imageList.requestMore()
  }, [virtualItems, rowCount, imageList.hasMore, imageList.loading, viewMode])

  // ビューア表示中も末尾付近に近づいたら追加読み込みする（スクロール起点の無限スクロールは
  // ビューアを開いている間は発火しないため）。これで未読み込みの画像へもそのまま移動でき、
  // 件数表示が読み込み済み数で頭打ちにならない。
  useEffect(() => {
    if (viewMode !== 'grid' || viewerIdx === null) return
    if (!imageList.hasMore || imageList.loading) return
    if (viewerIdx >= imageList.images.length - 10) imageList.requestMore()
  }, [viewerIdx, imageList.images.length, imageList.hasMore, imageList.loading, viewMode])

  // ビューア表示中は DetailPanel もビューアの現在画像に追従する（グリッド選択とは独立、P1）。
  const single = useMemo(() => {
    if (viewerIdx !== null) return activeImages[viewerIdx] ?? null
    if (selection.selectedIds.size !== 1) return null
    const [selectedId] = selection.selectedIds
    return activeImages.find((i) => i.id === selectedId) ?? null
  }, [activeImages, selection.selectedIds, viewerIdx])

  const tagRefreshKey = tagger.taggerDoneKey + manualTagVersion
  const handleTagsChanged = useCallback((): void => {
    filters.refreshTags()
    setManualTagVersion((v) => v + 1)
  }, [filters])

  const quickTagTargetLabel = useMemo(() => {
    if (!quickTagTargetIds || quickTagTargetIds.length !== 1) return `${quickTagTargetIds?.length ?? 0}枚`
    const img = activeImages.find((x) => x.id === quickTagTargetIds[0])
    return img?.title ? cleanTitle(img.title, settings.settings.titleStrip) : '1枚'
  }, [activeImages, quickTagTargetIds, settings.settings.titleStrip])

  // サムネイル右クリック: 未選択の画像なら単一選択に切り替えてからメニューを開く。
  // 既に選択済みの画像上なら現在の複数選択を維持し、メニューはその選択全体に作用する。
  const selectionRef = useLatestRef(selection)
  const handleThumbContextMenu = useCallback((e: React.MouseEvent, id: number): void => {
    e.preventDefault()
    const { selectedIds, setSelectedIds } = selectionRef.current
    if (!selectedIds.has(id)) setSelectedIds(new Set([id]))
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }, [selectionRef])

  const handleTimelineContextMenu = useCallback((flatIndex: number, e: React.MouseEvent) => {
    const img = timelineOrderedRef.current[flatIndex]
    if (img) handleThumbContextMenu(e, img.id)
  }, [timelineOrderedRef, handleThumbContextMenu])

  // M-3: 確認ダイアログの組み立て（スマートフォルダ削除・タグ全体削除・タガーモデル削除）は
  // 配線ではなくドメインロジックのため useConfirmActions に切り出している。
  const { confirmSmartFolderDelete, confirmDeleteTagGlobally, confirmTaggerDelete } = useConfirmActions({
    setConfirmDialog,
    showToast: toast.showToast,
    deleteSmartFolder: filters.deleteSmartFolder,
    setTagFilters: filters.setTagFilters,
    refreshTags: filters.refreshTags,
    removeSearchTag,
    taggerDelete: tagger.handleTaggerDelete,
  })

  // 選択状態に応じてメニュー項目を組み立てる。単一選択時のみトリミング/Explorer を出す。
  const ctxMenuItems = useMemo<MenuItem[]>(() => {
    if (!ctxMenu) return []
    const items: MenuItem[] = []
    if (single && single.media_type !== 'video') {
      items.push({
        label: 'コピー',
        onClick: () => {
          window.api.clipboardCopyImage(single.id).then(
            (ok) => toast.showToast(ok ? 'クリップボードにコピーしました' : '画像のコピーに失敗しました', ok ? 'success' : 'warning'),
            (err) => { console.error('[copy] clipboard write failed', err); toast.showToast('画像のコピーに失敗しました', 'warning') },
          )
        },
      })
    }
    if (single) {
      items.push({ label: 'Explorerで開く', onClick: () => window.api.showInFolder(single.id) })
    }
    if (single) items.push(...getExtraContextMenuItems(single))
    items.push({ label: 'エクスポート', onClick: () => selection.exportSelected() })
    items.push({ label: 'ゴミ箱へ移動', onClick: () => selection.deleteSelected(), danger: true })
    return items
  }, [ctxMenu, single, activeImages, selection, toast])

  const activeTask = useMemo(() => {
    if (tagger.taggerProgress !== null) {
      return {
        label: 'AIモデルをダウンロード中',
        detail: `${Math.round(tagger.taggerProgress * 100)}%`,
        progress: clamp01(tagger.taggerProgress),
        onCancel: tagger.handleTaggerCancelDownload,
      }
    }
    if (tagger.retagProgress) {
      const { current, total } = tagger.retagProgress
      return {
        label: '既存画像にAIタグ付け中',
        detail: `${current}/${total}`,
        progress: total > 0 ? clamp01(current / total) : 0,
        onCancel: tagger.handleTaggerRetagCancel,
      }
    }
    if (shareImportProgress) {
      const { current, total } = shareImportProgress
      return {
        label: 'ライブラリを読み込み中',
        detail: `${current}/${total}`,
        progress: total > 0 ? clamp01(current / total) : 0,
        onCancel: () => window.api.shareImportCancel(),
      }
    }
    if (!exportProgress) return null

    const { current, total } = exportProgress
    return {
      // W-4: share 起点の進捗は SettingsModal の「エクスポート中...」と表示を揃える
      label: exportKind === 'share' ? 'ライブラリをエクスポート中' : 'エクスポート中',
      detail: `${current}/${total}`,
      progress: total > 0 ? clamp01(current / total) : 0,
      onCancel: exportKind === 'share' ? () => window.api.shareExportCancel() : () => window.api.imagesExportCancel(),
    }
  }, [tagger.handleTaggerCancelDownload, tagger.handleTaggerRetagCancel, tagger.retagProgress, tagger.taggerProgress, shareImportProgress, exportProgress, exportKind])

  return (
    // ファイルのドロップ受け口はウィンドウ全体。サイドバーや詳細パネルの上に落としても
    // 取り込めた方が自然で、狙いを外したときに黙って無視される方が事故に近い。
    // position: relative はドロップ枠（dropOverlay）をこの範囲に収めるため。
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', position: 'relative' }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={(e) => {
        e.preventDefault()
        // 自分から出した画像を自分に戻しても取り込まない。カーソルを 'none' にして
        // 「ここには落とせない」と手に伝える（落としても黙って無視されるだけなので、
        // copy カーソルのままだと取り込まれたと誤解させる）。
        e.dataTransfer.dropEffect = selection.selfDragRef.current ? 'none' : 'copy'
      }}
      onDrop={handleFileDrop}>
      {fileDragging && (
        <div style={s.dropOverlay}>
          <div style={s.dropOverlayText}>ドロップして取り込み</div>
        </div>
      )}

      {settings.updateVersion && !updateBannerDismissed && (
        <div style={s.updateBanner}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span>v{settings.updateVersion} の準備ができました</span>
            <button style={s.updateBtn} onClick={() => settings.quitAndInstallUpdate()}>再起動して更新</button>
          </div>
          <button style={s.sidebarXBtn} onClick={() => setUpdateBannerDismissed(true)} title="今は更新しない"><XIcon size={13} /></button>
        </div>
      )}
      <div style={s.root}>
        {/* Sidebar+main だけを囲むラッパー。ビューアはこの中だけを覆う絶対配置オーバーレイに
            することで、DetailPanel（右）はビューア表示中も隠れず操作できる（P1）。 */}
        <div style={s.viewerHost}>
        <Sidebar
          count={viewMode === 'timeline' ? (timeline.totalCount ?? timeline.images.length) : (imageList.totalCount ?? imageList.images.length)}
          filters={filters}
          smartFolders={settings.settings.smartFolders}
          searchTags={searchQuery.tags}
          onRemoveSearchTag={removeSearchTag}
          onAddSearchTag={addSearchTag}
          settingsActive={settings.showSettings}
          onToggleSettings={() => settings.setShowSettings((v) => !v)}
          thumbnailSize={settings.settings.thumbnailSize}
          onThumbnailSize={settings.updateThumbnailSize}
          viewMode={viewMode}
          onViewMode={setViewMode}
          onDeleteSmartFolder={confirmSmartFolderDelete}
          onReorderSmartFolders={filters.reorderSmartFolders}
          onDeleteTag={confirmDeleteTagGlobally}
        />

        <main ref={mainRef} style={s.main} onMouseDown={selection.handleGridMouseDown}>
          <Toolbar
            ref={toolbarWrapRef}
            filters={filters}
            searchTags={searchQuery.tags}
            onRemoveSearchTag={removeSearchTag}
            searchInputRef={searchInputRef}
            searching={viewMode === 'grid' ? imageList.reloading : timeline.loading}
          />

          {viewMode === 'timeline' ? (
            <div key="timeline" ref={timelineRef} style={{ ...s.grid, animation: 'shioriViewFromRight 0.2s ease-out' }}>
              {selection.selBox && selection.selBox.w + selection.selBox.h > 4 && (
                <div style={{ ...s.selectionBox, left: selection.selBox.x, top: selection.selBox.y, width: selection.selBox.w, height: selection.selBox.h }} />
              )}
              <TimelineView
                ref={timelineViewRef}
                groups={timelineBuilt.groups}
                thumbnailSize={settings.settings.thumbnailSize}
                titleStrip={settings.settings.titleStrip}
                selectedIds={selection.selectedIds}
                pendingIds={selection.pendingIds}
                focusedIndex={selection.focusedIndex}
                loading={timeline.loading}
                hasActiveFilter={filters.hasActiveFilter()}
                onOpen={selection.openIndex}
                onContextMenu={handleTimelineContextMenu}
                containerWidth={containerWidth}
                scrollRef={mainRef}
                offsetTop={gridOffsetTop}
              />
            </div>
          ) : (
          <div key="grid" ref={gridRef} style={{ ...s.grid, animation: 'shioriViewFromLeft 0.2s ease-out' }}>
            {selection.selBox && selection.selBox.w + selection.selBox.h > 4 && (
              <div style={{ ...s.selectionBox, left: selection.selBox.x, top: selection.selBox.y, width: selection.selBox.w, height: selection.selBox.h }} />
            )}
            {imageList.images.length === 0 && !imageList.loading ? (
              <div style={s.empty}>
                {filters.hasActiveFilter() ? (
                  <>
                    <div style={s.emptyTitle}>該当する画像がありません</div>
                  </>
                ) : (
                  <>
                    <div style={s.emptyTitle}>まだ画像がありません</div>
                    <div style={s.emptySteps}>
                      <div>1. 拡張機能フォルダを Chrome に読み込みます</div>
                      <div>2. 対応サイトで動画を開きます</div>
                      <div>3. 取りたい場面で <strong style={{ color: 'var(--accent-text)' }}>{settings.settings.captureHotkey}</strong> を押します</div>
                    </div>
                    <div style={s.emptyActions}>
                      <button style={s.emptyBtn} onClick={() => window.api.showExtensionFolder()}>拡張機能フォルダを開く</button>
                      <button style={{ ...s.emptyBtn, ...s.emptyBtnSub }} onClick={() => settings.setShowSettings(true)}>設定を開く</button>
                    </div>
                    <div style={s.emptyHint}>または、フォルダや画像をここにドロップして取り込めます</div>
                  </>
                )}
              </div>
            ) : containerWidth > 0 ? (
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
                {virtualItems.map((vRow) => {
                  const start = vRow.index * columns
                  const rowImages = imageList.images.slice(start, start + columns)
                  return (
                    <div key={vRow.key}
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%',
                        transform: `translateY(${vRow.start - gridOffsetTop}px)`,
                        display: 'grid', gridTemplateColumns: `repeat(${columns}, ${cellWidth}px)`, columnGap: COL_GAP }}>
                      {rowImages.map((img, localIdx) => (
                        <ThumbCell
                          key={img.id}
                          img={img}
                          cellHeight={cellHeight}
                          selected={selection.selectedIds.has(img.id) || selection.pendingIds.has(img.id)}
                          isNew={newIds.has(img.id)}
                          focused={selection.focusedIndex === start + localIdx}
                          titleStrip={settings.settings.titleStrip}
                          highlight={highlightQuery}
                          onContextMenu={handleThumbContextMenu}
                          onOpen={selection.openIndex}
                          index={start + localIdx}
                        />
                      ))}
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
          )}
          {viewMode === 'grid' && imageList.loading && <div style={s.loadingMore}>読み込み中...</div>}
          {(activeTask || toast.toasts.length > 0) && (
            <div style={s.toastStack}>
              {activeTask && (
                <div style={{ ...s.notificationCard, ...s.taskToast }}>
                  <div style={s.taskHeader}>
                    <span style={{ ...s.toastIndicator, ...s.toastInfoMark }} />
                    <span style={s.taskLabel}>{activeTask.label}</span>
                    <span style={s.taskDetail}>{activeTask.detail}</span>
                    {activeTask.onCancel && <button style={s.taskCancelBtn} onClick={activeTask.onCancel}>中止</button>}
                  </div>
                  <div style={s.taskBarTrack}>
                    <div style={{ ...s.taskFill, width: `${Math.round(activeTask.progress * 100)}%` }} />
                  </div>
                </div>
              )}
              {toast.toasts.map((t) => (
                <div
                  key={t.id}
                  // スクリーンリーダー通知。error は割り込み(assertive)、それ以外は polite。
                  // 拡張のページ内通知（content.js の role="status"）とアプリ側を揃える（U-6）。
                  role={t.tone === 'error' ? 'alert' : 'status'}
                  aria-live={t.tone === 'error' ? 'assertive' : 'polite'}
                  aria-atomic="true"
                  style={{
                    ...s.notificationCard,
                    animation: t.closing ? 'shioriToastOut 0.3s ease-in forwards' : 'shioriToastIn 0.22s ease-out',
                    ...(t.tone === 'error' ? s.toastError : t.tone === 'warning' ? s.toastWarning : t.tone === 'success' ? s.toastSuccess : s.toastInfo),
                  }}
                >
                  <span style={{ ...s.toastIndicator, ...(t.tone === 'error' ? s.toastErrorMark : t.tone === 'warning' ? s.toastWarningMark : t.tone === 'success' ? s.toastSuccessMark : s.toastInfoMark) }} />
                  <div style={s.toastBody}>
                    <span style={s.toastMessage}>{t.message}</span>
                    {t.action && (
                      <button style={s.toastActionBtn} onClick={t.action.onClick}>
                        {t.action.label}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

        </main>

        {viewerIdx !== null && activeImages[viewerIdx] && (
          <Viewer
            images={activeImages}
            index={viewerIdx}
            setIndex={setViewerIdx}
            total={viewMode === 'timeline' ? activeImages.length : (imageList.totalCount ?? activeImages.length)}
            titleStrip={settings.settings.titleStrip}
            onToggleDetailPanel={() => setDetailPanelHiddenInViewer((v) => !v)}
          />
        )}
        </div>

        {settings.showSettings && (
          <SettingsModal
            settings={settings.settings}
            startup={settings.startup}
            taggerReady={tagger.taggerReady}
            taggerProgress={tagger.taggerProgress}
            retagProgress={tagger.retagProgress}
            extensionStatus={settings.extensionStatus}
            onClose={() => settings.setShowSettings(false)}
            onToggleStartup={settings.toggleStartup}
            onUpdateFrameFps={settings.updateFrameFps}
            onUpdateFrameFpsAuto={settings.updateFrameFpsAuto}
            onUpdateCaptureHotkey={settings.updateCaptureHotkey}
            onUpdateCaptureNotify={settings.updateCaptureNotify}
            onUpdateShowAiTags={settings.updateShowAiTags}
            onUpdateTheme={settings.updateTheme}
            onTaggerDownload={tagger.handleTaggerDownload}
            onTaggerCancelDownload={tagger.handleTaggerCancelDownload}
            onTaggerDelete={confirmTaggerDelete}
            onTaggerRetagAll={() => window.api.taggerRetagAll()}

            onShareExport={() => window.api.shareExport()}
            onShareImport={async () => {
              const result = await window.api.shareImport()
              // shareImport は capture:done を送らないため、成功しても取り込み内容が
              // グリッド/タイムライン/サイドバー集計のどれにも反映されない（B3/U-1）。
              // importFiles と同様、完了後にここで明示的に再取得する。
              if (!result.canceled && (result.count ?? 0) > 0) {
                const store = useImageStore.getState()
                store.reloadGrid(toast.showToast)
                store.reloadTimeline(toast.showToast)
                onLibraryChanged()
                filters.refreshTags()
              }
              // スマートフォルダが取り込まれた場合、main 側で settings.json 経由で保存済みなので
              // ここでは最新の設定を取り直して反映するだけでよい（IPC は呼ばない setSettings）。
              if (!result.canceled && (result.importedFolders ?? 0) > 0) {
                window.api.getSettings().then(settings.setSettings).catch((err) => {
                  console.error('[settings] refresh after share import failed', err)
                })
              }
              return result
            }}
          />
        )}

        {(viewerIdx === null || !detailPanelHiddenInViewer) && (
        <DetailPanel
          selectedIds={selection.selectedIds}
          single={single}
          settings={settings.settings}
          taggerDoneKey={tagRefreshKey}
          allTags={filters.allTags}
          viewerOpen={viewerIdx !== null}
          onTagsChanged={handleTagsChanged}
          onTitleChanged={(id, title) => patchImage(id, { title })}
          onMemoChanged={(id, memo) => patchImage(id, { memo })}
          onFilterByTag={(tag) => {
            // Sidebar のタグクリックと同じ方式: 検索欄のテキストに tag:xxx として残し、
            // 別状態(tagFilters)だけに絞り込みが隠れて検索欄に何も見えなくなるのを避ける。
            // フィルタ確定値が変わると選択は自動でクリアされる(useSelection)が、詳細タイルから
            // 絞り込んだ直後に選択が消えると操作対象を見失うため、この1回だけ維持する。
            selection.preserveSelectionOnce()
            const active = filters.tagFilters.includes(tag) || searchQuery.tags.includes(tag)
            if (active) {
              filters.setTagFilters((prev) => prev.filter((t) => t !== tag))
              if (searchQuery.tags.includes(tag)) removeSearchTag(tag)
            } else {
              addSearchTag(tag)
            }
          }}
          // ビューア表示中は single がグリッド選択と無関係にビューアの現在画像を指すため、
          // エクスポート/削除も selectedIds ではなくその画像だけを対象にする（P1）。
          onExport={() => (viewerIdx !== null && single ? selection.exportSelected([single.id]) : selection.exportSelected())}
          onDelete={() => (viewerIdx !== null && single ? selection.deleteViewerImage(single.id, viewerIdx) : selection.deleteSelected())}
          onClearSelection={selection.clearSelection}
        />
        )}
      </div>

      {ctxMenu && ctxMenuItems.length > 0 && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenuItems} onClose={() => setCtxMenu(null)} />
      )}

      {quickTagTargetIds && (
        <QuickTagInput
          imageIds={quickTagTargetIds}
          allTags={filters.allTags}
          targetLabel={quickTagTargetLabel}
          onClose={() => setQuickTagTargetIds(null)}
          onTagged={(tag, count) => {
            handleTagsChanged()
            toast.showToast(count === 1 ? `タグ「${tag}」を追加しました` : `${count}枚にタグ「${tag}」を追加しました`, 'success')
          }}
        />
      )}

      {confirmDialog && (
        <ConfirmDialog
          {...confirmDialog}
          onClose={() => setConfirmDialog(null)}
        />
      )}

      {whatsNew && (
        <WhatsNewModal
          version={whatsNew.version}
          notes={whatsNew.notes}
          onClose={() => setWhatsNew(null)}
        />
      )}

      {getModals().map((Modal, i) => <Modal key={i} />)}
    </div>
  )
}

