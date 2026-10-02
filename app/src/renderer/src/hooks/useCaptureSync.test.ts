// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ImageRow } from '../types'
import { useImageStore } from '../stores/imageStore'
import { useFilterStore } from '../stores/filterStore'
import { useCaptureSync } from './useCaptureSync'

const old = { id: 1, captured_at: 1000 } as ImageRow
const captured = { id: 2, captured_at: 2000 } as ImageRow
beforeEach(() => {
  vi.useFakeTimers()
  useFilterStore.setState({ committedSearch: '', tagFilters: [], sortOrder: 'date_desc' })
  useImageStore.setState({ gridImages: [old], gridTotalCount: 1, gridReloading: false, newIds: new Set() })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('再読み込み中のキャプチャは再取得へ回し、遅れて届く古い一覧で消さない', async () => {
  let finishOld!: (rows: ImageRow[]) => void
  let emit!: (data: { id: number }) => unknown
  const listImages = vi.fn().mockImplementationOnce(() => new Promise<ImageRow[]>((resolve) => { finishOld = resolve }))
    .mockResolvedValue([captured, old])
  vi.stubGlobal('api', {
    listImages, countImages: vi.fn(async () => 2), getImage: vi.fn(async () => captured),
    onCapture: vi.fn((cb) => { emit = cb; return () => {} }),
  })
  useImageStore.getState().reloadGrid(vi.fn())
  renderHook(() => useCaptureSync({ onLibraryChanged: vi.fn(), showToast: vi.fn(), timelineActive: false }))
  await act(async () => { await emit({ id: 2 }); await vi.advanceTimersByTimeAsync(300) })
  expect(listImages).toHaveBeenCalledTimes(2)
  expect(useImageStore.getState().gridImages.map((row) => row.id)).toEqual([2, 1])
  await act(async () => { finishOld([old]) })
  expect(useImageStore.getState().gridImages.map((row) => row.id)).toEqual([2, 1])
  expect(useImageStore.getState().gridTotalCount).toBe(2)
})

it('件数取得済みの新着通知でも、遅延まとめ処理で件数を確定し直す', async () => {
  let emit!: (data: { id: number }) => unknown
  const countImages = vi.fn(async () => 2)
  vi.stubGlobal('api', {
    countImages, getImage: vi.fn(async () => captured),
    onCapture: vi.fn((cb) => { emit = cb; return () => {} }),
  })
  useImageStore.setState({ gridTotalCount: 2 })
  renderHook(() => useCaptureSync({ onLibraryChanged: vi.fn(), showToast: vi.fn(), timelineActive: false }))
  await act(async () => { await emit({ id: 2 }); await vi.advanceTimersByTimeAsync(300) })
  expect(useImageStore.getState().gridTotalCount).toBe(2)
  expect(countImages).toHaveBeenCalledTimes(1)
})
