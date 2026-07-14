import { useState, useEffect, useMemo, useRef } from 'react'
import type { ImageTag } from '../types'
import { s, font, color } from '../styles'
import { normalizeTag, tagSuggestions } from '../utils'
import ContextMenu from './ContextMenu'
import TagSuggestInput from './TagSuggestInput'

const TAG_LIST_COLLAPSED_MAX_HEIGHT = 177

type Props = {
  imageId: number
  allTags: string[]
  taggerDoneKey: number
  onTagsChanged: () => void
  // 指定すると各タグチップがクリック可能になり絞り込みに使う（DetailPanel向け）。
  // ビューア側では現在の一覧を裏で変えたくないため渡さない。
  onFilterByTag?: (tag: string) => void
}

// 単一画像のタグ表示・追加・削除。DetailPanel とビューア内タグパネルの両方から使う共通部品（S7-2/P1）。
export default function TagEditor({ imageId, allTags, taggerDoneKey, onTagsChanged, onFilterByTag }: Props) {
  const [tags, setTags] = useState<ImageTag[]>([])
  const [tagInput, setTagInput] = useState('')
  const [tagInputOpen, setTagInputOpen] = useState(false)
  const [tagError, setTagError] = useState<string | null>(null)
  const [tagCtxMenu, setTagCtxMenu] = useState<{ x: number; y: number; tag: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 画像が変わったら入力状態をリセットする（タグ再取得とは分離。理由は DetailPanel と同じ）。
  useEffect(() => {
    setTagInput('')
    setTagInputOpen(false)
  }, [imageId])

  useEffect(() => {
    let canceled = false
    window.api.taggerGetTags(imageId)
      .then((next) => { if (!canceled) setTags(next) })
      .catch((err) => { if (!canceled) console.error('[tags] getTags failed', err) })
    return () => { canceled = true }
  }, [imageId, taggerDoneKey])

  const suggestions = useMemo(() => {
    return tagSuggestions(tagInput, allTags, (tag) => !tags.some((x) => x.name === tag))
  }, [allTags, tagInput, tags])

  function openTagInput(): void {
    setTagInputOpen(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  async function addTag(name: string): Promise<void> {
    const trimmed = normalizeTag(name)
    if (!trimmed || tags.some(t => t.name === trimmed)) return
    try {
      setTagError(null)
      await window.api.taggerAddTag(imageId, trimmed, 'manual')
      setTags(prev => [...prev, { name: trimmed, source: 'manual' }])
      setTagInputOpen(false)
      onTagsChanged()
    } catch (err) {
      console.error('[tag] addTag failed', err)
      setTagError('タグの追加に失敗しました')
      setTimeout(() => setTagError(null), 3000)
    }
  }

  async function removeTag(name: string): Promise<void> {
    try {
      await window.api.taggerRemoveTag(imageId, name)
      setTags(prev => prev.filter(t => t.name !== name))
      onTagsChanged()
    } catch (err) {
      console.error('[tag] removeTag failed', err)
    }
  }

  function handleConfirm(val: string): void {
    setTagInput('')
    addTag(val)
  }

  function handleCancel(): void {
    setTagInput('')
    setTagInputOpen(false)
  }

  return (
    <div style={styles.tagSection}>
      <div style={{ ...styles.tagLabel, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>タグ</span>
        <span style={styles.tagLegend}><span style={{ color: 'var(--success)' }}>●</span> 手動　<span style={{ color: 'var(--accent-text)' }}>●</span> AI</span>
      </div>
      <div className="shiori-tag-list" style={styles.tagList}>
        {[...tags].sort((a, b) => a.source === b.source ? 0 : a.source === 'manual' ? -1 : 1).map(tag => (
          <span key={tag.name} style={{ ...(tag.source === 'ai' ? s.tagChipAi : s.tagChipManual), cursor: onFilterByTag ? 'pointer' : 'default' }}
            title={(onFilterByTag ? 'クリックで絞り込み / 絞り込み中なら解除' : '') + '（右クリックで削除）'}
            onClick={() => onFilterByTag?.(tag.name)}
            onContextMenu={(e) => { e.preventDefault(); setTagCtxMenu({ x: e.clientX, y: e.clientY, tag: tag.name }) }}>
            {tag.name}
          </span>
        ))}
      </div>
      {tagCtxMenu && (
        <ContextMenu
          x={tagCtxMenu.x}
          y={tagCtxMenu.y}
          items={[
            { label: `タグ「${tagCtxMenu.tag}」を削除`, danger: true, onClick: () => removeTag(tagCtxMenu.tag) },
          ]}
          onClose={() => setTagCtxMenu(null)}
        />
      )}
      <div style={styles.tagControlRow}>
        {tagInputOpen ? (
          <TagSuggestInput
            inputRef={inputRef}
            value={tagInput}
            onChange={setTagInput}
            suggestions={suggestions}
            placeholder="タグを追加..."
            onConfirm={handleConfirm}
            onCancel={handleCancel}
          />
        ) : (
          <button style={s.addTagChip} onClick={openTagInput}>+ タグ</button>
        )}
      </div>
      {tagError && <div style={styles.tagError}>{tagError}</div>}
    </div>
  )
}

// タグチップ／追加ボタンは DetailPanel 一括編集と共通のため styles.ts の共通 s へ集約済み（C-2）。
// ここに残すのはこのコンポーネント固有のレイアウト・AIタグ配色のみ。
const styles: Record<string, React.CSSProperties> = {
  tagSection: { display: 'flex', flexDirection: 'column', gap: 8 },
  tagLabel: { color: 'var(--text-muted)', fontSize: font.xs, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 800 },
  tagLegend: { fontSize: font.xs, color: 'var(--text-secondary)', fontWeight: 400, letterSpacing: 0 },
  tagList: { display: 'flex', flexWrap: 'wrap', gap: 7, minHeight: 4, maxHeight: TAG_LIST_COLLAPSED_MAX_HEIGHT, overflowY: 'auto' as const, overflowX: 'hidden' as const },
  tagControlRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 7, minHeight: 28 },
  tagError: { color: color.danger, fontSize: font.sm },
}
