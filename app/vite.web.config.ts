// GitHub Pages 向け Web デモ版のビルド設定。
//
// electron.vite.config.ts（main / preload / renderer の 3 層）とは別物で、こちらは
// renderer だけを素の Vite でビルドする。エントリは app/web/index.html、window.api の
// 実体は src/renderer/src/web/mockApi.ts が用意する。
//
// base はプロジェクトページ（https://<user>.github.io/shiori/）を既定にしつつ、
// 環境変数 DEMO_BASE で上書きできる（独自ドメインやローカル確認用）。
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string }

export default defineConfig({
  root: resolve(__dirname, 'web'),
  base: process.env.DEMO_BASE ?? '/shiori/',
  // デモ素材（画像・動画）と、ビルド時に生成する manifest.json の置き場。
  // publicDir の中身はそのまま配信物のルート直下へコピーされる。
  publicDir: resolve(__dirname, 'demo-assets'),
  build: {
    outDir: resolve(__dirname, 'dist-web'),
    emptyOutDir: true,
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
    },
  },
  plugins: [react()],
})
