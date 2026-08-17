import { useState } from 'react'

type Options = {
  storageKey: string
  min: number
  max: number
  defaultWidth: number
  // ハンドルをどちら向きにドラッグすると広がるか。Sidebar は右端のハンドルを右へ、
  // DetailPanel は左端のハンドルを左へドラッグすると広がる（C-6）。
  direction: 'left' | 'right'
  // 今のウィンドウで出してよい上限（layout.ts の panelLimits）。max より優先して効く。
  // **保存済みの幅は書き換えない**——狭い窓で一時的に縮めて見せるだけなので、
  // 窓を広げ直せば元の幅に戻る。省略時は max がそのまま上限。
  limit?: number
}

// Sidebar/DetailPanel で個別に持っていたパネルリサイズ処理（pointermove/pointerup を
// window にぶら下げ、clamp して localStorage 保存）を共通化。ウィンドウ外へドラッグしても
// 取りこぼさないよう setPointerCapture も併せて統一する（従来はどちらも未使用だった）。
export function usePanelResize({ storageKey, min, max, defaultWidth, direction, limit }: Options) {
  // 好みの幅（localStorage に載る値）。ウィンドウの狭さでは変わらない。
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(storageKey)
    return saved ? Math.min(max, Math.max(min, Number(saved))) : defaultWidth
  })

  // 実際に描く幅。min は必ず下回らせない（上限が min より小さくても潰さない）。
  const effectiveMax = Math.max(min, Math.min(max, limit ?? max))
  const effectiveWidth = Math.min(Math.max(width, min), effectiveMax)

  function handleResizeStart(e: React.PointerEvent): void {
    e.preventDefault()
    const captureEl = e.currentTarget
    const pointerId = e.pointerId
    captureEl.setPointerCapture(pointerId)
    const startX = e.clientX
    // 掴んだ瞬間の見た目の幅から動かす。好みの幅（width）を起点にすると、
    // 上限で縮められている状態では掴んだ端がポインタから離れて飛ぶ。
    const startWidth = effectiveWidth
    let finalWidth = startWidth

    const onMove = (ev: PointerEvent): void => {
      const delta = direction === 'right' ? ev.clientX - startX : startX - ev.clientX
      finalWidth = Math.min(effectiveMax, Math.max(min, startWidth + delta))
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

  return { width: effectiveWidth, handleResizeStart }
}
