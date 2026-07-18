import { useEffect, useMemo, useRef, useState } from 'react'
import { font, radius } from '../styles'
import { normalizeTag, tagSuggestions, tagNormalizePreview, fetchBulkTagFrequency, addTagToImages, MAX_TAG_LENGTH } from '../utils'
import { useTagSuggest } from '../hooks/useTagSuggest'
import { useFocusTrap } from '../hooks/useFocusTrap'

type Props = {
  imageIds: number[]
  allTags: string[]
  targetLabel: string
  onClose: () => void
  onTagged: (tag: string, count: number) => void
}

export default function QuickTagInput({ imageIds, allTags, targetLabel, onClose, onTagged }: Props) {
  const [input, setInput] = useState('')
  const [tagsOnAll, setTagsOnAll] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    let canceled = false
    fetchBulkTagFrequency(imageIds)
      .then((freq) => {
        if (canceled) return
        const next = new Set<string>()
        for (const [name, { count }] of freq) if (count === imageIds.length) next.add(name)
        setTagsOnAll(next)
      })
      .catch((err) => console.error('[quick-tag] getTagsBulk failed', err))
    return () => { canceled = true }
  }, [imageIds])

  const suggestions = useMemo(() => {
    return tagSuggestions(input, allTags, (tag) => !tagsOnAll.has(tag))
  }, [allTags, input, tagsOnAll])
  // 既存タグの候補がある間はそちらを優先させたいので、候補が無い（＝新規タグを
  // 作ろうとしている）ときだけ正規化後の見た目を予告する（UX-4）。
  const normalizePreview = suggestions.length === 0 ? tagNormalizePreview(input) : null

  const { highlightedIndex: suggestionIdx, moveHighlight, resolveConfirmValue } = useTagSuggest(suggestions)

  async function addTag(raw: string, keepOpen = false): Promise<void> {
    const tag = normalizeTag(raw)
    if (!tag || saving || imageIds.length === 0) return
    setSaving(true)
    try {
      await addTagToImages(imageIds, tag)
      onTagged(tag, imageIds.length)
      if (keepOpen) {
        // Shift+Enter の連続追加: パネルは閉じず次のタグ入力へ。追加した tag は全選択画像に
        // 付いたので tagsOnAll に足すと候補から即座に外れ、二重追加も防げる。
        setTagsOnAll((prev) => new Set(prev).add(tag))
        setInput('')
        setSaving(false)
        // 保存中は input が disabled でフォーカスが外れるため、再レンダー後に戻す。
        requestAnimationFrame(() => inputRef.current?.focus())
      } else {
        onClose()
      }
    } catch (err) {
      console.error('[quick-tag] addTag failed', err)
      setSaving(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (suggestions.length > 0 && e.key === 'ArrowDown') {
      e.preventDefault()
      moveHighlight('down')
      return
    }
    if (suggestions.length > 0 && e.key === 'ArrowUp') {
      e.preventDefault()
      moveHighlight('up')
      return
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    // Shift+Enter は追加してパネルを開いたまま次のタグへ（連続追加）。
    addTag(resolveConfirmValue(input), e.shiftKey)
  }

  return (
    <div style={s.overlay} onMouseDown={onClose} data-keep-selection>
      <div style={s.panel} ref={panelRef} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="quick-tag-title">
        <div style={s.header}>
          <span id="quick-tag-title" style={s.title}>タグを追加</span>
          <span style={s.target}>{targetLabel}</span>
        </div>
        <input
          ref={inputRef}
          style={s.input}
          value={input}
          placeholder="タグ名"
          maxLength={MAX_TAG_LENGTH}
          disabled={saving}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        {suggestions.length > 0 ? (
          <div style={s.suggestions}>
            {suggestions.map((tag, i) => (
              <button
                key={tag}
                className="shiori-menu-item"
                style={{ ...s.suggestion, ...(i === suggestionIdx ? s.suggestionActive : {}) }}
                onMouseDown={(e) => { e.preventDefault(); addTag(tag) }}
              >
                {tag}
              </button>
            ))}
          </div>
        ) : normalizePreview ? (
          <div style={s.normalizePreview}>→ {normalizePreview} として追加されます</div>
        ) : null}
        <div style={s.hint}>Enter で追加 · Shift+Enter で連続追加 · Esc で閉じる</div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed' as const, inset: 0, zIndex: 6100, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '18vh', background: 'rgba(var(--scrim-rgb), 0.18)' },
  panel: { width: 360, maxWidth: 'calc(100vw - 40px)', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, boxShadow: '0 22px 60px rgba(var(--scrim-rgb), 0.58)', padding: 10 },
  header: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, padding: '2px 2px 8px' },
  title: { color: 'var(--text-primary)', fontSize: font.sm, fontWeight: 800 },
  target: { minWidth: 0, color: 'var(--text-muted)', fontSize: font.xs, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  input: { width: '100%', height: 36, boxSizing: 'border-box' as const, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, color: 'var(--text-primary)', padding: '0 11px', fontSize: font.base, outline: 'none' },
  suggestions: { marginTop: 6, maxHeight: 220, overflowY: 'auto' as const, display: 'flex', flexDirection: 'column' as const, gap: 2 },
  suggestion: { width: '100%', minHeight: 28, padding: '5px 9px', border: 'none', borderRadius: radius.sm, background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', textAlign: 'left' as const, fontSize: font.sm },
  suggestionActive: { background: 'rgba(var(--accent-rgb), 0.18)', color: 'var(--accent-text)' },
  normalizePreview: { marginTop: 6, padding: '2px 2px 0', fontSize: font.xs, color: 'var(--text-muted)' },
  hint: { marginTop: 8, padding: '6px 2px 0', borderTop: '1px solid var(--border-default)', fontSize: font.xs, color: 'var(--text-muted)' },
}
