import { useState } from 'react'

type Options = {
  storageKey: string
  min: number
  max: number
  defaultWidth: number
  // ハンドルをどちら向きにドラッグすると広がるか。Sidebar は右端のハンドルを右へ、
  // DetailPanel は左端のハンドルを左へドラッグすると広がる（C-6）。
  direction: 'left' | 'right'
}

// Sidebar/DetailPanel で個別に持っていたパネルリサイズ処理（pointermove/pointerup を
// window にぶら下げ、clamp して localStorage 保存）を共通化。ウィンドウ外へドラッグしても
// 取りこぼさないよう setPointerCapture も併せて統一する（従来はどちらも未使用だった）。
export function usePanelResize({ storageKey, min, max, defaultWidth, direction }: Options) {
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(storageKey)
    return saved ? Math.min(max, Math.max(min, Number(saved))) : defaultWidth
  })

  function handleResizeStart(e: React.PointerEvent): void {
    e.preventDefault()
    const captureEl = e.currentTarget
    const pointerId = e.pointerId
    captureEl.setPointerCapture(pointerId)
    const startX = e.clientX
    const startWidth = width
    let finalWidth = startWidth

    const onMove = (ev: PointerEvent): void => {
      const delta = direction === 'right' ? ev.clientX - startX : startX - ev.clientX
      finalWidth = Math.min(max, Math.max(min, startWidth + delta))
      setWidth(finalWidth)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (captureEl.hasPointerCapture(pointerId)) captureEl.releasePointerCapture(pointerId)
      localStorage.setItem(storageKey, String(finalWidth))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return { width, handleResizeStart }
}
