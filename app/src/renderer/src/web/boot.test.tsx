// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { installMockApi } from './mockApi'
import type { DemoManifest } from './manifest'

// Web デモ版の起動経路（window.api を用意 → App を読み込む）が壊れていないことを見る。
// ShioriApi にメソッドが増えたのにモック側へ足し忘れると typecheck が落ちるが、
// 「読み込み順が逆転して window.api を undefined で掴む」類の事故は型では防げない
// （main.web.tsx が bootApp を動的 import している理由がこれ）。
//
// グリッドのサムネイルまでは検証しない。@tanstack/react-virtual は実寸から表示範囲を
// 決めるので、要素サイズが常に 0 の jsdom ではセルが 1 つも描画されないため。

const MANIFEST: DemoManifest = {
  items: [{
    file: 'a.png', mediaType: 'image', title: 'あさひ 第1話', host: 'youtube.com',
    url: null, currentTime: 120, capturedAt: 3000, duration: null, fps: null,
    memo: null, tags: [{ name: 'OP', source: 'manual' }],
  }],
}

beforeAll(async () => {
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => MANIFEST })) as unknown as typeof fetch
  globalThis.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} } as never
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as never
  await installMockApi()
})

// 描いたまま放置すると、テストが終わって jsdom を畳んだ後に React の残りの仕事が動き、
// window is not defined で落ちる（テスト自体は通るので、たまに出る謎のエラーに見える）。
// vitest は globals: false なので @testing-library/react の自動後片付けは効かない。
afterEach(() => {
  cleanup()
})

it('App がマウントでき、デモ素材が UI まで届く', async () => {
  const { default: App } = await import('./bootApp')
  const { container } = render(<App />)
  // サイドバーのタグ一覧（listAllTags）とツールバーの件数（countImages）。
  // どちらも window.api 経由でデモ素材の目録から組み立てられるので、
  // 表示まで届いていれば起動経路と主要な IPC 契約は通っている。
  await screen.findByTitle(/OP/, {}, { timeout: 3000 })
  expect(container.textContent).toContain('1枚')
})
