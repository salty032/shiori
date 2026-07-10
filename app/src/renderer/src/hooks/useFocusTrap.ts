import { useEffect } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(', ')

// モーダル表示中、Tab/Shift+Tab によるフォーカス移動をコンテナ内の focusable 要素だけで
// ループさせる（U-4）。SettingsModal/QuickTagInput は独自の keydown ハンドラで window への
// キーイベント伝搬は遮断しているが、Tab によるフォーカス移動自体はブラウザのネイティブ動作
// なので防げず、モーダル背後のグリッド/サイドバーへフォーカスが抜けてしまっていた。
// role="dialog" aria-modal="true" と組み合わせて使う想定。ライブラリ不要の最小実装。
export function useFocusTrap(containerRef: React.RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Tab') return
      const focusables = Array.from(container!.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((el) => el.offsetParent !== null)
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const current = document.activeElement
      const isInside = current instanceof Node && container!.contains(current)
      if (e.shiftKey) {
        if (!isInside || current === first) { e.preventDefault(); last.focus() }
      } else {
        if (!isInside || current === last) { e.preventDefault(); first.focus() }
      }
    }

    container.addEventListener('keydown', handleKeyDown)
    return () => container.removeEventListener('keydown', handleKeyDown)
  }, [containerRef, active])
}
