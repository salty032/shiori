import { describe, expect, it } from 'vitest'
import { buildItem } from './build-demo-manifest.mjs'
import { parseDemoManifest } from '../src/renderer/src/demo/manifest.ts'

// 目録を書く側（このスクリプト）は型検査を受けない。書いた 1 件が、読み込む側の形の確かめを
// 通ることをここで見る。DemoItem に項目を足してこちらを直し忘れると落ちる。
describe('build-demo-manifest が書く目録', () => {
  const meta = { defaults: {}, files: {} }

  it('画像と動画の 1 件ずつが、読み込む側の形を通る', () => {
    const items = [buildItem('sky.png', 0, meta), buildItem('clip.mp4', 1, meta)]
    expect(() => parseDemoManifest({ items })).not.toThrow()
  })

  it('meta.json で上書きした値（タグ・AI タグ・撮った時刻）でも通る', () => {
    const item = buildItem('sky.png', 0, {
      defaults: {},
      files: { 'sky.png': { title: '空', tags: ['背景'], aiTags: ['sky'], capturedAt: '2026-07-01T10:00:00', memo: 'メモ', fps: 24 } }
    })
    expect(() => parseDemoManifest({ items: [item] })).not.toThrow()
  })

  it('形の違う項目・知らない項目は止める', () => {
    const item = buildItem('sky.png', 0, meta)
    expect(() => parseDemoManifest({ items: [{ ...item, capturedAt: 'x' }] })).toThrow(/capturedAt/)
    expect(() => parseDemoManifest({ items: [{ ...item, extra: 1 }] })).toThrow(/extra/)
    expect(() => parseDemoManifest({})).toThrow(/items/)
  })
})
