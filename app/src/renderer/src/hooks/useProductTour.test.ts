// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useProductTour, type UseProductTourOptions } from './useProductTour'

vi.mock('../i18n', () => ({ t: (key: string) => key }))

// 使い方ガイドを最初から最後まで通す。段は id で指していて、並びは ProductTour.tsx の配列だけが
// 決める。段を足す・並べ替えたときに、進む条件と表示の段が食い違わないことを見る。
describe('useProductTour', () => {
  it('実際の操作で進む段と「次へ」で進む段を順に通り、最後で終わる', () => {
    const showToast = vi.fn()
    const base: UseProductTourOptions = {
      images: [], newIds: new Set(), selectedCount: 0, viewerIdx: null, viewMode: 'grid',
      showToast, resetForTour: vi.fn(),
    }
    const { result, rerender } = renderHook((opts: UseProductTourOptions) => useProductTour(opts), { initialProps: base })

    act(() => result.current.startProductTour())
    expect(result.current.productTourStep).toBe('select')

    rerender({ ...base, selectedCount: 1 })
    expect(result.current.productTourStep).toBe('open')

    rerender({ ...base, selectedCount: 1, viewerIdx: 0 })
    expect(result.current.productTourStep).toBe('viewer')

    rerender({ ...base, selectedCount: 1, viewerIdx: null })
    expect(result.current.productTourStep).toBe('memo')

    // メモ欄は触ったら次へ（ProductTour が onAdvance を呼ぶ）
    act(() => result.current.advanceProductTour())
    expect(result.current.productTourStep).toBe('timeline')

    rerender({ ...base, selectedCount: 1, viewMode: 'timeline' })
    expect(result.current.productTourStep).toBe('search')

    act(() => result.current.advanceProductTour())
    expect(result.current.productTourStep).toBeNull()
    expect(showToast).toHaveBeenCalledWith('tour.completed', 'success')
  })
})
