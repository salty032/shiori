// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { markOverlayOpen, useOverlayOpen } from './overlaySignal'
import { renderHook, act } from '@testing-library/react'

describe('オーバーレイの合図', () => {
  it('閉じ際に次が開いて重なっても、先に閉じた方が「閉じた」で書き潰さない', () => {
    const { result } = renderHook(() => useOverlayOpen())
    expect(result.current).toBe(false)

    let closeA = (): void => {}
    let closeB = (): void => {}
    act(() => { closeA = markOverlayOpen() })
    expect(result.current).toBe(true)

    // 次のオーバーレイが開いてから、前のが閉じる（並びが逆転する瞬間）
    act(() => { closeB = markOverlayOpen() })
    act(() => { closeA() })
    expect(result.current).toBe(true)

    act(() => { closeB() })
    expect(result.current).toBe(false)
  })

  it('同じ閉じ口を二度呼んでも数が減りすぎない', () => {
    const { result } = renderHook(() => useOverlayOpen())
    let close = (): void => {}
    act(() => { close = markOverlayOpen() })
    act(() => { close(); close() })
    expect(result.current).toBe(false)

    act(() => { markOverlayOpen() })
    expect(result.current).toBe(true)
  })
})
