// Web デモ版のエントリ。src/renderer/src/web/ ではなくここに置いているのは、Vite の
// dev サーバーが index.html の相対パスを「ルート(app/web)からの URL」として解決するため。
// HTML から ../src/... と外へ出ると dev では 404 になる（本番ビルドだけ通って気づけない）。
// モジュール間の import はルート外でも解決できるので、HTML が直接指すこのファイルだけを
// ルート内に置けばよい。CSS も同じ理由で <link> ではなく import で読み込む。
//
// 本体の main.tsx との違いは「App を描画する前に window.api を用意する」ことだけで、
// App 以下は本体とまったく同じコードが動く。
//
// App / video/init を **動的 import** にしているのは順序のため。Electron 版は preload が
// renderer より先に走るので window.api は常に存在するが、Web 版はこのファイル自身が
// 用意する側になる。静的 import はトップへ巻き上げられるので、モジュール評価時に
// window.api を掴む video/api.ts が undefined を掴んでしまう。
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/renderer/global.css'
import { installMockApi } from '../src/renderer/src/web/mockApi'

const root = document.getElementById('root')!

async function boot(): Promise<void> {
  await installMockApi()
  const { default: App } = await import('../src/renderer/src/web/bootApp')
  root.removeAttribute('data-loading')
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

boot().catch((err: unknown) => {
  // 素材の目録が読めないと一覧が空のまま無言で立ち上がり、原因が分からなくなる。
  // デモは開発者以外も開くので、画面上に理由を出して終える。
  root.removeAttribute('data-loading')
  root.textContent = `デモ素材を読み込めませんでした: ${String(err)}`
  root.setAttribute('style', 'padding:24px;color:#e0e0e0;font-family:sans-serif')
})
