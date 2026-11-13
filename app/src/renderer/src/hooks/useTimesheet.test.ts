// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeTimesheet } from '../../../shared/timesheet'
import { useTimesheet } from './useTimesheet'

// 保存済みのタイムシートを読めていないときに打つと、空の表＋1 件で上書きされる（打鍵は作り直せない）。

const getTimesheet = vi.fn()
const saveTimesheet = vi.fn(async () => {})

beforeEach(() => {
  getTimesheet.mockReset()
  saveTimesheet.mockClear()
  vi.stubGlobal('api', { getTimesheet, saveTimesheet })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  // globals:false のため自動 cleanup が効かない（useToast.test.ts と同じ理由）。
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('保存済みのタイムシートを読めなかったとき', () => {
  it('読めなかったことを返し、打っても保存しない', async () => {
    getTimesheet.mockRejectedValue(new Error('db locked'))
    const { result } = renderHook(() => useTimesheet(1, 24))
    await waitFor(() => expect(result.current.loadFailed).toBe(true))

    act(() => { result.current.setMemo(0, 0, 'memo') })

    expect(saveTimesheet).not.toHaveBeenCalled()
  })

  it('読み終える前に打っても保存しない', async () => {
    getTimesheet.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useTimesheet(1, 24))

    act(() => { result.current.setMemo(0, 0, 'memo') })

    expect(result.current.loadFailed).toBe(false)
    expect(saveTimesheet).not.toHaveBeenCalled()
  })

  it('読めたら、打った内容を保存する', async () => {
    getTimesheet.mockResolvedValue(encodeTimesheet([{ frame: 0, value: '1' }]))
    const { result } = renderHook(() => useTimesheet(1, 24))
    await waitFor(() => expect(result.current.marks).toHaveLength(1))

    act(() => { result.current.setMemo(0, 0, 'memo') })

    expect(saveTimesheet).toHaveBeenCalledTimes(1)
  })
})
