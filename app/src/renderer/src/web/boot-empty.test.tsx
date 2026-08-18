// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { installMockApi } from './mockApi'
import type { DemoManifest } from './manifest'

// Web デモ版に素材が 1 件も無いときの第一画面。
//
// 目録が 0 件でもビルドは通る（警告が出るだけ）ので、素材を置き忘れたまま公開できてしまう。
// そのときコアの空ライブラリ画面をそのまま出すと、**デスクトップ版の初回案内が出る**
// ——「拡張機能フォルダを開く」ボタンは押しても「デモ版では利用できません」と断られ、
// ホットキーも効かず、ドロップでの取り込みも保存先が無い。3 手すべてが空振りする画面を
// 第一印象として出すことになるので、デモ専用の説明へ差し替えてある。
//
// 素材ありの起動経路は boot.test.tsx。**状態の混ざりを避けるためファイルを分けている**
// （installMockApi はモジュール内に目録を抱えるので、1 ファイル内で 0 件と 1 件は作れない）。

const EMPTY_MANIFEST: DemoManifest = { items: [] }

beforeAll(async () => {
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => EMPTY_MANIFEST })) as unknown as typeof fetch
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

it('素材が 0 件なら、デスクトップ版の初回案内ではなくデモ用の説明を出す', async () => {
  const { default: App } = await import('./bootApp')
  const { container } = render(<App />)

  await screen.findByText(/このデモには、まだ素材が置かれていません/, {}, { timeout: 3000 })

  // 押しても断られるだけのボタンと、デモでは成立しない手順が出ていないこと。
  // ここが本題なので、デモ文言が出ていることより厳しく見る。
  expect(container.textContent).not.toContain('拡張機能フォルダを開く')
  expect(container.textContent).not.toContain('対応サイトで動画を開きます')
})
