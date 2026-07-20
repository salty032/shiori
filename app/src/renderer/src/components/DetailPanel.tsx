import { useState, useEffect, useMemo, useRef } from 'react'
import type { ImageRow, ImageTagSource, Settings } from '../types'
import { cleanTitle, siteName, formatTime, mediaUrl, thumbSrc, normalizeTag, tagSuggestions, fetchBulkTagFrequency, addTagToImages, removeTagFromImages } from '../utils'
import { font, color, s as commonStyles } from '../styles'
import TagEditor from './TagEditor'
import TagSuggestInput from './TagSuggestInput'
import ContextMenu from './ContextMenu'
import { ExternalLinkIcon, PencilIcon } from './Icon'
import { usePanelResize } from '../hooks/usePanelResize'
import VideoPlayer from './VideoPlayer'
import { getMediaActions } from '../features/registry'

type Props = {
  selectedIds: Set<number>
  single: ImageRow | null
  settings: Settings
  taggerDoneKey: number
  allTags: string[]
  // ビューア表示中は DetailPanel の VideoPlayer を一時停止する（同じクリップがビューア側でも
  // 再生され、音声が二重に鳴るのを防ぐ）。
  viewerOpen: boolean
  onTagsChanged: () => void
  onTitleChanged: (id: number, title: string) => void
  onMemoChanged: (id: number, memo: string) => void
  onFilterByTag: (tag: string) => void
  onExport: () => void
  onDelete: () => void
  onClearSelection: () => void
}

// coverage=選択中の何枚に付いているか（all=全部 / some=一部）。source=集約後の由来。
// 色を由来（緑=手動 / 藍=AI）に固定し、coverage は破線＋件数バッジという別チャンネルで表す。
type BulkCoverage = 'all' | 'some'
type BulkTagEntry = { coverage: BulkCoverage; source: ImageTagSource }
type MemoSaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
type PendingMemoSave = { id: number; value: string; base: string }
// フォルダドロップ等で自動タグ付けが連続完了すると taggerDoneKey が連打され、
// そのたびに選択枚数ぶんの再取得が走ってしまう（N×M の増幅）ため、トレーリングデバウンスで束ねる。
const BULK_TAG_REFRESH_DEBOUNCE_MS = 300
const MEMO_AUTOSAVE_DELAY_MS = 700

// 全部付き(all)を先頭、次に手動→AIの順、最後にタグ名で安定ソート。
function sortBulkTags(a: [string, BulkTagEntry], b: [string, BulkTagEntry]): number {
  if (a[1].coverage !== b[1].coverage) return a[1].coverage === 'all' ? -1 : 1
  if (a[1].source !== b[1].source) return a[1].source === 'manual' ? -1 : 1
  return a[0].localeCompare(b[0])
}

// titleInput は box-sizing: border-box のため、height には border 分を足し戻す必要がある
// （scrollHeight は border を含まないため、素で代入すると border-bottom の 1px 分だけ縮んでしまう）
function resizeTitleInput(el: HTMLTextAreaElement): void {
  const borderHeight = el.offsetHeight - el.clientHeight
  el.style.height = 'auto'
  el.style.height = (el.scrollHeight + borderHeight) + 'px'
}

export default function DetailPanel({ selectedIds, single, settings, taggerDoneKey, allTags, viewerOpen, onTagsChanged, onTitleChanged, onMemoChanged, onFilterByTag, onExport, onDelete, onClearSelection }: Props) {
  const { width: panelWidth, handleResizeStart } = usePanelResize({
    storageKey: 'shiori-detail-width',
    min: 300,
    max: 600,
    defaultWidth: 300,
    direction: 'left',
  })
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleExpanded, setTitleExpanded] = useState(false)
  const [memoDraft, setMemoDraft] = useState('')
  const [memoStatus, setMemoStatus] = useState<MemoSaveStatus>('idle')
  const titleInputRef = useRef<HTMLTextAreaElement>(null)
  const savingRef = useRef(false)  // prevents Escape/Enter from double-saving via onBlur
  const memoStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const memoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingMemoSaveRef = useRef<PendingMemoSave | null>(null)
  const activeImageIdRef = useRef<number | null>(single?.id ?? null)
  const prevTaggerDoneKeyRef = useRef(taggerDoneKey)

  const [bulkTagMap, setBulkTagMap] = useState<Map<string, BulkTagEntry>>(new Map())
  const [bulkTagInput, setBulkTagInput] = useState('')
  const [bulkTagInputOpen, setBulkTagInputOpen] = useState(false)
  const bulkInputRef = useRef<HTMLInputElement>(null)
  const selectedIdList = useMemo(() => [...selectedIds].sort((a, b) => a - b), [selectedIds])
  const selectedIdsKey = useMemo(() => selectedIdList.join(','), [selectedIdList])

  const [bulkTagCtxMenu, setBulkTagCtxMenu] = useState<{ x: number; y: number; tag: string } | null>(null)
  // まずサムネ（軽量）を表示し、原本のデコードが終わったら差し替える（R-7）。矢印キーで
  // 選択を連続移動したときにフル解像度デコード待ちでパネル反映が遅れるのを防ぐ。
  const [fullImageSrc, setFullImageSrc] = useState<string | null>(null)

  useEffect(() => {
    if (!single || single.media_type === 'video') return
    setFullImageSrc(null)
    let canceled = false
    const preload = new Image()
    preload.onload = () => { if (!canceled) setFullImageSrc(mediaUrl(single.id)) }
    preload.src = mediaUrl(single.id)
    return () => { canceled = true }
  }, [single?.id, single?.media_type])

  const bulkSuggestions = useMemo(() => {
    return tagSuggestions(bulkTagInput, allTags, (tag) => bulkTagMap.get(tag)?.coverage !== 'all')
  }, [allTags, bulkTagInput, bulkTagMap])

  // 選択画像が変わったときだけ編集状態をリセットする。taggerDoneKey の変化（裏で別画像の
  // 自動タグ付けが完了しただけ）でここが再実行されると、入力中のタイトル・メモ・タグ欄が
  // 破棄されてしまうため、タグ再取得（下の effect）とは意図的に分離している。
  useEffect(() => {
    if (!single) return
    activeImageIdRef.current = single.id
    savingRef.current = true   // cancel any in-progress edit on image change
    if (memoStatusTimerRef.current) clearTimeout(memoStatusTimerRef.current)
    setEditingTitle(false)
    setTitleExpanded(false)
    setMemoDraft(single.memo ?? '')
    setMemoStatus('idle')
    return () => {
      if (memoSaveTimerRef.current) clearTimeout(memoSaveTimerRef.current)
      const pending = pendingMemoSaveRef.current
      if (pending) void persistMemo(pending, false)
    }
  }, [single?.id])

  useEffect(() => () => {
    if (memoStatusTimerRef.current) clearTimeout(memoStatusTimerRef.current)
    if (memoSaveTimerRef.current) clearTimeout(memoSaveTimerRef.current)
  }, [])

  // 単一選択の場合と同じ理由で、入力欄のリセットは選択変更時のみ行い、
  // bulkTagMap の再取得（裏での自動タグ付け完了含む）とは分離する。
  useEffect(() => {
    if (selectedIds.size <= 1) return
    setBulkTagInput('')
    setBulkTagInputOpen(false)
  }, [selectedIds.size, selectedIdsKey])

  useEffect(() => {
    if (selectedIds.size <= 1) { setBulkTagMap(new Map()); return }
    // 選択そのものが変わった場合は体感即時（delay 0）、taggerDoneKey だけが変わった場合
    // （裏での自動タグ付け連続完了によるバースト）は 300ms デバウンスする。
    const delay = taggerDoneKey === prevTaggerDoneKeyRef.current ? 0 : BULK_TAG_REFRESH_DEBOUNCE_MS
    prevTaggerDoneKeyRef.current = taggerDoneKey
    let canceled = false
    const timer = setTimeout(() => {
      fetchBulkTagFrequency(selectedIdList)
        .then((freq) => {
          if (canceled) return
          const total = selectedIdList.length
          const map = new Map<string, BulkTagEntry>()
          for (const [name, { count, source }] of freq) map.set(name, { coverage: count === total ? 'all' : 'some', source })
          setBulkTagMap(map)
        }).catch((err) => { if (!canceled) console.error('[tags] getTagsBulk failed', err) })
    }, delay)
    return () => { canceled = true; clearTimeout(timer) }
  }, [selectedIds.size, selectedIdsKey, selectedIdList, taggerDoneKey])

  async function bulkAddTag(name: string): Promise<void> {
    const trimmed = normalizeTag(name)
    if (!trimmed) return
    try {
      await addTagToImages(selectedIdList, trimmed)
      setBulkTagMap(prev => new Map([...prev, [trimmed, { coverage: 'all', source: 'manual' }]]))
      setBulkTagInputOpen(false)
      onTagsChanged()
    } catch (err) {
      console.error('[tag] bulkAddTag failed', err)
    }
  }

  async function bulkRemoveTag(name: string): Promise<void> {
    try {
      await removeTagFromImages(selectedIdList, name)
      setBulkTagMap(prev => { const next = new Map(prev); next.delete(name); return next })
      onTagsChanged()
    } catch (err) {
      console.error('[tag] bulkRemoveTag failed', err)
    }
  }

  function openBulkTagInput(): void {
    setBulkTagInputOpen(true)
    setTimeout(() => bulkInputRef.current?.focus(), 0)
  }

  function startEditingTitle(): void {
    if (!single) return
    savingRef.current = false
    setTitleDraft(single.title ?? '')
    setEditingTitle(true)
    setTimeout(() => {
      const el = titleInputRef.current
      if (!el) return
      el.select()
      resizeTitleInput(el)
    }, 0)
  }

  async function persistMemo(pending: PendingMemoSave, showStatus: boolean): Promise<void> {
    if (pending.value === pending.base) {
      if (memoStatusTimerRef.current) clearTimeout(memoStatusTimerRef.current)
      if (activeImageIdRef.current === pending.id) setMemoStatus('idle')
      pendingMemoSaveRef.current = null
      return
    }
    try {
      if (memoStatusTimerRef.current) clearTimeout(memoStatusTimerRef.current)
      if (showStatus && activeImageIdRef.current === pending.id) setMemoStatus('saving')
      await window.api.updateImageMemo(pending.id, pending.value)
      onMemoChanged(pending.id, pending.value)
      if (pendingMemoSaveRef.current?.id === pending.id && pendingMemoSaveRef.current.value === pending.value) {
        pendingMemoSaveRef.current = null
      }
      if (showStatus && activeImageIdRef.current === pending.id) {
        setMemoStatus('saved')
        memoStatusTimerRef.current = setTimeout(() => setMemoStatus('idle'), 1600)
      }
    } catch (err) {
      if (showStatus && activeImageIdRef.current === pending.id) setMemoStatus('error')
      console.error('[memo] save failed', err)
    }
  }

  function scheduleMemoSave(pending: PendingMemoSave): void {
    pendingMemoSaveRef.current = pending
    if (memoSaveTimerRef.current) clearTimeout(memoSaveTimerRef.current)
    memoSaveTimerRef.current = setTimeout(() => {
      memoSaveTimerRef.current = null
      void persistMemo(pending, true)
    }, MEMO_AUTOSAVE_DELAY_MS)
  }

  async function saveMemo(): Promise<void> {
    if (!single) return
    if (memoSaveTimerRef.current) clearTimeout(memoSaveTimerRef.current)
    memoSaveTimerRef.current = null
    const pending = pendingMemoSaveRef.current ?? { id: single.id, value: memoDraft, base: single.memo ?? '' }
    await persistMemo(pending, true)
  }

  async function saveTitle(): Promise<void> {
    if (savingRef.current) return
    savingRef.current = true
    setEditingTitle(false)
    if (!single || titleDraft === (single.title ?? '')) return
    try {
      await window.api.updateImageTitle(single.id, titleDraft)
      onTitleChanged(single.id, titleDraft)
    } catch (err) {
      savingRef.current = false
      setEditingTitle(true)
      console.error('[title] save failed', err)
    }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); saveTitle() }
    if (e.key === 'Escape') { savingRef.current = true; setEditingTitle(false) }
  }

  function handleBulkConfirm(val: string): void {
    setBulkTagInput('')
    bulkAddTag(val)
  }

  function handleBulkCancel(): void {
    setBulkTagInput('')
    setBulkTagInputOpen(false)
  }

  return (
    <>
    <aside style={{ ...s.panel, width: panelWidth }} data-keep-selection>
      <div style={s.resizeHandle} onPointerDown={handleResizeStart} />
      {/* single を先に見る: ビューア表示中は selectedIds が空でも single はビューアの
          現在画像を指すため、通常の「未選択」空表示より優先する（P1）。 */}
      {single ? (
        <>
          <div style={s.panelContent}>
          {single.media_type === 'video' ? (
            <VideoPlayer id={single.id} wrapperStyle={s.videoWrap} videoStyle={s.videoEl} pauseWhen={viewerOpen} />
          ) : (
            <img src={fullImageSrc ?? thumbSrc(single)} style={s.img} alt="" />
          )}
          <div style={s.meta}>
            <div style={s.titleRow}>
              {editingTitle ? (
                <textarea
                  ref={titleInputRef}
                  style={s.titleInput}
                  value={titleDraft}
                  rows={1}
                  onChange={(e) => {
                    setTitleDraft(e.target.value)
                    resizeTitleInput(e.target)
                  }}
                  onKeyDown={handleTitleKeyDown}
                  onBlur={saveTitle}
                />
              ) : (
                <div style={s.titleDisplayRow}>
                  <span
                    style={{
                      ...s.titleValue,
                      ...(titleExpanded ? {} : s.titleValueClamped),
                    }}
                    tabIndex={0}
                    onClick={() => setTitleExpanded((v) => !v)}
                    onDoubleClick={startEditingTitle}
                    onKeyDown={(e) => { if (e.key === 'F2' || (e.key === 'Enter' && !e.nativeEvent.isComposing)) startEditingTitle() }}
                    title="クリックで展開 / ダブルクリックまたはF2で編集"
                  >
                    {cleanTitle(single.title, settings.titleStrip)}
                  </span>
                  <button style={s.titleEditBtn} onClick={startEditingTitle} title="タイトルを編集"><PencilIcon size={13} /></button>
                </div>
              )}
            </div>
            {(single.current_time != null || single.media_type === 'video') && (
              <div style={s.metaHalf}>
                <div style={s.metaRow}>
                  <span style={s.label}>動画時刻</span>
                  <span style={s.value}>{single.current_time != null ? formatTime(single.current_time) : '—'}</span>
                </div>
                {single.media_type === 'video' && (
                  <div style={s.metaRow}>
                    <span style={s.label}>長さ</span>
                    <span style={s.value}>{single.duration != null ? formatTime(single.duration) : '—'}</span>
                  </div>
                )}
              </div>
            )}
          </div>
          <div style={s.searchTile}>
            <TagEditor
              imageId={single.id}
              allTags={allTags}
              taggerDoneKey={taggerDoneKey}
              onTagsChanged={onTagsChanged}
              onFilterByTag={onFilterByTag}
            />

            <div style={s.row}>
              <div style={s.memoLabelRow}>
                <span style={s.label}>メモ</span>
                {memoStatus !== 'idle' && (
                  <span style={{ ...s.memoStatus, ...(memoStatus === 'error' ? s.memoStatusError : {}) }}>
                    {memoStatus === 'dirty' ? '未保存' : memoStatus === 'saving' ? '保存中...' : memoStatus === 'saved' ? '保存済み' : '保存失敗'}
                  </span>
                )}
              </div>
              <textarea
                style={s.memoInput}
                value={memoDraft}
                placeholder="メモを入力..."
                rows={3}
                onChange={(e) => {
                  if (memoStatusTimerRef.current) clearTimeout(memoStatusTimerRef.current)
                  const nextMemo = e.target.value
                  const baseMemo = single.memo ?? ''
                  setMemoDraft(nextMemo)
                  setMemoStatus(nextMemo === baseMemo ? 'idle' : 'dirty')
                  if (nextMemo === baseMemo) {
                    pendingMemoSaveRef.current = null
                    if (memoSaveTimerRef.current) clearTimeout(memoSaveTimerRef.current)
                  } else {
                    scheduleMemoSave({ id: single.id, value: nextMemo, base: baseMemo })
                  }
                }}
                onBlur={saveMemo}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    if (memoStatusTimerRef.current) clearTimeout(memoStatusTimerRef.current)
                    if (memoSaveTimerRef.current) clearTimeout(memoSaveTimerRef.current)
                    pendingMemoSaveRef.current = null
                    setMemoDraft(single.memo ?? '')
                    setMemoStatus('idle')
                  }
                }}
              />
            </div>

            <div style={s.metaFooter}>
              {single.url && (
                <div style={s.subtleRow}>
                  <span style={s.subtleLabel}>サイト</span>
                  <button style={s.subtleUrlBadge} onClick={() => window.api.openUrl(single.url!)} title={single.url}>
                    {siteName(single.url)}
                    <ExternalLinkIcon size={11} />
                  </button>
                </div>
              )}
              <div style={s.subtleRow}>
                <span style={s.subtleLabel}>取得日時</span>
                <span style={s.subtleValue}>{new Date(single.captured_at).toLocaleString('ja-JP')}</span>
              </div>
            </div>
          </div>
          </div>
          <div style={s.actions}>
            {getMediaActions(single)}
            <button style={s.showInFolderBtn} onClick={onExport}>エクスポート</button>
            <button style={s.deleteActionBtn} onClick={onDelete}>削除</button>
          </div>
        </>
      ) : selectedIds.size === 0 ? (
        <div style={s.empty}>
          <div style={s.emptyTitle}>画像を選択</div>
          <div style={s.emptyHints}>
            <div>クリックで選択・ダブルクリックで拡大</div>
            <div>タグをクリックで絞り込み</div>
            <div>T キーで選択中にタグ追加</div>
          </div>
        </div>
      ) : (
        <>
        <div style={s.panelContent}>
        <div style={s.multi}>
          <div style={s.multiHeader}>
            <div style={s.multiCount}>{selectedIds.size}枚選択中</div>
            <button style={s.multiClearBtn} onClick={onClearSelection}>解除</button>
          </div>
          <div style={s.tagSection}>
            <div style={s.tagLabel}>タグ（一括編集）</div>
            <div style={s.tagList}>
              {[...bulkTagMap.entries()]
                .sort(sortBulkTags)
                .map(([name, entry]) => {
                  const partial = entry.coverage === 'some'
                  const base = entry.source === 'ai' ? commonStyles.tagChipAi : commonStyles.tagChipManual
                  return (
                    <span key={name}
                      style={{ ...base, ...(partial ? s.tagChipPartialMod : {}), cursor: partial ? 'pointer' : 'default' }}
                      title={(entry.source === 'ai' ? 'AIタグ' : '手動タグ') + (partial ? '・一部の画像のみ（クリックですべてに追加）' : '') + '（右クリックで削除）'}
                      onClick={() => partial ? bulkAddTag(name) : undefined}
                      onContextMenu={(e) => { e.preventDefault(); setBulkTagCtxMenu({ x: e.clientX, y: e.clientY, tag: name }) }}>
                      {name}
                    </span>
                  )
                })}
              {bulkTagCtxMenu && (
                <ContextMenu
                  x={bulkTagCtxMenu.x}
                  y={bulkTagCtxMenu.y}
                  items={[{ label: `タグ「${bulkTagCtxMenu.tag}」を削除`, danger: true, onClick: () => bulkRemoveTag(bulkTagCtxMenu.tag) }]}
                  onClose={() => setBulkTagCtxMenu(null)}
                />
              )}
              {bulkTagInputOpen ? (
                <TagSuggestInput
                  inputRef={bulkInputRef}
                  value={bulkTagInput}
                  onChange={setBulkTagInput}
                  suggestions={bulkSuggestions}
                  placeholder="タグを追加（選択中すべてに）..."
                  onConfirm={handleBulkConfirm}
                  onCancel={handleBulkCancel}
                />
              ) : (
                <button style={commonStyles.addTagChip} onClick={openBulkTagInput}>+ タグ</button>
              )}
            </div>
          </div>
        </div>
        </div>
        <div style={s.actions}>
          <button style={s.showInFolderBtn} onClick={onExport}>エクスポート</button>
          <button style={s.deleteActionBtn} onClick={onDelete}>削除</button>
        </div>
        </>
      )}
    </aside>
    </>
  )
}

const s: Record<string, React.CSSProperties> = {
  panel: { background: 'var(--bg-page)', borderLeft: '1px solid var(--border-default)', flexShrink: 0, display: 'flex', flexDirection: 'column', position: 'relative' as const },
  resizeHandle: { position: 'absolute' as const, left: 0, top: 0, bottom: 0, width: 4, cursor: 'col-resize', zIndex: 10, userSelect: 'none' as const },
  panelContent: { flex: 1, overflowY: 'auto' as const },
  searchTile: { padding: '8px 16px 16px', background: 'var(--bg-page)', display: 'flex', flexDirection: 'column' as const, gap: 16 },
  actions: { padding: '16px 12px', borderTop: '1px solid var(--border-default)', background: 'var(--bg-page)', display: 'flex', flexDirection: 'column' as const, gap: 10, flexShrink: 0 },
  empty: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, padding: '0 20px', textAlign: 'center' as const },
  emptyTitle: { color: 'var(--text-secondary)', fontSize: font.base, fontWeight: 700 },
  emptyHints: { display: 'flex', flexDirection: 'column' as const, gap: 5, color: 'var(--text-secondary)', fontSize: font.sm, lineHeight: 1.6 },
  img: { width: 'calc(100% - 20px)', margin: '10px 10px 0', borderRadius: 4, aspectRatio: '16 / 9', objectFit: 'contain' as const, background: 'var(--bg-surface)', border: '1px solid var(--border-default)', display: 'block', flexShrink: 0 },
  videoWrap: { width: 'calc(100% - 20px)', margin: '10px 10px 0', borderRadius: 4, aspectRatio: '16 / 9', background: 'var(--bg-surface)', border: '1px solid var(--border-default)', overflow: 'hidden', display: 'block', flexShrink: 0 },
  videoEl: { width: '100%', height: '100%', objectFit: 'contain' as const, display: 'block' },
  meta: { padding: '14px 16px 8px', display: 'flex', flexDirection: 'column', gap: 8 },
  titleRow: { display: 'flex', flexDirection: 'column', gap: 5 },
  titleDisplayRow: { display: 'flex', alignItems: 'flex-start', gap: 6, borderBottom: '1px solid var(--border-default)', paddingBottom: 8 },
  metaHalf: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start', padding: '2px 0 3px' },
  metaRow: { display: 'flex', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  row: { display: 'flex', flexDirection: 'column', gap: 5 },
  label: { color: 'var(--text-muted)', fontSize: font.xs, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 800 },
  value: { fontSize: font.base, color: 'var(--text-bright)', wordBreak: 'break-all', userSelect: 'text' as const, fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
  // 短いタイトルでも常に3行分の領域を確保し、画像によって下の要素の位置がズレないようにする
  titleValue: { flex: 1, minWidth: 0, fontSize: font.base, color: 'var(--text-primary)', lineHeight: 1.45, minHeight: 'calc(1.45em * 3)', fontWeight: 700, wordBreak: 'break-word', cursor: 'pointer', userSelect: 'text' as const },
  titleValueClamped: { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' },
  titleEditBtn: { flexShrink: 0, width: 28, height: 28, padding: 0, background: 'rgba(var(--surface-rgb), 0.55)', border: '1px solid transparent', borderRadius: 4, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, lineHeight: 1 },
  titleInput: { width: 'calc(100% - 34px)', minHeight: 'calc(1.45em * 3 + 9px)', background: 'transparent', border: 'none', borderBottom: '1px solid var(--border-default)', color: 'var(--text-primary)', padding: '0 0 8px', fontSize: font.base, fontWeight: 700, outline: 'none', boxSizing: 'border-box' as const, resize: 'none' as const, overflow: 'hidden', display: 'block', wordBreak: 'break-word', lineHeight: 1.45, fontFamily: 'inherit' },
  metaFooter: { marginTop: 2, paddingTop: 12, borderTop: '1px solid rgba(var(--border-rgb), 0.72)', display: 'flex', flexDirection: 'column' as const, gap: 8 },
  subtleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, minWidth: 0 },
  subtleLabel: { color: 'var(--text-muted)', fontSize: font.sm, fontWeight: 600 },
  subtleValue: { color: 'var(--text-muted)', fontSize: font.sm, userSelect: 'text' as const, textAlign: 'right' as const, lineHeight: 1.35 },
  subtleUrlBadge: { minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0, background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: font.sm, fontWeight: 600, cursor: 'pointer', textAlign: 'right' as const, lineHeight: 1.35 },
  memoLabelRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 16 },
  memoStatus: { color: 'var(--text-secondary)', fontSize: font.xs, fontWeight: 700, lineHeight: 1 },
  memoStatusError: { color: color.danger },
  tagSection: { display: 'flex', flexDirection: 'column', gap: 8 },
  tagLabel: { color: 'var(--text-muted)', fontSize: font.xs, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 800 },
  tagList: { display: 'flex', flexWrap: 'wrap', gap: 7, minHeight: 4 },
  // 「一部にのみ付いている」= coverage:some を表す修飾。由来色(緑/藍)の上に重ね、色相は保ったまま
  // 破線＋減光で「まだ全部には付いていない」を示す。
  tagChipPartialMod: { borderStyle: 'dashed' as const, opacity: 0.66 },
  memoInput: { width: '100%', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 4, color: 'var(--text-primary)', padding: '10px 12px', fontSize: font.base, outline: 'none', resize: 'vertical' as const, boxSizing: 'border-box' as const, fontFamily: 'inherit', lineHeight: 1.5 },
  multi: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 },
  multiHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  multiCount: { color: 'var(--text-secondary)', fontSize: font.lg },
  multiClearBtn: { flexShrink: 0, padding: '4px 8px', background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: font.xs, fontWeight: 700 },
  showInFolderBtn: { width: '100%', height: 34, padding: '0 10px', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 3, color: 'var(--text-bright)', cursor: 'pointer', fontSize: font.xs, fontWeight: 800, whiteSpace: 'nowrap' as const },
  deleteActionBtn: { width: '100%', height: 34, padding: '0 10px', background: color.dangerBg, border: `1px solid ${color.dangerBorder}`, borderRadius: 3, color: color.danger, cursor: 'pointer', fontSize: font.xs, fontWeight: 800, whiteSpace: 'nowrap' as const },
}
