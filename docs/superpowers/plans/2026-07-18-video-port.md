# 動画キャプチャ機能移植 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** shiori-dev（https://github.com/salty032/shiori-dev）の動画キャプチャ機能（録画クリップ・トリミング・再生）を、shiori本体（v1.1.3）へ移植する。

**Architecture:** dev の動画関連23ファイルをほぼそのままコピーし（`git checkout shiori-dev/main -- <path>`）、shiori 側の feature hook（`MainFeature`）機構と registry（レンダラー拡張点）を新設して bootstrap / App / Viewer 等の既存コアへ最小の配線を追加する。dev のビルドフレーバー分割（`SHIORI_FLAVOR`）は導入せず、shiori は常時「動画入り」の単一ビルドにする。DB は `media_type` / `duration` カラムを追加するマイグレーションを1本足す。

**Tech Stack:** Electron 42 / React 19 / TypeScript / better-sqlite3 / ffmpeg-static / vitest

## Global Constraints

- 参照元: `docs/PORT_VIDEO_2026-07-18.md`（詳細な背景・配線一覧・誤爆防止リストはこちらが正）。本プランはそれを実行順のタスクに変換したもの。
- 2リポジトリは git 履歴が繋がっていない。dev の差分を丸ごと適用しない。既存ファイルは shiori 側が正、動画関連の行だけ追加する。
- dev リポジトリは `git fetch https://github.com/salty032/shiori-dev main:refs/remotes/shiori-dev/main` 済みの前提（Task 0 で実施）。以後 `shiori-dev/main` として参照可能。
- 全タスク完了後、`docs/CODE_REVIEW_VIDEO_2026-07-07.md` の V-1(P1)・V-2/V-4/V-5(P2) を修正する（Task 8）。V-3/V-6以降はスコープ外。
- 各タスクの終わりに `cd app && npm run typecheck` を通す。テストがあるタスクは `npm test` も通す。
- 作業ブランチ: `feature/video-port`（Task 0 で作成）。

---

### Task 0: ブランチ作成と dev リポジトリの参照準備

**Files:** なし（git 操作のみ）

- [ ] **Step 1: ブランチ作成と fetch**

```bash
cd "c:/Users/eiji8/Documents/shiori"
git checkout -b feature/video-port
git fetch https://github.com/salty032/shiori-dev main:refs/remotes/shiori-dev/main
git checkout shiori-dev/main -- docs/CODE_REVIEW_VIDEO_2026-07-07.md
git add docs/CODE_REVIEW_VIDEO_2026-07-07.md
git commit -m "docs: shiori-devのコードレビュー文書を参照用に取り込み"
```

---

### Task 1: 依存パッケージとビルド設定

**Files:**
- Modify: `app/package.json`
- Modify: `app/electron.vite.config.ts`

**Interfaces:**
- Produces: `ffmpeg-static` / `fix-webm-duration` パッケージが node_modules に入り、以後のタスクの `import ffmpegStatic from 'ffmpeg-static'` 等が解決できる。vite の preload/renderer ビルドに `recorder` エントリが追加される。

- [ ] **Step 1: package.json に依存追加**

`dependencies` に以下を追加（アルファベット順を維持）：
```json
"ffmpeg-static": "^5.3.0",
"fix-webm-duration": "^1.0.6",
```
`build.extraResources` はそのまま。`build` トップレベルに `asarUnpack` を追加：
```json
"asarUnpack": [
  "node_modules/ffmpeg-static/**"
],
```
（`"afterPack"` キーの直後、`"extraResources"` の前に挿入。`build.files` の除外リストは変更しない。）

- [ ] **Step 2: npm install**

```bash
cd "c:/Users/eiji8/Documents/shiori/app"
npm install
```
Expected: `ffmpeg-static` と `fix-webm-duration` が `node_modules` に追加される（postinstall の electron-rebuild は既存ネイティブモジュール向けなのでエラーなく完了する）。

- [ ] **Step 3: electron.vite.config.ts に recorder エントリを追加**

`preload.build.rollupOptions.input` を:
```ts
input: {
  index: resolve('src/preload/index.ts'),
  recorder: resolve('src/preload/recorder.ts')
}
```
`renderer.build.rollupOptions.input` を:
```ts
input: {
  index: resolve('src/renderer/index.html'),
  recorder: resolve('src/renderer/recorder.html')
}
```
（`SHIORI_FLAVOR` の `define` は追加しない。この時点では `src/preload/recorder.ts` と `src/renderer/recorder.html` はまだ存在しないため、typecheck は通るが `npm run dev`/`build` はまだ動かない。Task 2 で解消する。）

- [ ] **Step 4: コミット**

```bash
git add app/package.json app/package-lock.json app/electron.vite.config.ts
git commit -m "build: 動画機能の依存パッケージ(ffmpeg-static/fix-webm-duration)とrecorderエントリを追加"
```

---

### Task 2: main プロセス — 動画モジュールをコピーし feature hook で配線する

**Files:**
- Create: `app/src/main/feature.ts`（dev から新規コピー）
- Create: `app/src/main/video-thumb-provider.ts`（dev から新規コピー）
- Create: `app/src/main/video/clip-hotkey.ts`（dev から新規コピー）
- Create: `app/src/main/video/ffmpeg.ts`（dev から新規コピー）
- Create: `app/src/main/video/ffmpeg.test.ts`（dev から新規コピー）
- Create: `app/src/main/video/index.ts`（dev から新規コピー）
- Create: `app/src/main/video/ipc-video.ts`（dev から新規コピー）
- Create: `app/src/main/video/recorder-ipc.ts`（dev から新規コピー）
- Create: `app/src/main/video/recorder-window.ts`（dev から新規コピー）
- Create: `app/src/main/video/recording.ts`（dev から新規コピー）
- Create: `app/src/preload/video-api.ts`（dev から新規コピー）
- Create: `app/src/preload/recorder.ts`（dev から新規コピー）
- Create: `app/src/shared/api.video.ts`（dev から新規コピー）
- Modify: `app/src/main/index.ts`
- Modify: `app/src/main/bootstrap.ts`
- Modify: `app/src/preload/index.ts`

**Interfaces:**
- Consumes: `capture.ts` の `addPreCaptureGuard` / `addBrowserTargetUpdateGuard` / `SilentCaptureAbort` / `canCaptureVideo` / `getBrowserWindowRect` / `setBrowserWindowPos` / `setVideoRect`（全て shiori に既存）、`windows.ts` の `handleTrusted` / `isMainWindowFocused` / `getMainWindow`（既存）、`timecode.ts` の `getLastTimecode` / `setLastTimecode`（既存）、`hotkey.ts` の `normalizeCaptureHotkey`（既存）、`settings.ts` の `loadSettings`/`saveSettings`（既存。`clipHotkey`/`clipMaxSeconds`/`clipNotify` は Task 3 で追加）、`captured-media.ts` の `registerCapturedMedia`（既存、Task 3 で `media_type`/`duration` 対応）
- Produces: `videoFeature: MainFeature`（`app/src/main/video/index.ts`）。`registerRecorderIpc()` / `registerVideoHandlers()`。preload の `window.api` に `VideoApi`（`setClipHotkey`/`getFramePts`/`getTimelineStrip`/`trimVideo`）が合成される。

- [ ] **Step 1: dev から動画関連の新規ファイルをまとめてコピー**

```bash
cd "c:/Users/eiji8/Documents/shiori"
git checkout shiori-dev/main -- \
  app/src/main/feature.ts \
  app/src/main/video-thumb-provider.ts \
  app/src/main/video/clip-hotkey.ts \
  app/src/main/video/ffmpeg.ts \
  app/src/main/video/ffmpeg.test.ts \
  app/src/main/video/index.ts \
  app/src/main/video/ipc-video.ts \
  app/src/main/video/recorder-ipc.ts \
  app/src/main/video/recorder-window.ts \
  app/src/main/video/recording.ts \
  app/src/preload/video-api.ts \
  app/src/preload/recorder.ts \
  app/src/shared/api.video.ts
```
これらのファイルは dev で完成済みで、shiori 側に同名ファイルが存在しないため無調整でコピーできる（`app/src/main/video/index.ts` が唯一 `../feature`・`../capture`・`../windows`・`../hotkey`・`../../shared/api.video`・`./recorder-window`・`./ipc-video`・`./recorder-ipc`・`./clip-hotkey`・`./recording`・`./ffmpeg`・`../video-thumb-provider` を import するが、全て shiori に存在するか同時にコピーする対象）。

- [ ] **Step 2: main/index.ts を書き換え**

`app/src/main/index.ts` の内容を：
```ts
import { bootstrap } from './bootstrap'
import { videoFeature } from './video'

bootstrap([videoFeature])
```

- [ ] **Step 3: bootstrap.ts のシグネチャを features 対応にする**

`app/src/main/bootstrap.ts` の `import { type MainFeature } from './feature'` を先頭 import 群に追加。

`export function bootstrap(): void {` を `export function bootstrap(features: MainFeature[] = []): void {` に変更。

`registerImageHandlers()` `registerDragHandlers()` `registerTaggerHandlers()` `registerShareHandlers()` `registerImportHandlers()` の直後（307行目付近）に追加：
```ts
    for (const feature of features) feature.registerIpc?.()
```

`createTray()` `createWindow(...)` の直後、`app.whenReady().then(...)` 内の初期化がひととおり終わったあたり（464行目の `createWindow(reclaimHotkeysIfFree, isStartupLaunch())` の直後）に追加：
```ts
    for (const feature of features) await feature.onReady?.()
```
（`whenReady().then(async () => { ... })` は既に async 関数なので `await` は使える。）

`app.on('before-quit', (event) => {` ブロック内、`globalShortcut.unregisterAll()` の直前に追加：
```ts
    for (const feature of features) feature.onBeforeQuit?.()
```

- [ ] **Step 4: preload/index.ts に動画 API を合成**

`app/src/preload/index.ts` を：
```ts
import { contextBridge } from 'electron'
import { buildCoreApi } from './api-core'
import { buildVideoApi } from './video-api'

contextBridge.exposeInMainWorld('api', { ...buildCoreApi(), ...buildVideoApi() })
```

- [ ] **Step 5: typecheck**

```bash
cd "c:/Users/eiji8/Documents/shiori/app"
npm run typecheck
```
Expected: `media_type`/`duration` が `ImageRow` にまだ無いことに起因するエラー（`ipc-video.ts` の `image.media_type` 等）と、`settings.ts` に `clipHotkey`/`clipMaxSeconds`/`clipNotify` がないことに起因するエラーが出る。これらは Task 3 で解消される想定なので、**この時点でのエラーは動画関連の型不足のみであること**を確認する（無関係なエラーが出ていないか確認）。

- [ ] **Step 6: コミット**

```bash
git add app/src/main/feature.ts app/src/main/video-thumb-provider.ts app/src/main/video app/src/preload/video-api.ts app/src/preload/recorder.ts app/src/shared/api.video.ts app/src/main/index.ts app/src/main/bootstrap.ts app/src/preload/index.ts
git commit -m "feat: 動画機能のmainプロセス一式を移植しfeature hookで配線"
```

---

### Task 3: データ層 — 型・設定・DB マイグレーション

**Files:**
- Modify: `app/src/shared/types.ts`
- Modify: `app/src/shared/settingsDefaults.ts`
- Modify: `app/src/main/settings.ts`
- Modify: `app/src/main/db.ts`

**Interfaces:**
- Produces: `ImageRow.media_type: 'image' | 'video' | null`、`ImageRow.duration: number | null`、`ImageQuery.mediaType?: 'image' | 'video'`、`Settings.clipHotkey: string`、`Settings.clipMaxSeconds: number`、`Settings.clipNotify: boolean`。DB `images` テーブルに `media_type TEXT` / `duration REAL` カラム。

- [ ] **Step 1: shared/types.ts に動画フィールドを追加**

`ImageRow` 型に `thumb_path` の直前へ2行追加：
```ts
export type ImageRow = {
  id: number
  filepath: string
  captured_at: number
  title: string | null
  current_time: number | null
  url: string | null
  colors: string | null
  memo: string | null
  media_type: 'image' | 'video' | null
  duration: number | null
  thumb_path: string | null
  source: ImageSource
}
```
`Settings` 型に `captureHotkey: string` の直後へ3行追加：
```ts
export type Settings = {
  titleStrip: string[]
  thumbnailSize: number
  frameFps: number
  frameFpsAuto: boolean
  smartFolders: SmartFolder[]
  captureHotkey: string
  clipHotkey: string
  clipMaxSeconds: number
  clipNotify: boolean
  captureNotify: boolean
  allowedExtensionIds: string[]
  serviceOrder: string[]
  showAiTags: boolean
  theme: Theme
  lastRunVersion: string | null
}
```
`ImageQuery` 型に `site?: string` の直後へ1行追加：
```ts
export type ImageQuery = {
  search?: string
  after?: number
  site?: string
  mediaType?: 'image' | 'video'
  tags?: string[]
  tagMode?: TagMode
  toDate?: number
}
```
他の型（`TagWithCount`・`Theme`・`ExtensionTimecode.versionMismatch`・`lastRunVersion` 等）は変更しない。

- [ ] **Step 2: settingsDefaults.ts にクリップ設定の既定値を追加**

`captureHotkey: 'Alt+S',` の直後へ追加：
```ts
export const SETTINGS_DEFAULTS: Settings = {
  titleStrip: [],
  thumbnailSize: 160,
  frameFps: 24,
  frameFpsAuto: true,
  smartFolders: [],
  captureHotkey: 'Alt+S',
  clipHotkey: 'Alt+R',
  clipMaxSeconds: 60,
  clipNotify: true,
  captureNotify: true,
  allowedExtensionIds: [],
  serviceOrder: [],
  showAiTags: false,
  theme: 'system',
  lastRunVersion: null,
}
```

- [ ] **Step 3: settings.ts の normalizeSettings にクリップ設定の検証を追加**

`app/src/main/settings.ts` の `normalizeSettings` 内、`captureHotkey: hotkeyText(data.captureHotkey, DEFAULTS.captureHotkey),` の直後に追加：
```ts
    clipHotkey: hotkeyText(data.clipHotkey, DEFAULTS.clipHotkey),
    clipMaxSeconds: boundedNumber(data.clipMaxSeconds, DEFAULTS.clipMaxSeconds, 5, 300),
    clipNotify: data.clipNotify !== false,
```
（`hotkeyText`・`boundedNumber` は既存のヘルパーをそのまま再利用できる。`clipHotkey` は `captureHotkey` と同じ `normalizeCaptureHotkey` ベースの検証で問題ない。）

- [ ] **Step 4: db.ts にマイグレーションと列を追加**

`CREATE TABLE IF NOT EXISTS images (...)` の `thumb_path TEXT` の直後に列追加（新規 DB 向け）：
```sql
      thumb_path   TEXT,
      media_type   TEXT,
      duration     REAL
```
（末尾カンマ位置に注意。既存の `);` の直前に置く。）

`addColumnIfMissing('ALTER TABLE images ADD COLUMN thumb_path TEXT')` の直後に既存 DB 向けマイグレーションを追加：
```ts
  addColumnIfMissing('ALTER TABLE images ADD COLUMN media_type TEXT')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN duration REAL')
```

`PUBLIC_IMAGE_COLUMNS` 配列に `'"thumb_path"',` の直前へ追加：
```ts
const PUBLIC_IMAGE_COLUMNS = [
  '"id"',
  '"filepath"',
  '"captured_at"',
  '"title"',
  '"current_time"',
  '"url"',
  '"colors"',
  '"memo"',
  '"media_type"',
  '"duration"',
  '"thumb_path"',
  '"source"'
].join(', ')
```

`insertImage` の INSERT 文に列を追加：
```ts
export function insertImage(params: Omit<ImageRow, 'id' | 'host' | 'source'> & { source?: 'capture' | 'import' }): number {
  let host: string | null = null
  try { if (params.url) host = new URL(params.url).hostname.replace(/^www\./, '') } catch { /* ignore */ }
  const source = params.source ?? 'capture'
  const stmt = prepare(
    `INSERT INTO images (filepath, captured_at, title, current_time, url, width, height, colors, memo, media_type, duration, thumb_path, host, source)
     VALUES (@filepath, @captured_at, @title, @current_time, @url, @width, @height, @colors, @memo, @media_type, @duration, @thumb_path, @host, @source)`
  )
  const result = stmt.run({ ...params, current_time: normalizeCurrentTime(params.current_time), host, source })
  return Number(result.lastInsertRowid)
}
```

`buildImageFilter` に `mediaType` フィルタを追加。`if (f.site) { conds.push('host = ?'); params.push(f.site) }` の直後に追加：
```ts
  if (f.mediaType) {
    if (f.mediaType === 'image') conds.push("(media_type IS NULL OR media_type = 'image')")
    else conds.push('media_type = ?'), params.push(f.mediaType)
  }
```
`ImageFilter` 型は `ImageQuery & {...}` なので `mediaType` は自動で伝播する（追加変更不要）。

- [ ] **Step 5: db.test.ts に media_type/duration のカラムテストを追加**

`app/src/main/db.test.ts` を Read し、既存の `insertImage`/`getImage` テストのパターンに沿って以下を追記する：
```ts
it('media_type/duration が保存・取得できる', () => {
  const id = insertImage({
    filepath: '/tmp/clip.webm', captured_at: Date.now(), title: null,
    current_time: null, url: null, width: null, height: null,
    colors: null, memo: null, media_type: 'video', duration: 12.5, thumb_path: null
  })
  const row = getImage(id)
  expect(row?.media_type).toBe('video')
  expect(row?.duration).toBe(12.5)
})

it('media_type未指定の画像はnullで保存される', () => {
  const id = insertImage({
    filepath: '/tmp/img.png', captured_at: Date.now(), title: null,
    current_time: null, url: null, width: null, height: null,
    colors: null, memo: null, media_type: null, duration: null, thumb_path: null
  })
  const row = getImage(id)
  expect(row?.media_type).toBeNull()
})
```
（既存テストの `insertImage` 呼び出しが `media_type`/`duration` を渡していない場合は型エラーになるので、それらの呼び出しにも `media_type: null, duration: null` を足す。）

- [ ] **Step 6: typecheck と db テストを実行**

```bash
cd "c:/Users/eiji8/Documents/shiori/app"
npm run typecheck
npx vitest run src/main/db.test.ts src/main/settings.test.ts
```
Expected: 型エラーが大幅に減る（Task 2 で保留していた `media_type`/`clipHotkey` 系のエラーが解消）。db/settings のテストは全て PASS。

- [ ] **Step 7: コミット**

```bash
git add app/src/shared/types.ts app/src/shared/settingsDefaults.ts app/src/main/settings.ts app/src/main/db.ts app/src/main/db.test.ts
git commit -m "feat: media_type/durationカラムとクリップ設定をデータ層に追加"
```

---

### Task 4: トレイ・capfile Content-Type・ipc-images/import/share の動画対応

**Files:**
- Modify: `app/src/main/tray.ts`
- Modify: `app/src/main/bootstrap.ts`（capfile ハンドラの Content-Type）
- Modify: `app/src/main/ipc-images.ts`
- Modify: `app/src/main/ipc-import.ts`
- Modify: `app/src/main/ipc-share.ts`

**Interfaces:**
- Consumes: `video-thumb-provider.ts` の `getVideoThumbProvider()`（Task 2 でコピー済み）
- Produces: `setTrayRecording(recording: boolean): void`（tray.ts）。トレイアイコンが録画中に切り替わる。動画（.webm）が capfile 経由で正しい Content-Type で配信される。画像インポート・共有インポート・サムネ再生成が動画ファイルでも壊れず動く。

- [ ] **Step 1: dev の該当ファイルとの diff を確認**

```bash
cd "c:/Users/eiji8/Documents/shiori"
git diff HEAD shiori-dev/main -- app/src/main/tray.ts app/src/main/ipc-images.ts app/src/main/ipc-import.ts app/src/main/ipc-share.ts
```
出力を読み、`getVideoThumbProvider` / `media_type` / `duration` / `clip` に関係する行だけを特定する（他の行は shiori 側が正なので無視。§6 の誤爆防止リストに従う）。

- [ ] **Step 2: tray.ts に setTrayRecording を追加**

`app/src/main/tray.ts` に、`let tray: Tray | null = null` の直後へ追加：
```ts
let recording = false

export function setTrayRecording(isRecording: boolean): void {
  recording = isRecording
  tray?.setToolTip(recording ? 'Shiori（録画中）' : 'Shiori')
}
```
（dev 側の実装がアイコン自体を切り替えている場合は `git show shiori-dev/main:app/src/main/tray.ts` で確認し、ツールチップ切替とアイコン切替のどちらを採用しているか確認した上で反映する。アイコン切替を採用する場合、`buildTrayIcon()` の呼び出しを `recording` 状態で出し分ける形にする。）

- [ ] **Step 3: bootstrap.ts の capfile ハンドラに動画の Content-Type を追加**

`EXT_CONTENT_TYPE` に動画拡張子を追加：
```ts
      const EXT_CONTENT_TYPE: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.webp': 'image/webp', '.gif': 'image/gif',
        '.webm': 'video/webm', '.mp4': 'video/mp4'
      }
```
直前のコメント「画像専用ビルド。動画(video/webm・video/mp4)は扱わない。」を「動画(webm)を含む capfile プロトコル。」に更新する。

- [ ] **Step 4: ipc-images.ts / ipc-import.ts / ipc-share.ts の動画サムネ対応を移植**

Step 1 の diff で特定した箇所（`getVideoThumbProvider` の import と、サムネ再生成・共有インポート時の呼び出し）を、各ファイルの対応する既存ロジック（画像の `createImageThumb` 呼び出し箇所の隣）に追加する。パターンは共通で「`media_type === 'video'` なら `getVideoThumbProvider().extractThumb()`、それ以外は既存の画像サムネ生成」の分岐。既存の try/catch・エラー処理の構造は変えない。

- [ ] **Step 5: typecheck**

```bash
cd "c:/Users/eiji8/Documents/shiori/app"
npm run typecheck
```

- [ ] **Step 6: コミット**

```bash
git add app/src/main/tray.ts app/src/main/bootstrap.ts app/src/main/ipc-images.ts app/src/main/ipc-import.ts app/src/main/ipc-share.ts
git commit -m "feat: トレイ録画表示・capfile動画配信・サムネ再生成の動画対応"
```

---

### Task 5: renderer — 動画モジュールのコピーと registry の新設

**Files:**
- Create: `app/src/renderer/recorder.html`（dev から新規コピー）
- Create: `app/src/renderer/recorder.ts`（dev から新規コピー）
- Create: `app/src/renderer/src/components/VideoPlayer.tsx`（dev から新規コピー）
- Create: `app/src/renderer/src/features/registry.ts`（dev から新規コピー）
- Create: `app/src/renderer/src/video/ClipHotkeySettings.tsx`（dev から新規コピー）
- Create: `app/src/renderer/src/video/VideoTrimmer.tsx`（dev から新規コピー）
- Create: `app/src/renderer/src/video/VideoTrimmerModal.tsx`（dev から新規コピー）
- Create: `app/src/renderer/src/video/api.ts`（dev から新規コピー）
- Create: `app/src/renderer/src/video/init.tsx`（dev から新規コピー）
- Create: `app/src/renderer/src/video/trimStore.ts`（dev から新規コピー）
- Modify: `app/src/renderer/src/main.tsx`
- Modify: `app/src/renderer/index.html`

**Interfaces:**
- Produces: `registerMediaAction` / `registerContextMenuItems` / `registerModal` / `registerSettingsSlot` / `getMediaActions` / `getExtraContextMenuItems` / `getModals` / `getSettingsSlots`（`features/registry.ts`）。`video/init.tsx` が import された時点でこれらに動画UIが登録される。

- [ ] **Step 1: dev から新規ファイルをまとめてコピー**

```bash
cd "c:/Users/eiji8/Documents/shiori"
git checkout shiori-dev/main -- \
  app/src/renderer/recorder.html \
  app/src/renderer/recorder.ts \
  app/src/renderer/src/components/VideoPlayer.tsx \
  app/src/renderer/src/features/registry.ts \
  app/src/renderer/src/video/ClipHotkeySettings.tsx \
  app/src/renderer/src/video/VideoTrimmer.tsx \
  app/src/renderer/src/video/VideoTrimmerModal.tsx \
  app/src/renderer/src/video/api.ts \
  app/src/renderer/src/video/init.tsx \
  app/src/renderer/src/video/trimStore.ts
```

- [ ] **Step 2: main.tsx に video/init の import を追加**

`app/src/renderer/src/main.tsx` を：
```ts
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './video/init'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
```

- [ ] **Step 3: index.html の CSP に media-src と ws ポートを確認**

`app/src/renderer/index.html` の CSP を、動画再生（capfile 経由の `<video>` タグ）に対応させる：
```html
      content="default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' capfile: data:; media-src capfile:; connect-src 'self'"
```
（`media-src capfile:` を追加。既存の `connect-src 'self'` はそのまま — dev版は `ws://127.0.0.1:39821` を追加しているが、shiori の ws-server は `connect-src 'self'` で既に動作しているため変更不要。念のため `app/src/main/ws-server.ts` の `PORT` 定数を確認し、CSP の `connect-src` が実際のポートと矛盾しないことを確認する。）

- [ ] **Step 4: typecheck（renderer 側のコンパイルエラーを確認）**

```bash
cd "c:/Users/eiji8/Documents/shiori/app"
npm run typecheck
```
Expected: `video/init.tsx` が参照する `ImageRow.media_type` は Task 3 で追加済みなので解決するはず。もしコピーしたファイルが shiori に無い他のモジュール（例: dev 専用の別コンポーネント）を参照していたらエラーになるので、その import 元をログから特定し Step 1 のコピー対象に追加する。

- [ ] **Step 5: コミット**

```bash
git add app/src/renderer/recorder.html app/src/renderer/recorder.ts app/src/renderer/src/components/VideoPlayer.tsx app/src/renderer/src/features app/src/renderer/src/video app/src/renderer/src/main.tsx app/src/renderer/index.html
git commit -m "feat: 動画UIモジュール(レコーダー/トリマー/プレーヤー)とfeature registryを移植"
```

---

### Task 6: renderer — 既存コンポーネントへの配線

**Files:**
- Modify: `app/src/renderer/src/components/Viewer.tsx`
- Modify: `app/src/renderer/src/components/DetailPanel.tsx`
- Modify: `app/src/renderer/src/components/ThumbCell.tsx`
- Modify: `app/src/renderer/src/App.tsx`
- Modify: `app/src/renderer/src/components/SettingsModal.tsx`
- Modify: `app/src/renderer/src/utils.ts`
- Modify: `app/src/renderer/src/utils.test.ts`

**Interfaces:**
- Consumes: `features/registry.ts` の `getMediaActions` / `getExtraContextMenuItems` / `getModals` / `getSettingsSlots`（Task 5）
- Produces: Viewer/DetailPanel が動画を `<VideoPlayer>` で再生し、トリミングボタンを表示する。App にトリマーモーダルが描画される。SettingsModal の「キャプチャ」タブにクリップホットキー設定が出る。

- [ ] **Step 1: dev との diff を取り、動画関連行を特定**

```bash
cd "c:/Users/eiji8/Documents/shiori"
git diff HEAD shiori-dev/main -- app/src/renderer/src/components/Viewer.tsx app/src/renderer/src/components/DetailPanel.tsx app/src/renderer/src/components/ThumbCell.tsx app/src/renderer/src/App.tsx app/src/renderer/src/components/SettingsModal.tsx app/src/renderer/src/utils.ts app/src/renderer/src/utils.test.ts
```
各ファイルについて、`media_type` / `VideoPlayer` / `getMediaActions` / `getExtraContextMenuItems` / `getModals` / `getSettingsSlots` / `duration` に関係する行だけを抜き出す。それ以外（スタイル・リファクタ・`color`/`SmartFolder` 関連等）は §6 の誤爆防止リストに従い無視する。

- [ ] **Step 2: utils.ts に動画対応を追加**

`thumbSrc` はそのまま（既に `media_type` を問わず動く設計）。`mediaUrl` を確認し、動画の場合に capfile URL を返せているか確認する（既存実装が id ベースなら追加不要）。dev の diff にある動画専用ユーティリティ（duration フォーマット等、`ClipHotkeySettings.tsx` 等が `utils.ts` からの import を期待している場合）があれば追加する。

- [ ] **Step 3: Viewer.tsx に動画再生とアクション行を追加**

`img.media_type === 'video'` の場合、既存の `<img>`（317行目付近、`s.viewerImg` を使う要素）の代わりに `VideoPlayer` を描画する分岐を追加する。トップバー（`s.viewerActions`）に `getMediaActions(img, { close })` の描画を追加する（`close` は既存の `close()` 関数）。

- [ ] **Step 4: DetailPanel.tsx に動画対応を追加**

`single.media_type === 'video'` の場合、`<img src={fullImageSrc ?? thumbSrc(single)} style={s.img} />`（273行目）の代わりに `VideoPlayer` を描画する。`s.actions` 内のボタン列に `getMediaActions(single)` を追加する。

- [ ] **Step 5: ThumbCell.tsx に動画バッジを追加**

dev の diff を見て、duration バッジ（サムネ右下等）の表示を移植する。`img.media_type === 'video' && img.duration != null` のときだけ表示する。

- [ ] **Step 6: App.tsx にモーダルとコンテキストメニューを配線**

`getModals()` の戻り値を描画する箇所を追加（既存のモーダル描画パターンに合わせる）。コンテキストメニューの項目配列に `getExtraContextMenuItems(img)` をスプレッドで足す。

- [ ] **Step 7: SettingsModal.tsx にキャプチャタブのスロットを追加**

「キャプチャ」タブの描画部分に `getSettingsSlots('キャプチャ')` をマップして描画するコードを追加する。`onCapturingChange` は既存の Escape 自動クローズ抑止ロジックに接続する（dev の diff を参考に、SettingsModal 側で対応する state を新設する）。

- [ ] **Step 8: 画像/動画フィルタの配線**

`app/src/renderer/src/components/Toolbar.tsx`・`app/src/renderer/src/stores/filterStore.ts`・`app/src/renderer/src/hooks/useFilters.ts`・`app/src/renderer/src/stores/imageQuery.ts` を Read し、既存の `site` フィルタ（ドロップダウンやチップ）と同じパターンで `mediaType` フィルタ（画像/動画の2値トグル）を追加する。dev の diff に混ざる `color`（スマートフォルダ色）関連は移植しない。

- [ ] **Step 9: typecheck**

```bash
cd "c:/Users/eiji8/Documents/shiori/app"
npm run typecheck
```

- [ ] **Step 10: コミット**

```bash
git add app/src/renderer/src
git commit -m "feat: Viewer/DetailPanel/App/SettingsModal/Toolbarに動画UIを配線"
```

---

### Task 7: 手動動作確認（録画〜再生〜トリミングの一気通貫）

**Files:** なし（動作確認のみ）

- [ ] **Step 1: 全体テストと dev サーバー起動**

```bash
cd "c:/Users/eiji8/Documents/shiori/app"
npm run verify
npm run dev
```

- [ ] **Step 2: 拡張機能を接続し録画→保存を確認**

拡張済みブラウザで動画ページを開き、Alt+R で録画開始→Alt+R で停止。ライブラリに webm クリップが登録され、タイトル・タイムコード・URL・サムネ・duration が表示されることを確認する。

- [ ] **Step 3: 再生とトリミングを確認**

グリッドから開いて VideoPlayer でシークできること、コンテキストメニュー／詳細パネルからトリマーを開いて範囲指定→保存で新規クリップが増えることを確認する。

- [ ] **Step 4: 設定画面を確認**

「キャプチャ」タブにクリップホットキー設定が表示され、変更が反映されることを確認する。画像/動画フィルタが効くこと、既存の画像機能（キャプチャ・タグ・共有・エクスポート）に退行がないことを確認する。

問題が見つかった場合は該当タスクに戻って修正し、再度 npm run typecheck / npm test を通してから次に進む。

---

### Task 8: バグ修正（V-1 / V-2 / V-4 / V-5）

**Files:**
- Modify: `app/src/renderer/recorder.ts`
- Modify: `app/src/main/video/recording.ts`
- Modify: `app/src/main/video/recorder-ipc.ts`

**Interfaces:**
- Consumes: `timecode.ts` の `getLastTimecodeAt()`（既存）

参照: `docs/CODE_REVIEW_VIDEO_2026-07-07.md` の V-1・V-2・V-4・V-5 の節（現状分析の全文はそちらを読むこと）。

- [ ] **Step 1（V-2, P2）: recorder-ipc.ts のディレクトリ作成を try 内に移動**

`app/src/main/video/recorder-ipc.ts` の `recorder:done` ハンドラで、
```ts
    const capturedAt = Date.now()
    const dir = await ensureCaptureSubDir(capturedAt)
    let webmPath: string | null = null
```
を
```ts
    const capturedAt = Date.now()
    let webmPath: string | null = null
```
に変え、`try {` ブロックの先頭（`webmPath = await writeCaptureFile(dir, webm, '.webm')` の直前）に `const dir = await ensureCaptureSubDir(capturedAt)` を移動する：
```ts
    try {
      const dir = await ensureCaptureSubDir(capturedAt)
      webmPath = await writeCaptureFile(dir, webm, '.webm')
```

- [ ] **Step 2（V-2）: typecheck**

```bash
cd "c:/Users/eiji8/Documents/shiori/app"
npm run typecheck
```

- [ ] **Step 3（V-2）: コミット**

```bash
git add app/src/main/video/recorder-ipc.ts
git commit -m "fix: recorder:doneのディレクトリ作成失敗時にクリップが通知なしで消えるのを修正(V-2)"
```

- [ ] **Step 4（V-4, P2）: recording.ts に timecode 鮮度チェックを追加**

`app/src/main/video/recording.ts` の import に `getLastTimecodeAt` を追加：
```ts
import { getLastTimecode, getLastTimecodeAt, setLastTimecode } from '../timecode'
```
`startRecording()` 内、
```ts
    if (!canCaptureVideo()) {
      console.warn('[clip] canCaptureVideo false', { hasTarget: !!target, videoRect: target?.videoRect ?? null })
      sendBrowserNotice('warning', '動画を検出できませんでした。対応サイトの動画ページを開き、Chrome拡張機能が有効か確認してください。')
      return
    }
```
の直前に、鮮度チェックを追加：
```ts
    const CLIP_TIMECODE_MAX_AGE_MS = 1500
    if (!target && Date.now() - getLastTimecodeAt() > CLIP_TIMECODE_MAX_AGE_MS) {
      console.warn('[clip] stale timecode, aborting recording')
      sendBrowserNotice('warning', '動画を検出できませんでした。対応サイトの動画ページを開き、Chrome拡張機能が有効か確認してください。')
      return
    }
```
（`target` は `requestRecordingTarget()` の戻り値。null＝タイムアウトのケースだけ鮮度を見る。`target` が取れた場合は常に新鮮なので既存の `canCaptureVideo()` 判定へそのまま進む。）

- [ ] **Step 5（V-4）: typecheck**

```bash
npm run typecheck
```

- [ ] **Step 6（V-4）: コミット**

```bash
git add app/src/main/video/recording.ts
git commit -m "fix: 拡張無応答時に古いターゲット/メタデータのまま録画されるのを修正(V-4)"
```

- [ ] **Step 7（V-5, P2）: recorder.ts に音声なしフォールバックを追加**

`app/src/renderer/recorder.ts` の `getUserMedia` 呼び出し部分（49-71行目）を、音声+映像が失敗したら映像のみで再試行する形に変更：
```ts
window.recorderApi.onStart(async ({ sourceId, fps, maxSeconds }) => {
  if (recorder && recorder.state !== 'inactive') return
  const token = ++recordingToken

  let stream: MediaStream
  let audioFailed = false
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      audio: { mandatory: { chromeMediaSource: 'desktop' } } as any,
      video: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId }
      } as any
    })
  } catch (err) {
    console.warn('[recorder] audio+video getUserMedia failed, retrying video only', err)
    audioFailed = true
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId }
        } as any
      })
    } catch (err2) {
      console.error('[recorder] video-only getUserMedia also failed', err2)
      window.recorderApi.reportError(
        err2 instanceof DOMException && err2.name === 'NotAllowedError'
          ? 'getUserMedia_not_allowed'
          : 'getUserMedia_failed'
      )
      return
    }
  }
  if (token !== recordingToken) {
    cleanup(stream, null)
    return
  }
  if (audioFailed) window.recorderApi.reportError('audio_unavailable_fallback')
```
`reportError('audio_unavailable_fallback')` は main 側で warning 通知として扱う必要があるため、`app/src/main/video/recorder-ipc.ts` の `recorder:error` ハンドラに分岐を追加：
```ts
  ipcMain.on('recorder:error', (event, msg: string) => {
    if (!isTrustedRecorderSender(event)) return
    if (msg === 'audio_unavailable_fallback') {
      sendBrowserNotice('warning', '音声なしで録画しています（音声デバイスの初期化に失敗しました）。')
      return
    }
    finishRecordingState()
    if (msg === 'crop_unavailable') {
```
（`audio_unavailable_fallback` は録画自体は継続するため `finishRecordingState()` を呼ばない早期 return にする点に注意。）

- [ ] **Step 8（V-5）: typecheck**

```bash
npm run typecheck
```

- [ ] **Step 9（V-5）: コミット**

```bash
git add app/src/renderer/recorder.ts app/src/main/video/recorder-ipc.ts
git commit -m "fix: 音声キャプチャ失敗時に映像のみで録画継続するフォールバックを追加(V-5)"
```

- [ ] **Step 10（V-1, P1）: recorder.ts の中断経路で reportError('aborted') を送る**

`app/src/renderer/recorder.ts` の token 不一致で cleanup して return している箇所（Step 7 で書き換えた版で3箇所: `getUserMedia` 成功後、`getCrop` 後、`video.play()` 後）それぞれに `reportError('aborted')` を追加する。例（`getUserMedia` 成功直後）：
```ts
  if (token !== recordingToken) {
    cleanup(stream, null)
    window.recorderApi.reportError('aborted')
    return
  }
```
同様に `getCrop` 後・`video.play()` 後の2箇所（`cleanup(stream, null); resetState(); return` となっている箇所）にも `window.recorderApi.reportError('aborted')` を `resetState()` の前後どちらでもよいので追加する。

`onStop` ハンドラ（240-248行目）で `recorder` が未生成（null/inactive）だった経路にも送る：
```ts
window.recorderApi.onStop(() => {
  recordingToken++
  if (recorder?.state === 'recording') {
    recorder.stop()
  } else {
    cleanup(mediaStream, canvasStream)
    resetState()
    window.recorderApi.reportError('aborted')
  }
})
```

- [ ] **Step 11（V-1）: recorder-ipc.ts の recorder:error ハンドラに aborted 分岐を追加**

`recorder:error` ハンドラの先頭（Step 7 の `audio_unavailable_fallback` 分岐の直後）に追加：
```ts
    if (msg === 'aborted') {
      finishRecordingState()
      return
    }
```
（通知は出さず `finishRecordingState()` のみ。既存の `crop_unavailable`/`no_data`/`getUserMedia_not_allowed`/デフォルト分岐より前に置くことで、`aborted` のときは以降の通知分岐を通らないようにする。）

- [ ] **Step 12（V-1）: main 側のウォッチドッグを追加**

`app/src/main/video/recording.ts` の `startRecording()` で `getRecorderWindow()!.webContents.send('recorder:start', ...)` の直後に、タイムアウト保険を追加：
```ts
    const settings = loadSettings()
    const maxSeconds = settings.clipMaxSeconds ?? 60
    getRecorderWindow()!.webContents.send('recorder:start', {
      sourceId,
      fps: 30,
      maxSeconds
    })
    setTrayRecording(true)

    const watchdogToken = ++recordingWatchdogToken
    setTimeout(() => {
      if (watchdogToken !== recordingWatchdogToken) return
      if (!isRecording) return
      console.error('[clip] watchdog: recorder did not report done/error in time, forcing reset')
      finishRecordingState()
      sendBrowserNotice('error', '録画処理がタイムアウトしました。もう一度お試しください。')
    }, (maxSeconds + 30) * 1000)
```
モジュールスコープ（`let isRecording = false` の近く）に `let recordingWatchdogToken = 0` を追加する。`finishRecordingState()` の冒頭でも `recordingWatchdogToken++` してウォッチドッグを無効化する：
```ts
export function finishRecordingState(): void {
  recordingWatchdogToken++
  const wasRecording = isRecording
```
（`stopRecording()` 経路で正常に done/error が届いた場合も `finishRecordingState()` を経由するため、この一行でウォッチドッグは自動的に無効化される。）

- [ ] **Step 13（V-1）: typecheck**

```bash
npm run typecheck
```

- [ ] **Step 14（V-1）: コミット**

```bash
git add app/src/renderer/recorder.ts app/src/main/video/recorder-ipc.ts app/src/main/video/recording.ts
git commit -m "fix: 録画開始直後の停止で状態が固着するのを修正(V-1、renderer側abortedとmain側ウォッチドッグ)"
```

- [ ] **Step 15: 全体検証**

```bash
cd "c:/Users/eiji8/Documents/shiori/app"
npm run verify
```
手動確認: Alt+R を素早く2連打しても録画状態が固着せず、以後の Alt+S（スクショ）も正常に動くこと。拡張を切断した状態で Alt+R を押すと「動画を検出できませんでした」と出て誤録画しないこと。

---

### Task 9: パッケージビルド確認

**Files:** なし

- [ ] **Step 1: パッケージビルド**

```bash
cd "c:/Users/eiji8/Documents/shiori/app"
npm run package
```

- [ ] **Step 2: 生成された exe をインストールして動作確認**

`dist/` に生成された `Shiori-Setup-*.exe` をインストールし、packaged 環境で Alt+R 録画→トリミングが動くことを確認する（`ffmpeg-static` の `asarUnpack` 経由でのパス解決が本番構成でも通るかがここでの主眼）。問題があれば `app/src/main/video/ffmpeg.ts` の `getFfmpegPath()` のパス置換ロジックと Task 1 の `asarUnpack` 設定を見直す。
