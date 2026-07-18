import { useEffect, useMemo, useRef, useState } from 'react'
import type { SmartFolder } from '../types'
import type { Filters } from '../hooks/useFilters'
import type { ViewMode } from './Toolbar'
import { s, font } from '../styles'
import { FolderIcon, GridIcon, HelpCircleIcon, ListIcon, PlusIcon, SettingsIcon, XIcon } from './Icon'
import ContextMenu from './ContextMenu'
import ShortcutsFlyout from './ShortcutsFlyout'
import { usePanelResize } from '../hooks/usePanelResize'
import appIcon from '../../../../build/icon.ico'

// サイドバーに出すタグの下限枚数。「上位N件」で切ると、AIタグ付けがキャプチャ1枚につき
// 十数個のタグを付けるせいで撮影・削除のたびに各タグの件数が動き、境界のタグが順位を
// 上下して出たり消えたりする（下位ほど同数タグがひしめくため、境界はほぼ常に同数集団の
// 途中を通る）。枚数で切れば、画像を足しても件数は増える一方なので押し出しが起きない。
// 表示から消えるのは「削除で枚数がこの値を割ったとき」だけになる。
const SIDEBAR_TAG_MIN_COUNT = 5
// 枚数がこの値に届くタグがまだ無い（＝ライブラリが小さい）間だけ、上位N件で代替する。
// タグ欄が空のままになるのを防ぐための下駄。
const SIDEBAR_TAG_FALLBACK_LIMIT = 12
const SIDEBAR_MIN_WIDTH = 210
const SIDEBAR_MAX_WIDTH = 340
const SIDEBAR_DEFAULT_WIDTH = 210

type Props = {
  count: number
  filters: Filters
  smartFolders: SmartFolder[]
  searchTags: string[]
  onRemoveSearchTag: (tag: string) => void
  onAddSearchTag: (tag: string) => void
  settingsActive: boolean
  onToggleSettings: () => void
  thumbnailSize: number
  onThumbnailSize: (size: number) => void
  viewMode: ViewMode
  onViewMode: (mode: ViewMode) => void
  onDeleteSmartFolder: (folder: SmartFolder) => void
  onReorderSmartFolders: (folders: SmartFolder[]) => void
  onDeleteTag: (tag: string) => void
}

const THUMB_SIZES: number[] = [120, 160, 220]

const SMART_FOLDER_LONG_PRESS_MS = 350
const SMART_FOLDER_DRAG_THRESHOLD_PX = 6

// 左サイドバー：件数・スマートフォルダ・タグ絞り込み・設定。サービス絞り込みは検索の site: で行う。
// フィルタ操作のロジックは filters フックに集約済みで、ここは表示と委譲のみ。
// タグの「+N 表示」折りたたみだけはサイドバー固有の表示状態なので内部に持つ。
export default function Sidebar({
  count, filters, smartFolders,
  searchTags, onRemoveSearchTag, onAddSearchTag, settingsActive, onToggleSettings,
  thumbnailSize, onThumbnailSize, viewMode, onViewMode,
  onDeleteSmartFolder, onReorderSmartFolders, onDeleteTag,
}: Props) {
  const nearestThumbSize = THUMB_SIZES.reduce(
    (best, size) => Math.abs(size - thumbnailSize) < Math.abs(best - thumbnailSize) ? size : best,
    THUMB_SIZES[0],
  )
  const [showAllTags, setShowAllTags] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const shortcutsBtnRef = useRef<HTMLButtonElement>(null)
  const [dragFolderId, setDragFolderId] = useState<string | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [tagCtxMenu, setTagCtxMenu] = useState<{ x: number; y: number; tag: string; keyboard?: boolean } | null>(null)
  const [dragDeltaY, setDragDeltaY] = useState(0)
  const smartFolderRowRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  // ドラッグ中は掴んだ行がポインタに追従する（transform で動かす）ため、離した位置も
  // 常に同じ要素の上になり、ブラウザは押下/離した要素が同一という理由で click を発火してしまう。
  // これをフィルタ選択のトグルとして扱うと並べ替えのたびに一覧の絞り込みが変わって画面が
  // ガタつくので、ドラッグが発生した後の click は選択解除で統一し、選択トグルは行わない。
  const smartFolderDraggedRef = useRef(false)
  const { width: sidebarWidth, handleResizeStart } = usePanelResize({
    storageKey: 'shiori-sidebar-width',
    min: SIDEBAR_MIN_WIDTH,
    max: SIDEBAR_MAX_WIDTH,
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    direction: 'right',
  })

  // 長押し（一定時間ホールド）でドラッグ開始と見なす。移動が閾値を超える前にタイマーが
  // 発火しなければ通常のクリック（開く／削除）として扱われ、既存の onClick に干渉しない。
  const handleSmartFolderPressStart = (e: React.PointerEvent, fromIndex: number): void => {
    if (e.button !== 0) return
    // ポインタキャプチャは実際にドラッグが始まった時点(タイマー発火時)まで取らない。
    // pointerdown 直後に取ってしまうと、それ以降の click の対象までこの行要素に
    // つけ替えられてしまい、通常のクリック（開く／削除ボタン）が一切反応しなくなる。
    const captureEl = e.currentTarget
    const pointerId = e.pointerId
    const startX = e.clientX
    const startY = e.clientY
    let dragging = false
    // ドロップ確定時の計算に使う「生」の挿入スロット番号。表示用の dragOverIndex
    // （null なら非表示）とは別に保持する。
    let rawOverIndex = fromIndex

    // 掴んでいる行自身は transform で追従して動いているため、その getBoundingClientRect は
    // ポインタと一緒に動いてしまい判定に使えない（自分自身と比較する形になり、特に
    // 下方向への移動が正しく判定できなくなる）。判定は掴んでいない行だけを対象にする。
    //
    // 比較の基準はポインタの生座標ではなく、掴んでいる行自身の「現在の中心位置」にする。
    // ポインタ位置をそのまま使うと、行の上端付近を掴んだ場合と下端付近を掴んだ場合とで
    // 見た目上どこまで重なったら切り替わるかがずれてしまい、行間の中央で綺麗に切り替わって
    // 見えない（掴んだ位置次第で早すぎたり遅すぎたりする）。
    const fromEl = smartFolderRowRefs.current.get(smartFolders[fromIndex].id)
    const fromRect = fromEl?.getBoundingClientRect()
    const fromCenter = fromRect ? fromRect.top + fromRect.height / 2 : startY

    const computeOverIndex = (deltaY: number): number => {
      const draggedCenter = fromCenter + deltaY
      for (let i = 0; i < smartFolders.length; i++) {
        if (i === fromIndex) continue
        const el = smartFolderRowRefs.current.get(smartFolders[i].id)
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (draggedCenter < r.top + r.height / 2) return i
      }
      return smartFolders.length
    }

    // 挿入スロット番号（overIndex）を実際の移動先 index へ正規化する。ドラッグ中の行は
    // 配列からまだ抜かれていないため、自分より後ろへ挿入する場合は1つ詰める必要がある。
    const resolveTargetIndex = (overIndex: number): number =>
      fromIndex < overIndex ? overIndex - 1 : overIndex

    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timer = null
      dragging = true
      smartFolderDraggedRef.current = true
      // ウィンドウ外に出ても pointerup を取りこぼさないよう、ドラッグ確定時にのみキャプチャする。
      captureEl.setPointerCapture(pointerId)
      setDragFolderId(smartFolders[fromIndex].id)
      // 持ち上げた直後はまだ動かしていない＝どこにドロップしても無意味（今の場所に戻るだけ）
      // なので、挿入ラインはまだ出さない。
      setDragOverIndex(null)
      setDragDeltaY(0)
    }, SMART_FOLDER_LONG_PRESS_MS)

    const cleanup = (): void => {
      if (timer !== null) { clearTimeout(timer); timer = null }
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      if (captureEl.hasPointerCapture(pointerId)) captureEl.releasePointerCapture(pointerId)
    }

    const onMove = (ev: PointerEvent): void => {
      if (!dragging) {
        if (timer !== null && Math.hypot(ev.clientX - startX, ev.clientY - startY) > SMART_FOLDER_DRAG_THRESHOLD_PX) {
          clearTimeout(timer)
          timer = null
        }
        return
      }
      const deltaY = ev.clientY - startY
      const raw = computeOverIndex(deltaY)
      rawOverIndex = raw
      // 先頭/末尾の行は反対側に比較対象が無いため、ほぼ動かしていなくても
      // computeOverIndex が最初から末尾（または先頭）を返してしまう。ドロップしても
      // 実際には順番が変わらない（今の位置に戻るだけの）位置では、挿入ラインを
      // 自分の元の場所に固定表示するのではなく非表示にする（null）。
      const isNoop = resolveTargetIndex(raw) === fromIndex
      setDragOverIndex(isNoop ? null : raw)
      setDragDeltaY(deltaY)
    }

    const onUp = (): void => {
      cleanup()
      if (!dragging) return
      setDragFolderId(null)
      setDragOverIndex(null)
      setDragDeltaY(0)
      // click は pointerup 直後に同期的に発火するのでここでは消さず、直後の
      // onClick に消させる。click 自体が起きなかった場合の保険として次のタスクで戻す。
      setTimeout(() => { smartFolderDraggedRef.current = false }, 0)
      const to = resolveTargetIndex(rawOverIndex)
      if (to === fromIndex) return
      const next = [...smartFolders]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(to, 0, moved)
      onReorderSmartFolders(next)
    }

    // OS/ブラウザ都合でポインタ操作自体が中断された場合は並べ替えを確定せずに状態だけ戻す。
    const onCancel = (): void => {
      cleanup()
      if (!dragging) return
      setDragFolderId(null)
      setDragOverIndex(null)
      setDragDeltaY(0)
      smartFolderDraggedRef.current = false
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  // 「N枚以上のタグ」だけを出す＋「現在フィルタ中でN枚未満のタグ」も可視に保つ。
  const visibleTags = useMemo(() => {
    if (showAllTags) return filters.allTags
    // allTags は件数の降順なので、しきい値を満たすものは先頭に固まっている。
    let base = filters.allTags.filter((tag) => (filters.tagCounts[tag] ?? 0) >= SIDEBAR_TAG_MIN_COUNT)
    // まだどのタグもしきい値に届かない小さなライブラリでは、タグ欄が空になってしまうので上位N件で代替する。
    if (base.length === 0) base = filters.allTags.slice(0, SIDEBAR_TAG_FALLBACK_LIMIT)
    const shown = [...base]
    for (const tag of [...filters.tagFilters, ...searchTags]) {
      if (filters.allTags.includes(tag) && !shown.includes(tag)) shown.push(tag)
    }
    return shown
  }, [filters.allTags, filters.tagCounts, filters.tagFilters, searchTags, showAllTags])

  const hiddenTagCount = Math.max(0, filters.allTags.length - visibleTags.length)
  const canCreateSmartFolder = filters.hasActiveFilter() && !filters.activeSmartFolderId
  const smartFolderAddTitle = canCreateSmartFolder
    ? '現在の絞り込みをスマートフォルダとして保存'
    : filters.activeSmartFolderId
      ? 'スマートフォルダ表示中は新規保存できません'
      : 'タグ・サイト・検索などで絞り込むと保存できます'

  useEffect(() => {
    if (canCreateSmartFolder) return
    filters.setCreatingFolder(false)
    filters.setNewFolderName('')
  }, [canCreateSmartFolder, filters])

  return (
    <aside style={{ ...s.sidebar, width: sidebarWidth }}>
      <div style={s.sidebarResizeHandle} onPointerDown={handleResizeStart} />
      <div style={s.sidebarScroll}>
        <div style={s.sidebarHeaderRow}>
          <div style={s.sidebarBrand}>
            <img src={appIcon} width={16} height={16} alt="" style={s.sidebarIcon} />
            <span style={s.sidebarBrandName}>Shiori</span>
          </div>
          <span style={s.count}>{count} 枚</span>
        </div>

        <div style={s.siteGroup}>
          <div style={{ ...s.siteGroupLabel, display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 28 }}>
            <span>スマートフォルダ</span>
            {!filters.creatingFolder && (
              <button
                onClick={() => { if (canCreateSmartFolder) filters.setCreatingFolder(true) }}
                disabled={!canCreateSmartFolder}
                style={{ ...s.smartFolderHeaderAddBtn, ...(canCreateSmartFolder ? {} : s.smartFolderHeaderAddBtnDisabled) }}
                title={smartFolderAddTitle}>
                <PlusIcon size={13} strokeWidth={2} />
              </button>
            )}
          </div>
          {filters.creatingFolder && (
            <div style={s.smartFolderCreateInputRow}>
              <input
                autoFocus
                style={s.smartFolderCreateInput}
                placeholder="フォルダ名"
                value={filters.newFolderName}
                onChange={(e) => filters.setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && filters.newFolderName.trim()) filters.saveSmartFolder(filters.newFolderName)
                  if (e.key === 'Escape') { filters.setCreatingFolder(false); filters.setNewFolderName('') }
                }}
              />
              <button
                onClick={() => filters.newFolderName.trim() && filters.saveSmartFolder(filters.newFolderName)}
                disabled={!filters.newFolderName.trim()}
                style={{ ...s.smartFolderAddIconBtn, opacity: filters.newFolderName.trim() ? 1 : 0.45 }}
                title="スマートフォルダを保存">
                <PlusIcon size={13} strokeWidth={2} />
              </button>
            </div>
          )}
          {smartFolders.map((folder, index) => (
            <div key={folder.id}>
              <div style={{ ...s.smartFolderInsertLine, opacity: dragFolderId && dragOverIndex === index ? 1 : 0 }} />
              <div
                ref={(el) => { if (el) smartFolderRowRefs.current.set(folder.id, el); else smartFolderRowRefs.current.delete(folder.id) }}
                onPointerDown={(e) => handleSmartFolderPressStart(e, index)}
                style={{
                  ...s.smartFolderRow,
                  ...(dragFolderId === folder.id
                    ? { ...s.smartFolderRowDragging, transform: `translateY(${dragDeltaY}px) scale(1.03)` }
                    : {}),
                }}>
                <button
                  onClick={() => {
                    if (smartFolderDraggedRef.current) { smartFolderDraggedRef.current = false; return }
                    filters.activeSmartFolderId === folder.id ? filters.clearAllFilters() : filters.loadSmartFolder(folder)
                  }}
                  style={{
                    ...s.smartFolderBtn,
                    ...(filters.activeSmartFolderId === folder.id ? s.smartFolderActive : {}),
                  }}
                  title={`${folder.name}（長押しで並べ替え）`}>
                  <FolderIcon size={12} strokeWidth={1.6} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{folder.name}</span>
                </button>
                <button
                  onClick={() => onDeleteSmartFolder(folder)}
                  style={s.smartFolderDeleteBtn}
                  title={`${folder.name}を削除`}>
                  <XIcon size={11} strokeWidth={2} />
                </button>
              </div>
            </div>
          ))}
          {smartFolders.length > 0 && (
            <div style={{ ...s.smartFolderInsertLine, opacity: dragFolderId && dragOverIndex === smartFolders.length ? 1 : 0 }} />
          )}
          {smartFolders.length === 0 && !filters.creatingFolder && (
            <div style={s.smartFolderEmpty}>保存済みのフォルダはまだありません</div>
          )}
        </div>

        {filters.allTags.length > 0 && (
          <div style={s.siteGroup}>
            <div style={{ ...s.siteGroupLabel, display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 28 }}>
              <span>タグ</span>
              <div style={s.tagLabelActions}>
                {/* タグクリックは searchTags（検索欄の tag:xxx）に書き込まれ、tagFilters は
                    旧形式スマートフォルダ経由でしか更新されないため、表示条件は両方の
                    合算で判定する（U-1）。buildImageQuery はマージ後の全タグに tagMode を
                    適用するので、クエリロジック側の変更は不要。 */}
                {[...new Set([...filters.tagFilters, ...searchTags])].length >= 2 && (
                  <button onClick={() => filters.setTagMode((m) => m === 'and' ? 'or' : 'and')}
                    style={{ ...s.tagModeBtn, color: filters.tagMode === 'and' ? 'var(--success)' : 'var(--warning)' }}>
                    {filters.tagMode === 'and' ? 'AND' : 'OR'}
                  </button>
                )}
                {(filters.tagFilters.length > 0 || searchTags.length > 0) && (
                  <button onClick={() => {
                    filters.setTagFilters([])
                    // searchTags 由来のタグは検索欄の tag:xxx トークンなので、まとめて1回で
                    // 剥がす（onRemoveSearchTag を複数回呼ぶと毎回同じ古い filters.search を
                    // 元に計算するため、後の呼び出しが前の呼び出しの結果を上書きしてしまう）。
                    const next = filters.search.replace(/(?:^|\s)tag:\S+/gi, '').replace(/\s+/g, ' ').trim()
                    filters.setSearch(next)
                    filters.commitSearch(next)
                  }} style={{ ...s.sidebarXBtn, ...s.tagClearBtn }} title="タグフィルターをすべて解除"><XIcon size={11} strokeWidth={2} /></button>
                )}
              </div>
            </div>
            <div style={s.sidebarTagList}>
              {visibleTags.map((tag) => {
                const active = filters.tagFilters.includes(tag) || searchTags.includes(tag)
                // 由来ごとに色相を固定し、非選択=薄い色 / 選択=濃い色で表す（手動: 薄緑→濃緑 / AI: 薄藍→濃藍）。
                // 選択で別色相に化けて色が混ざらないよう、由来別の active スタイルを使い分ける。
                const aiOnly = filters.aiOnlyTags.has(tag)
                const chipStyle = active
                  ? (aiOnly ? s.sidebarTagChipAiActive : s.sidebarTagChipActive)
                  : (aiOnly ? s.sidebarTagChipAi : s.sidebarTagChipManual)
                return (
                  <button key={tag}
                    onClick={() => {
                      // 解除は由来(スマートフォルダ由来のtagFilters／検索テキスト由来)を問わず両方から外す。
                      // 追加は検索欄のテキストに tag:xxx として書き込む — 検索欄と表示を一致させ、
                      // 見えない場所に絞り込み状態が溜まらないようにするため。
                      if (active) {
                        filters.setTagFilters((prev) => prev.filter((t) => t !== tag))
                        if (searchTags.includes(tag)) onRemoveSearchTag(tag)
                      } else {
                        onAddSearchTag(tag)
                      }
                    }}
                    onContextMenu={(e) => { e.preventDefault(); setTagCtxMenu({ x: e.clientX, y: e.clientY, tag }) }}
                    onKeyDown={(e) => {
                      // キーボードからもタグ削除メニューを開けるようにする（U-6）。右クリック相当。
                      // メニューはチップ左下に出し、先頭項目を選択済みにして Enter 即実行できるようにする。
                      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                        e.preventDefault()
                        const r = e.currentTarget.getBoundingClientRect()
                        setTagCtxMenu({ x: r.left, y: r.bottom, tag, keyboard: true })
                      }
                    }}
                    style={{ ...s.sidebarTagChip, ...chipStyle }}
                    title={`${tag}${aiOnly ? '（AIタグ）' : ''}（右クリック / Shift+F10 でタグ自体を削除）`}>
                    <span style={s.sidebarTagChipText}>{tag}</span>
                  </button>
                )
              })}
            </div>
            {hiddenTagCount > 0 && (
              <button style={s.sidebarMoreBtn} onClick={() => setShowAllTags((v) => !v)}>
                {/* UX-5: 「付けたタグが出てこない」を防ぐため、隠れている理由（枚数しきい値未満）を明示する */}
                {showAllTags ? '折りたたむ' : `+${hiddenTagCount}（${SIDEBAR_TAG_MIN_COUNT}枚未満）表示`}
              </button>
            )}
          </div>
        )}
      </div>
      {tagCtxMenu && (
        <ContextMenu
          x={tagCtxMenu.x}
          y={tagCtxMenu.y}
          items={[{ label: `タグ「${tagCtxMenu.tag}」を全画像から削除`, danger: true, onClick: () => onDeleteTag(tagCtxMenu.tag) }]}
          initialHighlight={tagCtxMenu.keyboard ? 0 : -1}
          onClose={() => setTagCtxMenu(null)}
        />
      )}

      <div style={s.sidebarUtilitySection}>
        <div style={s.sidebarControls}>
          <div style={s.thumbSizeControl} title="サムネイルサイズ">
            {/* 選択中ハイライト（背面）。選択先のセグメントへスライドする。settings.json の
                thumbnailSize は 80-360 を許容するが UI は3択のみなので、旧値・手編集で
                ちょうど一致しない値が入っていても最も近いボタンをアクティブに見せる
                （でないと indexOf===-1 でどのボタンもハイライトされなくなる）。 */}
            <div style={{ ...s.segSlider, width: 34, transform: `translateX(${THUMB_SIZES.indexOf(nearestThumbSize) * 34}px)` }} />
            {([['S', 120], ['M', 160], ['L', 220]] as const).map(([label, size]) => (
              <button key={size}
                style={{ ...s.thumbSizeBtn, ...(nearestThumbSize === size ? s.segActive : {}) }}
                onClick={() => onThumbnailSize(size)}
                title={label === 'S' ? '小' : label === 'M' ? '中' : '大'}>{label}</button>
            ))}
          </div>
          <div style={s.controlDivider} />
          <div style={s.viewToggle}>
            <div style={{ ...s.segSlider, width: 38, transform: `translateX(${viewMode === 'timeline' ? 38 : 0}px)` }} />
            {([['grid', <GridIcon key="i" />, 'グリッド'], ['timeline', <ListIcon key="i" />, 'タイムライン']] as const).map(([mode, icon, label]) => (
              <button key={mode}
                style={{ ...s.viewToggleBtn, ...(viewMode === mode ? s.segActive : {}) }}
                onClick={() => onViewMode(mode)} title={label}>{icon}</button>
            ))}
          </div>
        </div>
        <div style={s.sidebarBottom}>
          <button style={{ ...s.gearBtn, color: settingsActive ? 'var(--accent-text)' : 'var(--text-secondary)' }}
            onClick={onToggleSettings}>
            <SettingsIcon size={16} />
            <span style={{ fontSize: font.base, fontWeight: 800 }}>設定</span>
          </button>
          <button ref={shortcutsBtnRef} style={{ ...s.gearBtn, ...s.shortcutsBtn, color: showShortcuts ? 'var(--accent-text)' : 'var(--text-secondary)' }}
            onClick={() => setShowShortcuts((v) => !v)} title="ショートカット一覧">
            <HelpCircleIcon size={16} />
          </button>
        </div>
      </div>
      {showShortcuts && (
        <ShortcutsFlyout anchorEl={shortcutsBtnRef.current} onClose={() => setShowShortcuts(false)} />
      )}
    </aside>
  )
}
