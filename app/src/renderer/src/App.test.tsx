// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi } from './demo/mockApi'
import { useImageStore } from './stores/imageStore'
import { useFilterStore } from './stores/filterStore'
import App from './App'

vi.mock('./demoMode', () => ({ isDemoMode: () => false, markDemoMode: () => {} }))
vi.mock('./components/SetupGuideModal', () => ({ default: () => <div data-testid="setup-guide" /> }))

describe('初回案内の表示条件', () => {
  beforeEach(async () => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })))
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
    useFilterStore.setState({ searchInput: '', committedSearch: '', tagFilters: [], sortOrder: 'date_desc' })
    useImageStore.setState({ gridImages: [], gridTotalCount: null, gridLoading: false,
      gridReloading: false, gridLoadFailed: false, timelineImages: [], newIds: new Set() })
    await installMockApi()
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('取得が成功してライブラリが空と確定したときだけ開く', async () => {
    const ui = render(<App />)
    await waitFor(() => expect(ui.queryByTestId('setup-guide')).not.toBeNull())
  })

  it('一覧取得が失敗した場合は、件数が0でも開かない', async () => {
    window.api.listImages = vi.fn(async () => { throw new Error('DB unavailable') })
    const ui = render(<App />)
    await waitFor(() => expect(useImageStore.getState().gridLoadFailed).toBe(true))
    expect(ui.queryByTestId('setup-guide')).toBeNull()
  })

  it('検索結果が0件の場合は開かない', async () => {
    useFilterStore.setState({ searchInput: 'no match', committedSearch: 'no match' })
    const ui = render(<App />)
    await waitFor(() => expect(useImageStore.getState().gridTotalCount).toBe(0))
    expect(ui.queryByTestId('setup-guide')).toBeNull()
  })

  it('全件数の取得が失敗して空と確定できない場合は開かない', async () => {
    window.api.countImages = vi.fn(async () => { throw new Error('Count unavailable') })
    const ui = render(<App />)
    await waitFor(() => expect(useImageStore.getState().gridReloading).toBe(false))
    expect(useImageStore.getState().gridTotalCount).toBeNull()
    expect(ui.queryByTestId('setup-guide')).toBeNull()
  })
})
