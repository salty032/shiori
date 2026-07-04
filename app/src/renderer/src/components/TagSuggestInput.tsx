import type { RefObject } from 'react'
import { font, radius } from '../styles'
import { useTagSuggest } from '../hooks/useTagSuggest'
import { MAX_TAG_LENGTH } from '../utils'

type Props = {
  value: string
  onChange: (value: string) => void
  suggestions: string[]
  placeholder: string
  // 確定（Enter・+ボタン・候補クリック）。ハイライト中候補があればそれ、なければ入力値そのまま。
  onConfirm: (value: string) => void
  // Escape。入力欄を閉じる／クリアする側の後始末は呼び出し元に委ねる。
  onCancel: () => void
  inputRef?: RefObject<HTMLInputElement | null>
  autoFocus?: boolean
}

// タグ追加の input + 候補リスト + キーボード制御（C-3）。TagEditor と DetailPanel の
// 一括編集で内容がほぼ同一だった実装を1つに集約し、キーボード契約を統一する
// （初期ハイライト=先頭、↑↓ループ、Enter=ハイライト確定/なければ入力値）。
export default function TagSuggestInput({ value, onChange, suggestions, placeholder, onConfirm, onCancel, inputRef, autoFocus }: Props) {
  const { highlightedIndex, setHighlightedIndex, moveHighlight, resolveConfirmValue } = useTagSuggest(suggestions)

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape') { onCancel(); return }
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveHighlight('down'); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveHighlight('up'); return }
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    onConfirm(resolveConfirmValue(value))
  }

  function handleAddClick(): void {
    onConfirm(resolveConfirmValue(value))
  }

  return (
    <span style={{ ...s.tagInputRow, position: 'relative' }}>
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        style={s.tagInput}
        placeholder={placeholder}
        value={value}
        maxLength={MAX_TAG_LENGTH}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setHighlightedIndex(-1), 100)}
      />
      <button style={s.tagAddBtn} onClick={handleAddClick} disabled={!value.trim()} title="追加 (Enter)">+</button>
      {suggestions.length > 0 && (
        <div style={s.suggestions}>
          {suggestions.map((t, i) => (
            <div key={t} className="shiori-menu-item" style={{ ...s.suggestion, background: i === highlightedIndex ? '#272c3a' : 'transparent' }}
              onMouseDown={(e) => { e.preventDefault(); onConfirm(t) }}>
              {t}
            </div>
          ))}
        </div>
      )}
    </span>
  )
}

const s: Record<string, React.CSSProperties> = {
  tagInputRow: { height: 28, display: 'inline-flex', alignItems: 'center', gap: 6, flex: '1 1 180px', minWidth: 160, maxWidth: '100%' },
  tagInput: { flex: 1, minWidth: 0, height: 28, background: '#171a23', border: '1px solid #2b3243', borderRadius: 4, color: '#dce3f2', padding: '0 9px', fontSize: font.base, outline: 'none', boxSizing: 'border-box' as const },
  tagAddBtn: { width: 30, height: 28, padding: 0, background: 'rgba(34,197,145,0.12)', border: '1px solid rgba(34,197,145,0.42)', borderRadius: 4, color: '#54d6a8', cursor: 'pointer', fontSize: 16, lineHeight: 1, flexShrink: 0 },
  suggestions: { position: 'absolute' as const, top: '100%', left: 0, right: 28, background: '#171a23', border: '1px solid #2b3243', borderRadius: radius.sm, zIndex: 100, marginTop: 4, maxHeight: 180, overflowY: 'auto' as const, boxShadow: '0 18px 40px rgba(0,0,0,0.42)', padding: 4 },
  suggestion: { padding: '6px 8px', fontSize: font.sm, color: '#dce3f2', cursor: 'pointer', borderRadius: 2 },
}
