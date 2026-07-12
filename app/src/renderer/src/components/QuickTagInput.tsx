import { useEffect, useMemo, useRef, useState } from 'react'
import { font, radius } from '../styles'
import { normalizeTag, tagSuggestions, fetchBulkTagFrequency, addTagToImages, MAX_TAG_LENGTH } from '../utils'
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

  const { highlightedIndex: suggestionIdx, moveHighlight, resolveConfirmValue } = useTagSuggest(suggestions)

  async function addTag(raw: string): Promise<void> {
    const tag = normalizeTag(raw)
    if (!tag || saving || imageIds.length === 0) return
    setSaving(true)
    try {
      await addTagToImages(imageIds, tag)
      onTagged(tag, imageIds.length)
      onClose()
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
    addTag(resolveConfirmValue(input))
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
        {suggestions.length > 0 && (
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
        )}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed' as const, inset: 0, zIndex: 6100, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '18vh', background: 'rgba(3,5,10,0.18)' },
  panel: { width: 360, maxWidth: 'calc(100vw - 40px)', background: '#11141c', border: '1px solid #2b3243', borderRadius: radius.md, boxShadow: '0 22px 60px rgba(0,0,0,0.58)', padding: 10 },
  header: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, padding: '2px 2px 8px' },
  title: { color: '#e7ebf5', fontSize: font.sm, fontWeight: 800 },
  target: { minWidth: 0, color: '#7d879d', fontSize: font.xs, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  input: { width: '100%', height: 36, boxSizing: 'border-box' as const, background: '#171a23', border: '1px solid #3b4355', borderRadius: radius.md, color: '#e7ebf5', padding: '0 11px', fontSize: font.base, outline: 'none' },
  suggestions: { marginTop: 6, maxHeight: 220, overflowY: 'auto' as const, display: 'flex', flexDirection: 'column' as const, gap: 2 },
  suggestion: { width: '100%', minHeight: 28, padding: '5px 9px', border: 'none', borderRadius: radius.sm, background: 'transparent', color: '#c4ccdc', cursor: 'pointer', textAlign: 'left' as const, fontSize: font.sm },
  suggestionActive: { background: 'rgba(91,112,255,0.18)', color: '#aeb8ff' },
}
