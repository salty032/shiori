// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { SETTINGS_DEFAULTS } from '../../../shared/settingsDefaults'
import DetailPanel from './DetailPanel'

vi.mock('./TagEditor', () => ({ default: () => null }))
vi.mock('../i18n', () => ({ useT: () => ({ t: (key: string) => key, tp: (key: string) => key, locale: 'ja-JP' }) }))

function panelProps(id = 1): ComponentProps<typeof DetailPanel> {
  return {
    selectedIds: new Set([id]),
    single: { id, title: 'title', memo: '', filepath: '/capture.png', captured_at: 1000,
      source: 'capture', current_time: null, url: null, colors: null, media_type: null,
      duration: null, fps: null, width: null, height: null, thumb_path: null },
    settings: SETTINGS_DEFAULTS, taggerDoneKey: 0, allTags: [], viewerOpen: false,
    onTagsChanged: vi.fn(), onTitleChanged: vi.fn(), onMemoChanged: vi.fn(),
    onFilterByTag: vi.fn(), onExport: vi.fn(), onDelete: vi.fn(), onClearSelection: vi.fn(),
  }
}

describe('DetailPanel saves', () => {
  const updateImageMemo = vi.fn()
  const updateImageTitle = vi.fn()
  beforeEach(() => {
    vi.useFakeTimers()
    updateImageMemo.mockReset()
    updateImageTitle.mockReset()
    vi.stubGlobal('api', { updateImageMemo, updateImageTitle })
  })
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

  it('古いメモ保存の完了で、新しい未保存入力を保存済みにしない', async () => {
    let finish!: () => void
    updateImageMemo.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
      .mockResolvedValue(undefined)
    const p = panelProps()
    const ui = render(<DetailPanel {...p} />)
    const memo = ui.getByPlaceholderText('detail.memoPlaceholder')
    fireEvent.change(memo, { target: { value: 'first' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    fireEvent.change(memo, { target: { value: 'second' } })
    await act(async () => { finish() })
    expect(ui.queryByText('detail.memoSaved')).toBeNull()
    expect(ui.getByText('detail.memoUnsaved')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    expect(updateImageMemo.mock.calls).toEqual([[1, 'first'], [1, 'second']])
    expect(ui.getByText('detail.memoSaved')).toBeTruthy()
  })

  it('連続保存は順番に実行し、blurで同じ保存を二重に送らない', async () => {
    let finish!: () => void
    updateImageMemo.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
      .mockResolvedValue(undefined)
    const ui = render(<DetailPanel {...panelProps()} />)
    const memo = ui.getByPlaceholderText('detail.memoPlaceholder')
    fireEvent.change(memo, { target: { value: 'first' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    fireEvent.blur(memo)
    fireEvent.change(memo, { target: { value: 'second' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    expect(updateImageMemo).toHaveBeenCalledTimes(1)
    await act(async () => { finish() })
    expect(updateImageMemo.mock.calls).toEqual([[1, 'first'], [1, 'second']])
  })

  it('保存中に元の文字へ戻した場合も、最後の入力を保存する', async () => {
    let finish!: () => void
    updateImageMemo.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
      .mockResolvedValue(undefined)
    const ui = render(<DetailPanel {...panelProps()} />)
    const memo = ui.getByPlaceholderText('detail.memoPlaceholder')
    fireEvent.change(memo, { target: { value: 'first' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    fireEvent.change(memo, { target: { value: '' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(700); finish() })
    expect(updateImageMemo.mock.calls).toEqual([[1, 'first'], [1, '']])
  })

  it('別の画像に切り替えても、前の画像の保存結果を表示しない', async () => {
    let finish!: () => void
    updateImageMemo.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const p = panelProps()
    const ui = render(<DetailPanel {...p} />)
    fireEvent.change(ui.getByPlaceholderText('detail.memoPlaceholder'), { target: { value: 'first' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    ui.rerender(<DetailPanel {...panelProps(2)} />)
    await act(async () => { finish() })
    expect(ui.queryByText('detail.memoSaved')).toBeNull()
    expect((ui.getByPlaceholderText('detail.memoPlaceholder') as HTMLTextAreaElement).value).toBe('')
    expect(updateImageMemo).toHaveBeenCalledTimes(1)
    expect(p.onMemoChanged).toHaveBeenCalledWith(1, 'first')
  })

  it('タイトル保存失敗は入力を残し、再試行で保存できる', async () => {
    updateImageTitle.mockRejectedValueOnce(new Error('IPC failed')).mockResolvedValue(undefined)
    const p = panelProps()
    const ui = render(<DetailPanel {...p} />)
    fireEvent.click(ui.getByTitle('detail.editTitle'))
    const title = ui.container.querySelector('textarea')!
    fireEvent.change(title, { target: { value: 'changed' } })
    await act(async () => { fireEvent.keyDown(title, { key: 'Enter' }) })
    expect(ui.getByRole('alert').textContent).toBe('detail.titleSaveFailed')
    expect((ui.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('changed')
    await act(async () => { fireEvent.click(ui.getByText('detail.titleRetry')) })
    expect(p.onTitleChanged).toHaveBeenCalledWith(1, 'changed')
    expect(ui.queryByRole('alert')).toBeNull()
  })
})
