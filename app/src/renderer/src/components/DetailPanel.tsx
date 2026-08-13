import { useState, useEffect, useMemo, useRef } from 'react'
import type { ImageRow, ImageTagSource, Settings } from '../types'
import { cleanTitle, siteName, formatTime, formatFps, mediaUrl, thumbSrc, normalizeTag, tagSuggestions, fetchBulkTagFrequency, addTagToImages, removeTagFromImages } from '../utils'
import { font, color, s as commonStyles } from '../styles'
import TagEditor from './TagEditor'
import TagSuggestInput from './TagSuggestInput'
import ContextMenu from './ContextMenu'
import { ExternalLinkIcon, PencilIcon } from './Icon'
import { usePanelResize } from '../hooks/usePanelResize'
import VideoPlayer from './VideoPlayer'
import { getMediaActions } from '../features/registry'
import { useT } from '../i18n'

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
  const { t, tp, locale } = useT()
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

  // 撮り逃したコマの注記。画面キャプチャの供給が素材のコマ数の2倍に届かないと、
  // 自分の表示区間内に絵が無いコマが生じる。同じ絵が続く区間なら実害は無いが、
  // 絵の変わり目に当たるとコマ打ちの数を誤るため、あるときだけ静かに知らせる。
  //
  // 保存後の検証（frame-verify.ts）が済んでいれば、撮り逃しのうち「絵が変わっていて
  // どのコマで変わったか特定できない」コマだけを出す。撮り逃しの大半は同じ絵が続く区間で
  // 実害が無く、それも並べて数えると本当に数え直しが要る数コマが埋もれるため。
  // 検証済みで0コマなら何も出さない（注記が無い＝確認の要る箇所が無い、と読める）。
  // 「通知そのものが来なかったコマ」の注記。
  //
  // **撮り逃し（下の uncapturedNote）より悪い。** 撮り逃しは「コマはあったが専用の絵が無い」で
  // 枚数にも割合にも出るが、こちらは表に入っていないので**どの数字の分母にも入らない**。
  // 実測（60fps 素材）では「9 割撮れています」と出ている裏で、素材の 2 割が表に無かった。
  //
  // 表の行数（source_frames）と、素材の fps × 尺から期待される数を突き合わせて出す。
  // 5% は録画停止のラグで duration が僅かに長く出るぶんの余裕（24/30fps の実測は誤差 1% 未満）。
  const unreportedNote = useMemo(() => {
    if (single?.media_type !== 'video') return null
    const missing = single.unreported_frames
    const table = single.source_frames
    if (missing == null || table == null || missing <= 0) return null
    // 見積もりではなく main が測った値をそのまま出す（frame-feed の countReportDrops）。
    // 以前はここで fps × 尺から見積もっており、同じ事実にログ 98 コマ／画面 85 コマと
    // 2 つの数字が出ていた。**同じことを 2 通りに数えない。**
    const expected = table + missing
    if (missing / expected <= 0.05) return null
    return {
      text: t('detail.unreportedFrames', { count: String(missing) }),
      title: t('detail.unreportedFramesHint', { count: String(missing), expected: String(expected) })
    }
  }, [single, t])

  const uncapturedNote = useMemo(() => {
    const missing = single?.uncaptured_frames
    if (single?.media_type !== 'video' || missing == null || missing <= 0) return null
    // 母数は実測（フレーム表の行数）を優先する。fps × duration は、duration が録画停止までの
    // ラグを含むぶん過大になるうえ、fps の無い行では 0 になって判定が黙って効かなくなる。
    const total = single.source_frames ?? (single.fps && single.duration ? single.fps * single.duration : 0)
    const ambiguous = single.ambiguous_frames
    if (ambiguous == null) {
      // 未検証（検証前・検証に失敗・従来のクリップ）。分かっているのは撮り逃した枚数だけ。
      return { text: t('detail.uncapturedFrames', { count: String(missing) }), severe: (total > 0 ? missing / total : 0) > 0.05 }
    }
    if (ambiguous <= 0) return null
    return {
      text: t('detail.ambiguousFrames', { count: String(ambiguous) }),
      title: t('detail.ambiguousFramesHint', { missed: String(missing), ambiguous: String(ambiguous) }),
      severe: (total > 0 ? ambiguous / total : 0) > 0.02
    }
  }, [single, t])

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
                    title={t('detail.titleHint')}
                  >
                    {cleanTitle(single.title, settings.titleStrip)}
                  </span>
                  <button style={s.titleEditBtn} onClick={startEditingTitle} title={t('detail.editTitle')}><PencilIcon size={13} /></button>
                </div>
              )}
            </div>
            {(single.current_time != null || single.media_type === 'video') && (
              <div style={s.metaHalf}>
                {/* 動画時刻は1段目・列1に単独配置、長さ・フレームレートは2段目に1列ずつ。
                    span + justify-content で伸ばす形だと、動画時刻だけラベル・値の間隔や
                    行の縦幅が2段目と揃わず浮いて見えたため、3項目とも同じ「列1つぶんの
                    metaRow」に統一し、grid の行・列だけを明示的に指定する。 */}
                <div style={{ ...s.metaRow, gridColumn: 1, gridRow: 1 }}>
                  <span style={s.label}>{t('detail.timecode')}</span>
                  <span style={s.value}>{single.current_time != null ? formatTime(single.current_time) : '—'}</span>
                </div>
                {single.media_type === 'video' && (
                  <div style={{ ...s.metaRow, gridColumn: 1, gridRow: 2 }}>
                    <span style={s.label}>{t('detail.duration')}</span>
                    <span style={s.value}>{single.duration != null ? formatTime(single.duration) : '—'}</span>
                  </div>
                )}
                {single.media_type === 'video' && (
                  <div style={{ ...s.metaRow, gridColumn: 2, gridRow: 2 }}>
                    <span style={s.label}>{t('detail.fps')}</span>
                    <span style={{ ...s.value, whiteSpace: 'nowrap' }}>
                      {single.fps != null ? `${formatFps(single.fps)}fps` : '—'}
                    </span>
                    {/* 撮り逃したコマがある場合だけ添える。0 枚なら何も出さない（大半はこちら）。
                        絵の変わり目に当たるとコマ打ちの数を誤るため、黙って隠さない。
                        割合が大きいときだけ色を付けて、数え直しが要ることを示す。 */}
                    {uncapturedNote && (
                      <span
                        title={'title' in uncapturedNote ? uncapturedNote.title : undefined}
                        style={{ ...s.value, fontSize: 11, whiteSpace: 'nowrap', color: uncapturedNote.severe ? 'var(--warning)' : 'var(--text-muted)' }}>
                        {uncapturedNote.text}
                      </span>
                    )}
                    {/* 通知そのものが来なかったコマ。上の割合の分母にすら入っていないので、
                        撮り逃しが 0 でも出ることがある。常に警告色にする——「数え直せば済む」
                        ではなく「その区間は素材と対応していない」という意味なので。 */}
                    {unreportedNote && (
                      <span
                        title={unreportedNote.title}
                        style={{ ...s.value, fontSize: 11, whiteSpace: 'nowrap', color: 'var(--warning)' }}>
                        {unreportedNote.text}
                      </span>
                    )}
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
                <span style={s.label}>{t('detail.memo')}</span>
                {memoStatus !== 'idle' && (
                  <span style={{ ...s.memoStatus, ...(memoStatus === 'error' ? s.memoStatusError : {}) }}>
                    {t(memoStatus === 'dirty' ? 'detail.memoUnsaved' : memoStatus === 'saving' ? 'detail.memoSaving' : memoStatus === 'saved' ? 'detail.memoSaved' : 'detail.memoSaveFailed')}
                  </span>
                )}
              </div>
              <textarea
                style={s.memoInput}
                value={memoDraft}
                placeholder={t('detail.memoPlaceholder')}
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
                  <span style={s.subtleLabel}>{t('detail.site')}</span>
                  <button style={s.subtleUrlBadge} onClick={() => window.api.openUrl(single.url!)} title={single.url}>
                    {siteName(single.url)}
                    <ExternalLinkIcon size={11} />
                  </button>
                </div>
              )}
              <div style={s.subtleRow}>
                <span style={s.subtleLabel}>{t('detail.capturedAt')}</span>
                <span style={s.subtleValue}>{new Date(single.captured_at).toLocaleString(locale)}</span>
              </div>
            </div>
          </div>
          </div>
          <div style={s.actions}>
            {getMediaActions(single)}
            <button style={s.showInFolderBtn} onClick={onExport}>{t('action.export')}</button>
            <button style={s.deleteActionBtn} onClick={onDelete}>{t('action.delete')}</button>
          </div>
        </>
      ) : selectedIds.size === 0 ? (
        <div style={s.empty}>
          <div style={s.emptyTitle}>{t('detail.emptyTitle')}</div>
          <div style={s.emptyHints}>
            <div>{t('detail.emptyHint1')}</div>
            <div>{t('detail.emptyHint2')}</div>
            <div>{t('detail.emptyHint3')}</div>
          </div>
        </div>
      ) : (
        <>
        <div style={s.panelContent}>
        <div style={s.multi}>
          <div style={s.multiHeader}>
            <div style={s.multiCount}>{tp('detail.selectedCount', selectedIds.size)}</div>
            <button style={s.multiClearBtn} onClick={onClearSelection}>{t('action.clear')}</button>
          </div>
          <div style={s.tagSection}>
            <div style={s.tagLabel}>{t('detail.bulkTags')}</div>
            <div style={s.tagList}>
              {[...bulkTagMap.entries()]
                .sort(sortBulkTags)
                .map(([name, entry]) => {
                  const partial = entry.coverage === 'some'
                  const base = entry.source === 'ai' ? commonStyles.tagChipAi : commonStyles.tagChipManual
                  return (
                    <span key={name}
                      style={{ ...base, ...(partial ? s.tagChipPartialMod : {}), cursor: partial ? 'pointer' : 'default' }}
                      title={t(entry.source === 'ai' ? 'tag.kindAi' : 'tag.kindManual') + (partial ? t('detail.partialTagHint') : '') + t('tag.rightClickToDelete')}
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
                  items={[{ label: t('tag.deleteNamed', { tag: bulkTagCtxMenu.tag }), danger: true, onClick: () => bulkRemoveTag(bulkTagCtxMenu.tag) }]}
                  onClose={() => setBulkTagCtxMenu(null)}
                />
              )}
              {bulkTagInputOpen ? (
                <TagSuggestInput
                  inputRef={bulkInputRef}
                  value={bulkTagInput}
                  onChange={setBulkTagInput}
                  suggestions={bulkSuggestions}
                  placeholder={t('detail.bulkTagPlaceholder')}
                  onConfirm={handleBulkConfirm}
                  onCancel={handleBulkCancel}
                />
              ) : (
                <button style={commonStyles.addTagChip} onClick={openBulkTagInput}>{t('tag.addChip')}</button>
              )}
            </div>
          </div>
        </div>
        </div>
        <div style={s.actions}>
          <button style={s.showInFolderBtn} onClick={onExport}>{t('action.export')}</button>
          <button style={s.deleteActionBtn} onClick={onDelete}>{t('action.delete')}</button>
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
  // scrollbar-gutter: stable — スクロールバーの有無でコンテンツ幅が変わると、
  // 画像(短い→バー無し)と動画(バー分長い→スクロールバー出現)で calc(100%-20px) の基準が
  // ズレて右端が合わなくなる。gutter を常に確保して幅を一定にし、画像/動画を厳密に揃える。
  panelContent: { flex: 1, overflowY: 'auto' as const, scrollbarGutter: 'stable' as const },
  searchTile: { padding: '8px 16px 16px', background: 'var(--bg-page)', display: 'flex', flexDirection: 'column' as const, gap: 16 },
  actions: { padding: '16px 12px', borderTop: '1px solid var(--border-default)', background: 'var(--bg-page)', display: 'flex', flexDirection: 'column' as const, gap: 10, flexShrink: 0 },
  empty: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, padding: '0 20px', textAlign: 'center' as const },
  emptyTitle: { color: 'var(--text-secondary)', fontSize: font.base, fontWeight: 700 },
  emptyHints: { display: 'flex', flexDirection: 'column' as const, gap: 5, color: 'var(--text-secondary)', fontSize: font.sm, lineHeight: 1.6 },
  // シークバーが映像内のオーバーレイになったので、動画と画像は外形が完全に一致する。
  // 以前ここにあった marginBottom: VC_BAR_HEIGHT（バー分の辻褄合わせ）は不要になった。
  img: { width: 'calc(100% - 20px)', margin: '10px 10px 0', borderRadius: 4, aspectRatio: '16 / 9', objectFit: 'contain' as const, background: 'var(--bg-surface)', border: '1px solid var(--border-default)', display: 'block', flexShrink: 0 },
  // aspectRatio は img と同じく「枠を持つ外側のボックス」に持たせること。以前は内側の
  // videoEl 側に持たせていたため、img が w×9/16（border-box＝枠込みで16:9）なのに対し
  // 動画は (w-2)×9/16＋枠2px となり、外形の高さが約1px ずれてタイトル以降の位置も
  // 画像と揃わなかった。videoEl は height:100% で外形に従わせる。
  videoWrap: { width: 'calc(100% - 20px)', margin: '10px 10px 0', borderRadius: 4, aspectRatio: '16 / 9', background: 'var(--bg-surface)', border: '1px solid var(--border-default)', overflow: 'hidden', display: 'block', flexShrink: 0 },
  videoEl: { width: '100%', height: '100%', objectFit: 'contain' as const, display: 'block' },
  meta: { padding: '14px 16px 8px', display: 'flex', flexDirection: 'column', gap: 8 },
  titleRow: { display: 'flex', flexDirection: 'column', gap: 5 },
  titleDisplayRow: { display: 'flex', alignItems: 'flex-start', gap: 6, borderBottom: '1px solid var(--border-default)', paddingBottom: 8 },
  // 動画時刻・長さ・フレームレートを並べる箱。列間（項目の分離）は広めに、行間は
  // タイトなままにする（rowGap を columnGap と同じにすると動画時刻の段だけ縦に間延びして見える）。
  metaHalf: { display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 32, rowGap: 8, alignItems: 'start', padding: '2px 0 3px' },
  // 値は右端に揃える（tabular-nums と合わせて桁が縦に揃う）。左寄せでラベルに隣接させると
  // 値の開始位置がラベルの文字数に左右され、項目ごとに揃わなくなる。
  // ペアの分離は距離ではなく metaHalf の列間で取ること。
  metaRow: { display: 'flex', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
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
