import type { RefObject } from 'react'
import { font, radius, space, control } from '../styles'
import { useTagSuggest } from '../hooks/useTagSuggest'
import { MAX_TAG_LENGTH, tagNormalizePreview } from '../utils'
import { useT } from '../i18n'

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
  const { t } = useT()
  const { highlightedIndex, setHighlightedIndex, moveHighlight, resolveConfirmValue } = useTagSuggest(suggestions)
  // 候補（既存タグ）がある間はそちらを優先させたいので、候補が無いとき（＝新規タグを
  // 作ろうとしているとき）だけ正規化後の見た目を予告する。候補ボックスと同じ absolute
  // 位置を使うため、両方を同時に出すと重なる（UX-4）。
  const normalizePreview = suggestions.length === 0 ? tagNormalizePreview(value) : null

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
      <button style={s.tagAddBtn} onClick={handleAddClick} disabled={!value.trim()} title={t('tag.addHint')}>+</button>
      {suggestions.length > 0 && (
        <div style={s.suggestions}>
          {suggestions.map((t, i) => (
            <div key={t} className="shiori-menu-item" style={{ ...s.suggestion, background: i === highlightedIndex ? 'var(--bg-surface-hover)' : 'transparent' }}
              onMouseDown={(e) => { e.preventDefault(); onConfirm(t) }}>
              {t}
            </div>
          ))}
        </div>
      )}
      {normalizePreview && (
        <div style={s.normalizePreview}>{t('tag.normalizePreview', { tag: normalizePreview })}</div>
      )}
    </span>
  )
}

const s: Record<string, React.CSSProperties> = {
  tagInputRow: { height: control.lg, display: 'inline-flex', alignItems: 'center', gap: space.x4, flex: '1 1 180px', minWidth: 160, maxWidth: '100%' },
  tagInput: { flex: 1, minWidth: 0, height: control.lg, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, color: 'var(--text-primary)', padding: '0 10px', fontSize: font.base, outline: 'none', boxSizing: 'border-box' as const },
  tagAddBtn: { width: 34, height: control.lg, padding: 0, background: 'rgba(var(--success-rgb), 0.12)', border: '1px solid rgba(var(--success-rgb), 0.42)', borderRadius: radius.md, color: 'var(--success)', cursor: 'pointer', fontSize: 16, lineHeight: 1, flexShrink: 0 },
  suggestions: { position: 'absolute' as const, top: '100%', left: 0, right: 28, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, zIndex: 100, marginTop: 4, maxHeight: 180, overflowY: 'auto' as const, boxShadow: '0 18px 40px rgba(var(--scrim-rgb), var(--shadow-popover))', padding: 4 },
  suggestion: { padding: '6px 8px', fontSize: font.sm, color: 'var(--text-primary)', cursor: 'pointer', borderRadius: radius.md },
  normalizePreview: { position: 'absolute' as const, top: 'calc(100% + 4px)', left: 0, fontSize: font.xs, color: 'var(--text-muted)', whiteSpace: 'nowrap' as const, pointerEvents: 'none' as const },
}
