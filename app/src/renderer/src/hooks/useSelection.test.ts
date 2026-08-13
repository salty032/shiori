// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hitTestBox, useSelection, type GridLayout, type UseSelectionOptions } from './useSelection'
import { useFilterStore } from '../stores/filterStore'
import type { RemovedImagesSnapshot } from '../stores/imageStore'
import type { ImageRow, DeleteImageResult } from '../../../shared/types'
import type { ShowToast } from './useToast'

function makeImages(n: number, startId = 1): ImageRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: startId + i,
    filepath: `/cap/${startId + i}.png`,
    captured_at: 1700000000000 + i,
    title: null,
    current_time: null,
    url: null,
    colors: null,
    memo: null,
    media_type: null,
    duration: null,
    fps: null,
    width: null,
    height: null,
    thumb_path: null,
    source: 'capture' as const,
  }))
}

function makeGridLayout(overrides: Partial<GridLayout> = {}): GridLayout {
  return {
    gridRef: { current: null },
    timelineRef: { current: null },
    scrollRef: { current: null },
    columns: 3,
    cellWidth: 100,
    cellHeight: 100,
    rowHeight: 110,
    colGap: 8,
    rowGap: 10,
    ...overrides,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makeApi() {
  return {
    deleteImagesBulk: vi.fn(async (ids: number[]): Promise<DeleteImageResult[]> =>
      ids.map((id) => ({ ok: true, id }))),
    listAllImages: vi.fn(async (): Promise<ImageRow[]> => []),
    countImages: vi.fn(async (): Promise<number> => 0),
    startImageDrag: vi.fn((_ids: number[]): void => {}),
  }
}

// window.api はテスト用に上の最小モックだけを積む（ShioriApi 全体を満たす必要はない）。
function mockApi(): ReturnType<typeof makeApi> {
  return (window as unknown as { api: ReturnType<typeof makeApi> }).api
}

function setup(overrides: Partial<UseSelectionOptions> = {}) {
  const images = overrides.images ?? makeImages(6)
  const showToast = vi.fn(() => 1) as unknown as ShowToast
  const updateToast = vi.fn()
  const dismissToast = vi.fn()
  const removeImages = vi.fn((ids: Set<number>): RemovedImagesSnapshot => ({
    grid: [], timeline: [], gridTotalCount: null, timelineTotalCount: null, removedIds: [...ids],
  }))
  const restoreImages = vi.fn()
  const setViewerId = vi.fn()
  const scrollToIndex = vi.fn()
  const onLibraryChanged = vi.fn()

  const options: UseSelectionOptions = {
    images,
    viewerIdx: null,
    setViewerId,
    showToast,
    updateToast,
    dismissToast,
    gridLayout: makeGridLayout(),
    navigationColumnsRef: { current: 3 },
    scrollToIndex,
    removeImages,
    restoreImages,
    gridActiveRef: { current: true },
    onLibraryChanged,
    ...overrides,
  }

  const { result, unmount } = renderHook((props: UseSelectionOptions) => useSelection(props), { initialProps: options })
  return { result, unmount, images, showToast, updateToast, dismissToast, removeImages, restoreImages, setViewerId, scrollToIndex, onLibraryChanged }
}

beforeEach(() => {
  (window as unknown as { api: ReturnType<typeof makeApi> }).api = makeApi()
  useFilterStore.setState({
    searchInput: '', committedSearch: '', tagFilters: [], tagMode: 'and',
    sortOrder: 'date_desc', activeSmartFolderId: null,
  })
})

afterEach(() => {
  // vitest.config.ts は globals:false のため、@testing-library/react の自動 afterEach cleanup が
  // 効かない。手動で呼ばないと前のテストの renderHook インスタンスが window の
  // keydown/mouseup リスナーを持ったまま残り、後続テストの dispatchEvent が複数回反応する。
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('hitTestBox（矩形選択の当たり判定・pure関数）', () => {
  // columns=3, cellWidth=100, cellHeight=100, rowHeight=110, colGap=8, rowGap=10
  // 列: col0 [0,100) col1 [108,208) col2 [216,316)
  // 行: row0 hitHeight=max(100,110-10)=100 → [0,100) / row1 → [110,210)
  const images = makeImages(6)
  const args = [3, 100, 100, 110, 8, 10] as const

  it('矩形が重なるセルだけを選ぶ', () => {
    const result = hitTestBox(0, 0, 50, 50, images, ...args)
    expect(result).toEqual(new Set([images[0].id]))
  })

  it('列間のギャップ内だけに収まる矩形はどちらの列にもヒットしない', () => {
    const result = hitTestBox(101, 0, 107, 10, images, ...args)
    expect(result.size).toBe(0)
  })

  it('最右列（右端）のヒット判定', () => {
    const result = hitTestBox(310, 0, 320, 10, images, ...args)
    expect(result).toEqual(new Set([images[2].id]))
  })

  it('行間のギャップ内（rowHeight-rowGapの外）はどちらの行にもヒットしない', () => {
    const result = hitTestBox(0, 101, 10, 108, images, ...args)
    expect(result.size).toBe(0)
  })

  it('columns<=0 や cellWidth<=0 なら常に空集合', () => {
    expect(hitTestBox(0, 0, 999, 999, images, 0, 100, 100, 110, 8, 10).size).toBe(0)
    expect(hitTestBox(0, 0, 999, 999, images, 3, 0, 100, 110, 8, 10).size).toBe(0)
  })
})

describe('selectIndex と選択履歴 undo/redo', () => {
  it('selectIndexで単一選択、shiftで範囲選択', () => {
    const { result, images } = setup()
    act(() => result.current.selectIndex(0))
    expect(result.current.selectedIds).toEqual(new Set([images[0].id]))
    act(() => result.current.selectIndex(2, { shift: true }))
    expect(result.current.selectedIds).toEqual(new Set([images[0].id, images[1].id, images[2].id]))
  })

  it('Ctrl+Z/Ctrl+Yで選択の undo/redo ができる', () => {
    const { result, images } = setup()
    act(() => result.current.selectIndex(0))
    act(() => result.current.selectIndex(2))
    expect(result.current.selectedIds).toEqual(new Set([images[2].id]))

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })))
    expect(result.current.selectedIds).toEqual(new Set([images[0].id]))

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true })))
    expect(result.current.selectedIds).toEqual(new Set([images[2].id]))
  })

  it('SELECTION_HISTORY_LIMIT(30)を超えた履歴は古い順に落ちる', () => {
    const { result, images } = setup({ images: makeImages(40) })
    // 34回別々の選択を積む（初回のマウント時クリアの1件は履歴に残らない: 空→空は変化なし）
    for (let i = 0; i < 34; i++) {
      act(() => result.current.selectIndex(i))
    }
    expect(result.current.selectedIds).toEqual(new Set([images[33].id]))
    // 30回 undo できる
    for (let i = 0; i < 30; i++) {
      act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })))
    }
    const afterLimitUndo = result.current.selectedIds
    // これ以上 undo しても変化しない（履歴が尽きている）
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })))
    expect(result.current.selectedIds).toEqual(afterLimitUndo)
  })
})

describe('Ctrl+A（全選択）', () => {
  it('現在のフィルタの全件を取得して選択する', async () => {
    const all = makeImages(5)
    const { result } = setup({ images: makeImages(3) })
    mockApi().listAllImages = vi.fn(async () => all)
    mockApi().countImages = vi.fn(async () => all.length)

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.selectedIds).toEqual(new Set(all.map((i) => i.id)))
  })

  it('表示済みが空なら何もしない', async () => {
    const { result } = setup({ images: [] })
    const listAllImages = vi.fn(async () => makeImages(3))
    mockApi().listAllImages = listAllImages

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))
      await Promise.resolve()
    })

    expect(listAllImages).not.toHaveBeenCalled()
    expect(result.current.selectedIds.size).toBe(0)
  })

  it('B-3回帰: 取得中にフィルタが変わったら古い結果で選択を上書きしない', async () => {
    const { promise: listPromise, resolve: resolveList } = deferred<ImageRow[]>()
    const { promise: countPromise, resolve: resolveCount } = deferred<number>()
    const { result } = setup({ images: makeImages(3) })
    mockApi().listAllImages = vi.fn(() => listPromise)
    mockApi().countImages = vi.fn(() => countPromise)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))
    })

    // 解決を待つ間にフィルタを変更 → filterQueryKey 変化で選択がクリアされる
    act(() => {
      useFilterStore.getState().commitSearch('changed')
    })
    expect(result.current.selectedIds.size).toBe(0)

    // 古いクエリの結果が今ごろ解決する
    await act(async () => {
      resolveList(makeImages(999, 10000))
      resolveCount(999)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    // 新しいフィルタの上に古い選択が復活していないこと
    expect(result.current.selectedIds.size).toBe(0)
  })
})

describe('削除フロー（queueDelete → Undo → 猶予明けコミット）', () => {
  it('queueDeleteは即座にグリッドから外し、猶予後にdeleteImagesBulkを呼ぶ', async () => {
    vi.useFakeTimers()
    const images = makeImages(3)
    const { result, removeImages } = setup({ images })

    act(() => result.current.selectIndex(0))
    act(() => { result.current.deleteSelected() })

    expect(removeImages).toHaveBeenCalledWith(new Set([images[0].id]))
    expect(window.api.deleteImagesBulk).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(4000)

    expect(window.api.deleteImagesBulk).toHaveBeenCalledWith([images[0].id])
  })

  it('猶予中にUndoすればdeleteImagesBulkは呼ばれず、選択が復元される', async () => {
    vi.useFakeTimers()
    const images = makeImages(3)
    const { result, showToast, restoreImages } = setup({ images })

    act(() => result.current.selectIndex(1))
    act(() => { result.current.deleteSelected() })

    const mockShowToast = showToast as unknown as ReturnType<typeof vi.fn>
    const action = mockShowToast.mock.calls[0][3] as { onClick: () => void }
    act(() => action.onClick())

    expect(restoreImages).toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10000)
    expect(window.api.deleteImagesBulk).not.toHaveBeenCalled()
  })

  it('連続削除では前回分が即座にコミットされる（Undoの猶予をすり抜けない）', async () => {
    vi.useFakeTimers()
    const images = makeImages(3)
    const { result } = setup({ images })

    act(() => result.current.selectIndex(0))
    act(() => { result.current.deleteSelected() })
    expect(window.api.deleteImagesBulk).not.toHaveBeenCalled()

    // 猶予が明ける前に2件目を削除 → 1件目は即座にコミットされる
    act(() => result.current.selectIndex(1))
    await act(async () => {
      result.current.deleteSelected()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.deleteImagesBulk).toHaveBeenCalledWith([images[0].id])
  })

  it('削除が確定したらサイドバーの集計を取り直す（消した画像のタグが残らない）', async () => {
    vi.useFakeTimers()
    const images = makeImages(1)
    const { result, onLibraryChanged } = setup({ images })

    act(() => result.current.selectIndex(0))
    act(() => { result.current.deleteSelected() })

    // 猶予中はまだ DB に反映されていないので取り直さない
    expect(onLibraryChanged).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(4000)

    expect(onLibraryChanged).toHaveBeenCalledTimes(1)
  })

  it('猶予中にUndoしたら集計は取り直さない（DBは変わっていない）', async () => {
    vi.useFakeTimers()
    const images = makeImages(3)
    const { result, showToast, onLibraryChanged } = setup({ images })

    act(() => result.current.selectIndex(0))
    act(() => { result.current.deleteSelected() })

    const mockShowToast = showToast as unknown as ReturnType<typeof vi.fn>
    const action = mockShowToast.mock.calls[0][3] as { onClick: () => void }
    act(() => action.onClick())

    await vi.advanceTimersByTimeAsync(10000)
    expect(onLibraryChanged).not.toHaveBeenCalled()
  })

  it('deleteImagesBulkが失敗したら部分復元される（N-3回帰）', async () => {
    const images = makeImages(2)
    const failing = vi.fn().mockRejectedValueOnce(new Error('ipc down'))
    const { result, restoreImages } = setup({ images })
    mockApi().deleteImagesBulk = failing

    act(() => result.current.selectIndex(0))
    act(() => result.current.selectIndex(1, { ctrl: true }))
    act(() => { result.current.deleteSelected() })

    // pagehide はウィンドウ終了時と同じ即時フラッシュ経路（猶予タイマーを待たない）
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(restoreImages).toHaveBeenCalled()
    const lastCall = restoreImages.mock.calls[restoreImages.mock.calls.length - 1]
    expect(lastCall[1]).toEqual(new Set([images[0].id, images[1].id]))
  })
})

// 他アプリへのドラッグ&ドロップ。「押した瞬間に選択を1枚へ畳まない」ことが要で、
// 畳んでしまうと複数選択をまとめて掴めず、最後に押した1枚しか渡らない。
// ビューアの表示対象は位置ではなく id で受け渡す。一覧が丸ごと差し替わる経路
// （削除・Undo・grid⇔timeline切替）を跨いでも同じ画像を指し続けるための土台なので、
// 「どの id を指すよう伝えたか」を固定しておく。
describe('ビューアの表示対象（id 指定）', () => {
  it('openIndex はその位置の画像の id を伝える', () => {
    const images = makeImages(5)
    const { result, setViewerId } = setup({ images })

    act(() => result.current.openIndex(2))

    expect(setViewerId).toHaveBeenCalledWith(images[2].id)
  })

  it('ビューア内 Delete では次の画像の id へ移る', () => {
    vi.useFakeTimers()
    const images = makeImages(5)
    const { result, setViewerId } = setup({ images, viewerIdx: 1 })

    act(() => result.current.deleteViewerImage(images[1].id, 1))

    // 2番目を消したら、その位置に繰り上がってくるのは元の3番目。
    expect(setViewerId).toHaveBeenCalledWith(images[2].id)
  })

  it('末尾をビューア内 Delete したら1つ前の画像へ下がる', () => {
    vi.useFakeTimers()
    const images = makeImages(3)
    const { result, setViewerId } = setup({ images, viewerIdx: 2 })

    act(() => result.current.deleteViewerImage(images[2].id, 2))

    expect(setViewerId).toHaveBeenCalledWith(images[1].id)
  })

  it('最後の1枚をビューア内 Delete したらビューアを閉じる', () => {
    vi.useFakeTimers()
    const images = makeImages(1)
    const { result, setViewerId } = setup({ images, viewerIdx: 0 })

    act(() => result.current.deleteViewerImage(images[0].id, 0))

    expect(setViewerId).toHaveBeenCalledWith(null)
  })

  it('ビューア内削除を Undo したら削除した画像へ戻る', () => {
    vi.useFakeTimers()
    const images = makeImages(5)
    const { result, showToast, setViewerId } = setup({ images, viewerIdx: 1 })

    act(() => result.current.deleteViewerImage(images[1].id, 1))

    const mockShowToast = showToast as unknown as ReturnType<typeof vi.fn>
    const action = mockShowToast.mock.calls[0][3] as { onClick: () => void }
    act(() => action.onClick())

    expect(setViewerId).toHaveBeenLastCalledWith(images[1].id)
  })

  it('ビューアを閉じた後に Undo しても勝手に開き直さない', () => {
    vi.useFakeTimers()
    const images = makeImages(5)
    // viewerIdx: null = 既に閉じている状態
    const { result, showToast, setViewerId } = setup({ images, viewerIdx: null })

    act(() => result.current.deleteViewerImage(images[1].id, 1))
    setViewerId.mockClear()

    const mockShowToast = showToast as unknown as ReturnType<typeof vi.fn>
    const action = mockShowToast.mock.calls[0][3] as { onClick: () => void }
    act(() => action.onClick())

    expect(setViewerId).not.toHaveBeenCalled()
  })
})

describe('サムネからの他アプリへのドラッグ', () => {
  // handleGridMouseDown は選択領域の判定に gridRef/scrollRef の矩形を使う。jsdom の
  // getBoundingClientRect は全て 0 を返すため、座標 0 で押せば領域内と判定される。
  function setupDrag() {
    const images = makeImages(6)
    const gridRef = { current: document.createElement('div') }
    const scrollRef = { current: document.createElement('div') }
    const env = setup({ images, gridLayout: makeGridLayout({ gridRef, scrollRef }) })
    return { ...env, images }
  }

  function mouseDownOnThumb(
    result: ReturnType<typeof setupDrag>['result'],
    id: number,
    modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {},
  ): void {
    const thumb = document.createElement('div')
    thumb.setAttribute('data-img-id', String(id))
    document.body.appendChild(thumb)
    act(() => result.current.handleGridMouseDown({
      button: 0, clientX: 0, clientY: 0, target: thumb,
      shiftKey: false, ctrlKey: false, metaKey: false, ...modifiers,
      preventDefault: () => {},
    } as unknown as React.MouseEvent<HTMLDivElement>))
  }

  it('複数選択したサムネを押しただけでは選択が畳まれない', () => {
    const { result } = setupDrag()
    act(() => result.current.setSelectedIds(new Set([1, 2, 3])))

    mouseDownOnThumb(result, 2)

    expect(result.current.selectedIds).toEqual(new Set([1, 2, 3]))
  })

  it('掴んで動かすと選択中の全件が渡る（最後に押した1枚だけにならない）', () => {
    const { result } = setupDrag()
    act(() => result.current.setSelectedIds(new Set([1, 2, 3])))

    mouseDownOnThumb(result, 2)
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 0, buttons: 1 })))

    expect(mockApi().startImageDrag).toHaveBeenCalledWith([1, 2, 3])
    // ドラッグ後も選択は維持される（渡した後に選択が減ると次の操作で戸惑う）
    expect(result.current.selectedIds).toEqual(new Set([1, 2, 3]))
  })

  it('動かさずに離せば従来どおりその1枚の選択に畳まれる', () => {
    const { result } = setupDrag()
    act(() => result.current.setSelectedIds(new Set([1, 2, 3])))

    mouseDownOnThumb(result, 2)
    act(() => window.dispatchEvent(new MouseEvent('mouseup')))

    expect(result.current.selectedIds).toEqual(new Set([2]))
    expect(mockApi().startImageDrag).not.toHaveBeenCalled()
  })

  it('未選択のサムネを掴んだらその1枚だけが渡る', () => {
    const { result } = setupDrag()
    act(() => result.current.setSelectedIds(new Set([1, 2, 3])))

    mouseDownOnThumb(result, 5)
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 0, buttons: 1 })))

    expect(mockApi().startImageDrag).toHaveBeenCalledWith([5])
  })

  it('Ctrl 押しでの選択解除は保留されず即座に効く', () => {
    const { result } = setupDrag()
    act(() => result.current.setSelectedIds(new Set([1, 2, 3])))

    mouseDownOnThumb(result, 2, { ctrlKey: true })

    expect(result.current.selectedIds).toEqual(new Set([1, 3]))
  })
})
