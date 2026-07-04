import { describe, it, expect, beforeEach } from 'vitest'
import { useImageStore } from './imageStore'
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
    media_type: 'image',
    duration: null,
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

  it('adjustGridTotalCount は件数のみ増減する', () => {
    useImageStore.getState().adjustGridTotalCount(-3)
    expect(useImageStore.getState().gridTotalCount).toBe(7)
    useImageStore.setState({ gridTotalCount: null })
    useImageStore.getState().adjustGridTotalCount(5)
    expect(useImageStore.getState().gridTotalCount).toBeNull()
  })
})
