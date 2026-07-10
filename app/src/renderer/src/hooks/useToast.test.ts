// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToast } from './useToast'

afterEach(() => {
  // vitest.config.ts は globals:false のため、@testing-library/react の自動 afterEach cleanup が
  // 効かない（useSelection.test.ts と同じ理由）。
  cleanup()
  vi.useRealTimers()
})

describe('showToast の上限押し出し（T-4: useToast.ts withinLimit）', () => {
  it('上限（3件）を超えると、アクション付きより先にアクションなしの最古を押し出す', () => {
    const { result } = renderHook(() => useToast())

    act(() => { result.current.showToast('通常1') })
    act(() => { result.current.showToast('元に戻す付き', 'success', undefined, { label: '元に戻す', onClick: () => {} }) })
    act(() => { result.current.showToast('通常3') })
    act(() => { result.current.showToast('通常4') })

    // 4件目追加で1件押し出される。アクションなしの最古（通常1）が落ち、
    // 順番的にはより古い「元に戻す付き」がアクション有りとして残る。
    expect(result.current.toasts.map((t) => t.message)).toEqual(['元に戻す付き', '通常3', '通常4'])
  })

  it('全件アクション付きなら最古から押し出す', () => {
    const { result } = renderHook(() => useToast())

    act(() => { result.current.showToast('a', 'success', undefined, { label: '元に戻す', onClick: () => {} }) })
    act(() => { result.current.showToast('b', 'success', undefined, { label: '元に戻す', onClick: () => {} }) })
    act(() => { result.current.showToast('c', 'success', undefined, { label: '元に戻す', onClick: () => {} }) })
    act(() => { result.current.showToast('d', 'success', undefined, { label: '元に戻す', onClick: () => {} }) })

    expect(result.current.toasts.map((t) => t.message)).toEqual(['b', 'c', 'd'])
  })

  it('押し出されたトーストの自動消滅タイマーは残らない（再表示や誤発火をしない）', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useToast())

    act(() => { result.current.showToast('通常1', 'info', 1000) })
    act(() => { result.current.showToast('通常2', 'info', 1000) })
    act(() => { result.current.showToast('通常3', 'info', 1000) })
    act(() => { result.current.showToast('通常4', 'info', 1000) })

    expect(result.current.toasts.map((t) => t.message)).toEqual(['通常2', '通常3', '通常4'])

    // 押し出された「通常1」のタイマーが生きていて何かを壊す（例外・想定外の状態変化）ことがない
    act(() => { vi.advanceTimersByTime(1000) })
    expect(result.current.toasts.map((t) => t.message)).toEqual(['通常2', '通常3', '通常4'])
  })
})

describe('showToast/dismissToast のタイマー挙動', () => {
  it('既定の表示時間(4000ms)後にclosingへ、さらにEXIT_MS(300ms)後に配列から消える', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useToast())

    act(() => { result.current.showToast('通知') })
    expect(result.current.toasts).toHaveLength(1)
    expect(result.current.toasts[0].closing).toBe(false)

    act(() => { vi.advanceTimersByTime(4000) })
    expect(result.current.toasts[0].closing).toBe(true)

    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current.toasts).toHaveLength(0)
  })

  it('dismissToastは表示時間を待たずに即座に消滅アニメーションへ入る', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useToast())

    let id = -1
    act(() => { id = result.current.showToast('通知', 'info', 10000) })
    act(() => { result.current.dismissToast(id) })
    expect(result.current.toasts[0].closing).toBe(true)

    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current.toasts).toHaveLength(0)
  })
})

describe('updateToast', () => {
  it('既存idを更新するときは件数を増やさず内容とタイマーだけ差し替える', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useToast())

    let id = -1
    act(() => { id = result.current.showToast('削除中...', 'info', 60000) })
    act(() => { result.current.updateToast(id, '削除しました', 'success') })

    expect(result.current.toasts).toHaveLength(1)
    expect(result.current.toasts[0].message).toBe('削除しました')
    expect(result.current.toasts[0].tone).toBe('success')

    // updateToast は ms 未指定なら既定値(4000ms)でタイマーを張り直す
    act(() => { vi.advanceTimersByTime(4000) })
    expect(result.current.toasts[0].closing).toBe(true)
  })

  it('既に消えたidを更新した場合は新規トーストとして追加する', () => {
    const { result } = renderHook(() => useToast())

    act(() => { result.current.updateToast(999, '復活', 'warning') })
    expect(result.current.toasts.map((t) => t.message)).toEqual(['復活'])
  })
})
