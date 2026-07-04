import { useEffect, useState } from 'react'

// タグ入力の候補ハイライト挙動（C-3）。TagEditor/DetailPanel一括編集/QuickTagInput の
// 3実装でバラバラだった ↑↓ の端の挙動・初期ハイライトを QuickTagInput 方式
// （初期ハイライト=先頭、↑↓ループ）に統一する。suggestions が変わるたび
// （文字入力・確定後のクリアを含む）先頭 or 未選択へ揃える。
export function useTagSuggest(suggestions: string[]) {
  const [highlightedIndex, setHighlightedIndex] = useState(suggestions.length > 0 ? 0 : -1)

  useEffect(() => {
    setHighlightedIndex(suggestions.length > 0 ? 0 : -1)
  }, [suggestions])

  function moveHighlight(direction: 'up' | 'down'): void {
    if (suggestions.length === 0) return
    setHighlightedIndex((i) => {
      if (direction === 'down') return (i + 1) % suggestions.length
      return i <= 0 ? suggestions.length - 1 : i - 1
    })
  }

  // Enter確定時にどの値を使うか（ハイライト中の候補、なければ入力値そのまま）を返す。
  function resolveConfirmValue(rawInput: string): string {
    return highlightedIndex >= 0 ? suggestions[highlightedIndex] : rawInput
  }

  return { highlightedIndex, setHighlightedIndex, moveHighlight, resolveConfirmValue }
}
