// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { installMockApi } from './mockApi'
import { mediaUrl } from '../utils'
import type { DemoManifest } from './manifest'

// Web デモ版の window.api は「見た目だけ動くモック」ではなく、db.ts の絞り込み・並び順を
// 写した実装。ここが本体とズレるとデモが嘘をつくので、主要な意味論だけ固定しておく。

const MANIFEST: DemoManifest = {
  items: [
    {
      file: 'a.png', mediaType: 'image', title: 'あさひ 第1話', host: 'youtube.com',
      url: null, currentTime: 120, capturedAt: 3000, duration: null, fps: null,
      memo: 'この構図', tags: [{ name: 'OP', source: 'manual' }, { name: '1girl', source: 'ai' }],
    },
    {
      file: 'b.png', mediaType: 'image', title: 'ゆうひ 第2話', host: 'netflix.com',
      url: null, currentTime: 540, capturedAt: 2000, duration: null, fps: null,
      memo: null, tags: [{ name: 'OP', source: 'manual' }],
    },
    {
      // 動画は duration を明示する（未指定だと起動時にブラウザへ実尺を読ませにいく）。
      file: 'c.mp4', mediaType: 'video', title: 'よる 第3話', host: 'youtube.com',
      url: null, currentTime: 60, capturedAt: 1000, duration: 12.5, fps: 30,
      memo: null, tags: [{ name: 'ED', source: 'manual' }],
    },
  ],
}

beforeAll(async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => MANIFEST,
  })) as unknown as typeof fetch
  await installMockApi()
})

describe('web デモの window.api', () => {
  it('既定は撮影日時の降順で返す', async () => {
    const rows = await window.api.listImages({})
    expect(rows.map((row) => row.title)).toEqual(['あさひ 第1話', 'ゆうひ 第2話', 'よる 第3話'])
  })

  it('カーソル(before)より後ろだけを返す', async () => {
    const rows = await window.api.listImages({ before: 3000, beforeId: 1 })
    expect(rows.map((row) => row.id)).toEqual([2, 3])
  })

  it('検索はタイトルとメモに当たる', async () => {
    expect(await window.api.countImages({ search: 'ゆうひ' })).toBe(1)
    expect(await window.api.countImages({ search: 'この構図' })).toBe(1)
    expect(await window.api.countImages({ search: '存在しない' })).toBe(0)
  })

  it('サービス絞り込みは完全一致', async () => {
    expect(await window.api.countImages({ site: 'youtube.com' })).toBe(2)
    expect(await window.api.countImages({ site: 'youtube' })).toBe(0)
    expect(await window.api.listSites()).toEqual(['netflix.com', 'youtube.com'])
  })

  it('メディア種別で絞り込める', async () => {
    expect(await window.api.countImages({ mediaType: 'video' })).toBe(1)
    expect(await window.api.countImages({ mediaType: 'image' })).toBe(2)
  })

  it('タグの and / or を区別する', async () => {
    expect(await window.api.countImages({ tags: ['OP', 'ED'], tagMode: 'or' })).toBe(3)
    expect(await window.api.countImages({ tags: ['OP', 'ED'], tagMode: 'and' })).toBe(0)
    expect(await window.api.countImages({ tags: ['OP'], tagMode: 'and' })).toBe(2)
  })

  it('listAllTags は includeAi で AI タグを出し分ける', async () => {
    expect((await window.api.listAllTags(false)).map((tag) => tag.name)).toEqual(['OP', 'ED'])
    expect((await window.api.listAllTags(true)).map((tag) => tag.name)).toEqual(['OP', 'ED', '1girl'])
  })

  it('タグの追加・削除が一覧の絞り込みに反映される', async () => {
    await window.api.taggerAddTag(3, '作画', 'manual')
    expect(await window.api.countImages({ tags: ['作画'] })).toBe(1)
    await window.api.taggerRemoveTag(3, '作画')
    expect(await window.api.countImages({ tags: ['作画'] })).toBe(0)
  })

  it('mediaUrl はデモ素材の配信 URL を返す', () => {
    expect(mediaUrl(1)).toBe('/a.png')
    expect(mediaUrl(3, 'thumb')).toBe('/c.mp4')
  })

  it('削除すると一覧から消える', async () => {
    expect(await window.api.deleteImagesBulk([2])).toEqual([{ ok: true, id: 2 }])
    expect((await window.api.listImages({})).map((row) => row.id)).toEqual([1, 3])
  })
})
