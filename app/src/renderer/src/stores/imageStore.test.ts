// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useImageStore } from './imageStore'
import { useFilterStore } from './filterStore'
import type { ImageRow } from '../types'

function img(id: number, over: Partial<ImageRow> = {}): ImageRow {
  return {
    id,
    filepath: `/cap/${id}.png`,
    captured_at: 1000 + id,
    title: `t${id}`,
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
    source: 'capture',
    ...over,
  }
}

// 変更操作（patch/remove/prepend/件数調整）は grid・timeline 両リストを束ねるストアに
// 一元化されている。ここではその「両リスト同時反映」と件数整合をテストする。
describe('imageStore mutations', () => {
  beforeEach(() => {
    useImageStore.setState({
      gridImages: [img(1), img(2), img(3)],
      gridHasMore: true,
      gridTotalCount: 10,
      gridLoading: false,
      timelineImages: [img(1), img(2), img(3), img(4)],
      timelineLoading: false,
      timelineTotalCount: 12,
    })
  })

  it('patchImage は grid・timeline 双方の同一 id を更新する', () => {
    useImageStore.getState().patchImage(2, { title: 'updated', memo: 'm' })
    const s = useImageStore.getState()
    expect(s.gridImages.find((i) => i.id === 2)).toMatchObject({ title: 'updated', memo: 'm' })
    expect(s.timelineImages.find((i) => i.id === 2)).toMatchObject({ title: 'updated', memo: 'm' })
    // 他の画像は不変
    expect(s.gridImages.find((i) => i.id === 1)?.title).toBe('t1')
  })

  it('patchImage は対象 id がリストに無くても安全（何も壊さない）', () => {
    useImageStore.getState().patchImage(999, { title: 'x' })
    const s = useImageStore.getState()
    expect(s.gridImages.map((i) => i.id)).toEqual([1, 2, 3])
    expect(s.gridImages.every((i) => i.title === `t${i.id}`)).toBe(true)
  })

  it('removeImages は両リストから取り除き、件数を ids.size ぶん減らす', () => {
    useImageStore.getState().removeImages(new Set([1, 2]))
    const s = useImageStore.getState()
    expect(s.gridImages.map((i) => i.id)).toEqual([3])
    expect(s.timelineImages.map((i) => i.id)).toEqual([3, 4])
    expect(s.gridTotalCount).toBe(8)
    // D-3: timelineTotalCount も gridTotalCount と同様に真値のまま減算されること
    expect(s.timelineTotalCount).toBe(10)
  })

  it('removeImages はグリッド未ロード分を含む削除でも件数を ids.size ぶん減らす', () => {
    // id:4 は timeline にのみ存在（グリッド未ロード相当）。件数は 2 件分減るのが正。
    useImageStore.getState().removeImages(new Set([3, 4]))
    const s = useImageStore.getState()
    expect(s.gridImages.map((i) => i.id)).toEqual([1, 2])
    expect(s.timelineImages.map((i) => i.id)).toEqual([1, 2])
    expect(s.gridTotalCount).toBe(8)
  })

  it('removeImages は件数が null（未取得）なら null のまま', () => {
    useImageStore.setState({ gridTotalCount: null })
    useImageStore.getState().removeImages(new Set([1]))
    expect(useImageStore.getState().gridTotalCount).toBeNull()
  })

  it('prependToGrid はグリッド先頭に追加し件数を +1 する（timeline は触らない）', () => {
    useImageStore.getState().prependToGrid(img(99))
    const s = useImageStore.getState()
    expect(s.gridImages.map((i) => i.id)).toEqual([99, 1, 2, 3])
    expect(s.gridTotalCount).toBe(11)
    expect(s.timelineImages.map((i) => i.id)).toEqual([1, 2, 3, 4])
  })

  it('restoreImages は snapshot 未ロード分（grid/timelineどちらにも無かった id）の件数も戻す', () => {
    // id:5 は grid にも timeline にも存在しない（Ctrl+A で選択されたが未ロードの行を想定）。
    const snapshot = useImageStore.getState().removeImages(new Set([2, 5]))
    expect(useImageStore.getState().gridTotalCount).toBe(8)
    useImageStore.getState().restoreImages(snapshot)
    const s = useImageStore.getState()
    // 件数は removedIds（2件）ぶん戻る。行データが無い id:5 はリストへは戻らない。
    expect(s.gridTotalCount).toBe(10)
    expect(s.gridImages.map((i) => i.id)).toEqual([1, 2, 3])
    // D-3: timelineTotalCount も同様に戻る
    expect(s.timelineTotalCount).toBe(12)
  })

  it('adjustGridTotalCount は件数のみ増減する', () => {
    useImageStore.getState().adjustGridTotalCount(-3)
    expect(useImageStore.getState().gridTotalCount).toBe(7)
    useImageStore.setState({ gridTotalCount: null })
    useImageStore.getState().adjustGridTotalCount(5)
    expect(useImageStore.getState().gridTotalCount).toBeNull()
  })
})

describe('imageStore timeline paging', () => {
  it('200件ずつ取得し、次ページへ撮影日時とidのカーソルを渡す', async () => {
    useFilterStore.setState({ sortOrder: 'date_desc' })
    const first = Array.from({ length: 200 }, (_, i) => img(400 - i, { captured_at: 400 - i }))
    const second = [img(200, { captured_at: 200 }), img(199, { captured_at: 199 })]
    const listImages = vi.fn(async (req: { before?: number; beforeId?: number }) =>
      req.before === undefined ? first : second)
    ;(window as unknown as { api: unknown }).api = {
      listImages,
      countImages: vi.fn(async () => 202),
    }
    const showToast = vi.fn()

    useImageStore.getState().reloadTimeline(showToast)
    await vi.waitFor(() => expect(useImageStore.getState().timelineImages).toHaveLength(200))
    expect(useImageStore.getState().timelineHasMore).toBe(true)

    await useImageStore.getState().loadMoreTimeline(showToast)
    expect(listImages).toHaveBeenLastCalledWith(expect.objectContaining({
      limit: 200,
      before: 201,
      beforeId: 201,
      sortOrder: 'date_desc',
    }))
    expect(useImageStore.getState().timelineImages).toHaveLength(202)
    expect(useImageStore.getState().timelineHasMore).toBe(false)
  })

  it('古い順では最古のページから始め、次に新しい側のカーソルを使う', async () => {
    useFilterStore.setState({ sortOrder: 'date_asc' })
    const first = Array.from({ length: 200 }, (_, i) => img(i + 1, { captured_at: i + 1 }))
    const listImages = vi.fn(async (req: { before?: number; beforeId?: number }) =>
      req.before === undefined ? first : [img(201, { captured_at: 201 })])
    ;(window as unknown as { api: unknown }).api = {
      listImages,
      countImages: vi.fn(async () => 201),
    }

    useImageStore.getState().reloadTimeline(vi.fn())
    await vi.waitFor(() => expect(useImageStore.getState().timelineImages).toHaveLength(200))
    await useImageStore.getState().loadMoreTimeline(vi.fn())

    expect(listImages).toHaveBeenLastCalledWith(expect.objectContaining({
      before: 200,
      beforeId: 200,
      sortOrder: 'date_asc',
    }))
    expect(useImageStore.getState().timelineImages.at(-1)?.id).toBe(201)
  })
})

// 読み込み失敗を「本当に0件」と取り違えると、画面には初回案内（まだ画像がありません）が
// 出る。数千枚あるライブラリが消えたようにしか見えないため、失敗は状態として残す。
describe('1ページ目の読み込み失敗', () => {
  beforeEach(() => {
    useFilterStore.setState({ sortOrder: 'date_desc' })
    useImageStore.setState({ gridImages: [], gridLoadFailed: false })
  })

  it('失敗したら gridLoadFailed が立ち、追加読み込みは止まる', async () => {
    ;(window as unknown as { api: unknown }).api = {
      listImages: vi.fn(async () => { throw new Error('db down') }),
      countImages: vi.fn(async () => 0),
    }

    useImageStore.getState().reloadGrid(vi.fn())
    await vi.waitFor(() => expect(useImageStore.getState().gridLoadFailed).toBe(true))
    expect(useImageStore.getState().gridHasMore).toBe(false)
  })

  it('「もう一度読み込む」が成功したら失敗表示は消える', async () => {
    let fail = true
    ;(window as unknown as { api: unknown }).api = {
      listImages: vi.fn(async () => {
        if (fail) throw new Error('db down')
        return [img(1), img(2)]
      }),
      countImages: vi.fn(async () => 2),
    }

    useImageStore.getState().reloadGrid(vi.fn())
    await vi.waitFor(() => expect(useImageStore.getState().gridLoadFailed).toBe(true))

    fail = false
    useImageStore.getState().reloadGrid(vi.fn())
    await vi.waitFor(() => expect(useImageStore.getState().gridImages).toHaveLength(2))
    expect(useImageStore.getState().gridLoadFailed).toBe(false)
  })
})
