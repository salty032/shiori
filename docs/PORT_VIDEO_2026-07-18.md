# 指示書: shiori-dev から動画キャプチャ機能を移植する（2026-07-18）

## ゴール

[shiori-dev](https://github.com/salty032/shiori-dev) にある動画機能一式
（**録画クリップ（Alt+R）・トリミング・ライブラリ内での動画再生**）を、
現在の shiori（v1.1.3, main ブランチ）へ移植する。
あわせて、shiori-dev の `docs/CODE_REVIEW_VIDEO_2026-07-07.md` で指摘済みの
**V-1（P1）と V-2 / V-4 / V-5（P2）を修正した状態で** 取り込む（詳細は §7）。

## 背景（必読）

- shiori-dev が元リポジトリで、そこから分離した shiori が v1.1.0〜v1.1.3 まで独自に進化した。
- **2つのリポジトリは git 履歴が繋がっていない**（`git merge-base` は共通祖先なし）。
  merge / cherry-pick は使えない。**新規ファイルのコピー＋既存ファイルへの手動配線**で移植する。
- **既存ファイルは shiori 側のほうが新しい。** dev との diff には動画と無関係な差分
  （theme / lastRunVersion / TagWithCount / versionMismatch / FK ガード / パッケージング改善など、
  shiori 側で後から入った変更）が大量に含まれる。
  **既存ファイルに dev の diff を丸写しすることは絶対にしない。** 動画関連の行だけを
  現在の shiori のコードに合わせて手で追加する（§6 に無視すべき差分の一覧あり）。
- dev には「capture 版 / full 版」のビルドフレーバー分割（`SHIORI_FLAVOR`、`*.full.*` エントリ、
  `electron-builder.full.json`）があるが、**shiori には持ち込まない**。shiori は常に動画入りの
  単一ビルドとする。ただし dev の feature registry（プラグイン機構）自体は小さく設計も良いので、
  それは持ち込む。

## 0. 準備

```powershell
cd c:\Users\eiji8\Documents\shiori
git checkout -b feature/video-port
git fetch https://github.com/salty032/shiori-dev main:refs/remotes/shiori-dev/main
```

以後、dev のファイル参照は `git show shiori-dev/main:<path>`、
新規ファイルの取り込みは `git checkout shiori-dev/main -- <path>` で行える。
参考として、レビュー文書も取り込んでおく：

```powershell
git checkout shiori-dev/main -- docs/CODE_REVIEW_VIDEO_2026-07-07.md
```

## 1. そのままコピーする新規ファイル（shiori に存在しないもの）

```
app/src/main/feature.ts                          # MainFeature インターフェース（10行）
app/src/main/video/clip-hotkey.ts
app/src/main/video/ffmpeg.ts
app/src/main/video/ffmpeg.test.ts
app/src/main/video/index.ts                      # videoFeature（MainFeature 実装）
app/src/main/video/ipc-video.ts
app/src/main/video/recorder-ipc.ts
app/src/main/video/recorder-window.ts
app/src/main/video/recording.ts
app/src/main/video-thumb-provider.ts
app/src/preload/video-api.ts
app/src/preload/recorder.ts                      # レコーダーウィンドウ専用 preload
app/src/renderer/recorder.html
app/src/renderer/recorder.ts                     # レコーダーウィンドウ本体（248行）
app/src/renderer/src/components/VideoPlayer.tsx
app/src/renderer/src/features/registry.ts        # レンダラー側拡張点
app/src/renderer/src/video/ClipHotkeySettings.tsx
app/src/renderer/src/video/VideoTrimmer.tsx
app/src/renderer/src/video/VideoTrimmerModal.tsx
app/src/renderer/src/video/api.ts
app/src/renderer/src/video/init.tsx              # registry への登録エントリ
app/src/renderer/src/video/trimStore.ts
app/src/shared/api.video.ts                      # VideoApi 型 + VIDEO_CH チャンネル定数
```

コピー後の調整：

- `shared/features.ts`（`appFlavor()` / `isVideoClipEnabled()`）は**持ち込まない**。
  コピーしたファイルがこれを import していたら、常に有効（`full` 相当）としてその分岐を除去する。
- `app/src/main/media-utils.ts`（色抽出）は動画機能とは無関係の dev 側リファクタなので**持ち込まない**。
- `recorder-ipc.ts` が呼ぶ `registerCapturedMedia`（`captured-media.ts`）は shiori 側のほうが新しい
  （`getImage` による FK ガードあり）。**shiori 側の現行シグネチャに合わせて呼び出しを調整**し、
  `captured-media.ts` 自体は dev の形に戻さないこと。
- `recording.ts` の依存（`ws-server` の `broadcastMessage`/`onExtensionMessage`、`capture.ts` の
  `canCaptureVideo`/`getBrowserWindowRect`/`setBrowserWindowPos`/`setVideoRect`/`addPreCaptureGuard`/
  `addBrowserTargetUpdateGuard`/`SilentCaptureAbort`、`windows.ts` の `handleTrusted`/`isMainWindowFocused`、
  `timecode.ts`、`hotkey.ts` の `normalizeCaptureHotkey`、`browser-notice.ts`）は
  **すべて shiori に存在することを確認済み**。import が通らない場合は名前・パスのずれを疑うこと。

## 2. コピーしないもの（フレーバー機構）

```
app/electron-builder.full.json
app/src/main/index.full.ts
app/src/preload/index.full.ts
app/src/renderer/index.full.html
app/src/renderer/src/main.full.tsx
app/src/shared/features.ts
app/src/main/media-utils.ts
```

これらの「full 版だけが読む」内容は、次節で通常のエントリに直接統合する。

## 3. 既存ファイルへの配線（すべて手動編集）

### 3.1 main プロセス

| ファイル | 変更内容 |
|---|---|
| `app/src/main/index.ts` | `bootstrap()` → `bootstrap([videoFeature])`（dev の `index.full.ts` 相当） |
| `app/src/main/bootstrap.ts` | シグネチャを `bootstrap(features: MainFeature[] = [])` に変更し、3箇所でフックを呼ぶ。位置は dev の `bootstrap.ts` を参照：IPC 登録群の末尾で `for (const f of features) f.registerIpc?.()`（dev L218）、whenReady 内・メインウィンドウ生成後に `for (const f of features) await f.onReady?.()`（dev L376）、before-quit で `f.onBeforeQuit?.()`（dev L406） |
| `app/src/main/bootstrap.ts`（capfile） | shiori の capfile ハンドラは Range 対応済み（動画シークに必要、変更不要）。ただし **Content-Type 判定**を dev 版（L99-166）と比較し、`.webm` / `.mp4` が `video/*` で返るよう差分があれば取り込む。`kind=thumb` が `thumb_path ?? filepath` へフォールバックする挙動も dev と一致するか確認 |
| `app/src/main/db.ts` | 既存の `addColumnIfMissing` 群に `media_type TEXT` / `duration REAL` を追加。`insertImage` と一覧クエリ（`mediaType` フィルタ）を dev の `db.ts` を参照して拡張。**shiori 側の現行実装（FTS5 等）を壊さず、動画関連の追加だけ行う** |
| `app/src/main/settings.ts` | `clipHotkey` / `clipMaxSeconds`（5〜300 に clamp、既定60）/ `clipNotify` の正規化・検証を dev の `settings.ts` から移植 |
| `app/src/main/tray.ts` | `setTrayRecording(bool)`（録画中のトレイ表示切替）を dev の `tray.ts` から移植 |
| `app/src/main/ipc-images.ts` `ipc-import.ts` `ipc-share.ts` | dev の同名ファイルにある `getVideoThumbProvider` の import と使用箇所（動画のサムネ生成/再生成、共有インポート時の duration 取得）を、shiori の現行コードの対応する位置に移植。`git diff HEAD shiori-dev/main -- <file>` で動画関連行だけ拾うこと |

補足：`videoFeature.onReady()` は `session.defaultSession.setPermissionRequestHandler` を
上書きして「レコーダーウィンドウの media 権限だけ許可」する。shiori 側 bootstrap の既定の
権限ハンドラ設定より**後**に feature の `onReady` が走る順序になっていることを確認する。

### 3.2 preload

| ファイル | 変更内容 |
|---|---|
| `app/src/preload/index.ts` | `contextBridge.exposeInMainWorld('api', { ...buildCoreApi(), ...buildVideoApi() })`（dev の `index.full.ts` 相当） |

### 3.3 renderer

| ファイル | 変更内容 |
|---|---|
| `app/src/renderer/src/main.tsx` | `App` の import より前に `import './video/init'` を追加（dev の `main.full.tsx` 相当） |
| `app/src/renderer/index.html` | CSP に `media-src capfile:` があること・ws ポートが一致することを確認（shiori は対応済みのはず。dev の `index.full.html` と CSP 行を比較） |
| `components/Viewer.tsx` | `media_type === 'video'` のとき `<VideoPlayer>` を表示（`<img>` の代わり）。アクション行に `getMediaActions(img, { close })` を挿入。dev の `Viewer.tsx` 参照 |
| `components/DetailPanel.tsx` | `getMediaActions(img)` の描画（トリミングボタンが出る）。dev 参照 |
| `components/ThumbCell.tsx` / `TimelineView.tsx` | 動画サムネの duration バッジ等、dev の diff から動画関連のみ移植 |
| `App.tsx` | `getModals()` の描画（VideoTrimmerModal がここから出る）とコンテキストメニューへの `getExtraContextMenuItems(img)` 統合。dev の `App.tsx` diff から動画関連のみ |
| `components/Toolbar.tsx` + `stores/filterStore.ts` + `hooks/useFilters.ts` + `stores/imageQuery.ts` | `mediaType`（画像/動画）フィルタを移植。**dev の diff に混ざっている `color`（スマートフォルダ色）関連は移植しない** |
| `components/SettingsModal.tsx` | `getSettingsSlots(tab)` の描画（`onCapturingChange` / `placement` の橋渡し込み）。「キャプチャ」タブに ClipHotkeySettings が出る。dev の `SettingsModal.tsx` 参照 |
| `hooks/useGlobalKeys.ts` | dev の diff を確認し、トリマー表示中のキー抑止など動画関連があれば移植 |
| `utils.ts` + `utils.test.ts` | `thumbSrc` は shiori に存在済み。dev 版（`media_type` 対応・`mediaSrc`）との差分を確認して不足分とテストを移植 |
| `shared/types.ts` | `ImageRow` に `media_type: 'image' \| 'video' \| null` と `duration: number \| null`、`ImageQuery` に `mediaType?: 'image' \| 'video'`、`Settings` に `clipHotkey: string` / `clipMaxSeconds: number` / `clipNotify: boolean` を追加。**それ以外の差分（`SmartFolder.color`、`TagWithCount` 削除、`Theme` 削除等）は触らない** |
| `shared/settingsDefaults.ts` | `clipHotkey: 'Alt+R'`, `clipMaxSeconds: 60`, `clipNotify: true` を追加。既存の `theme` / `lastRunVersion` 等は残す |

### 3.4 ビルド設定

| ファイル | 変更内容 |
|---|---|
| `app/package.json` | dependencies に `ffmpeg-static: ^5.3.0` と `fix-webm-duration: ^1.0.6` を追加（`cross-env` は不要）。`build.files` にこれらの除外を**入れない**こと。`build` セクションに `"asarUnpack": ["node_modules/ffmpeg-static/**"]` を追加（dev の `electron-builder.full.json` 参照。`ffmpeg.ts` が packaged 時に `app.asar` → `app.asar.unpacked` へパス置換するため必須） |
| `app/electron.vite.config.ts` | preload の input に `recorder: resolve('src/preload/recorder.ts')`、renderer の input に `recorder: resolve('src/renderer/recorder.html')` を**無条件で**追加。`SHIORI_FLAVOR` の define 機構は入れない |

### 3.5 拡張機能（extension/）

**変更不要。** shiori の拡張は `request-timecode` の `immediate` フラグ対応済み
（`content.js` の `sendTimecodeNow`、`background.js`）で、録画側が必要とする応答
（`videoRect` / ウィンドウ位置つき timecode）も返せる。念のため
`git diff HEAD shiori-dev/main -- extension/` に録画専用の処理がないか目視確認だけすること。

## 4. DB マイグレーション

`addColumnIfMissing` 方式（`db.ts` 既存パターン）に従う：

```sql
ALTER TABLE images ADD COLUMN media_type TEXT   -- 'image' | 'video'、NULL は image 扱い
ALTER TABLE images ADD COLUMN duration REAL     -- 動画のみ。秒
```

既存レコードは NULL のままで良い（読み出し側は NULL を image として扱う。dev の実装に準拠）。

## 5. 実装順序（推奨）

1. **土台**: §3.4（deps・vite 設定）→ §1 の main 側ファイルコピー → `feature.ts` + bootstrap 配線 → `index.ts`
2. **データ層**: types / settingsDefaults / settings.ts / db.ts
3. **録画経路を通す**: tray / capfile 確認 / preload 配線 → この時点で Alt+R 録画→保存が動くはず
4. **renderer**: registry + video/ コピー → main.tsx → Viewer / DetailPanel / ThumbCell / App / Toolbar / SettingsModal
5. **サムネ・共有連携**: ipc-images / ipc-import / ipc-share の video-thumb-provider 配線
6. **§7 のバグ修正**
7. **§8 の検証**

各フェーズ完了ごとに `npm run verify`（typecheck + vitest）を通すこと。

## 6. 移植してはいけない dev 側差分（誤爆防止リスト)

`git diff HEAD shiori-dev/main` には以下の**動画と無関係な差分**が含まれる。これらは shiori 側が正。

- `package.json`: version（1.1.3 が正）、`ext:lint`/`ext:sign` スクリプト、`artifactName`・license 同梱などのパッケージング改善、`@testing-library/react`/`jsdom` devDeps
- `shared/types.ts`: `TagWithCount`・`Theme`・`lastRunVersion`・`versionMismatch`（すべて shiori 側にのみ存在。残す）、`SmartFolder.color`（dev 側の別機能。持ち込まない）
- `captured-media.ts`: `getImage` FK ガードと `await canAutoTag()`（shiori 側が正）
- `settingsDefaults.ts`: `showAiTags` / `theme` / `lastRunVersion`（残す）
- extension のアイコン群・`netflix-main.js`・`.amo-upload-uuid`（shiori 側が正）
- `busy.ts` / `ipc-drag.ts` / `share-entry.ts` / `startup.ts` / `timecode-request.ts` 等、shiori にのみ存在するファイル（触らない）
- UI コンポーネントの diff のうち、スタイル・リファクタ・`color` フィルタなど動画に関係ない行

判断基準：**その行が `media_type` / `duration` / `clip*` / `video*` / `recorder*` / registry の
どれにも関係しないなら移植しない。**

## 7. 織り込むバグ修正（CODE_REVIEW_VIDEO_2026-07-07.md より）

対象は V-1 / V-2 / V-4 / V-5 の4件。詳細な現状分析は `docs/CODE_REVIEW_VIDEO_2026-07-07.md`
（§0 で取り込み済み）を必ず読むこと。以下は修正方針の要約。

- **V-1 (P1) 録画開始直後の停止で録画状態が永久固着**
  `recorder.ts`（renderer）: token 不一致で中断する全経路と、`onStop` で `recorder` 未生成だった
  経路から `reportError('aborted')` を送る。main の `recorder:error` ハンドラは `aborted` を
  「通知なしで `finishRecordingState()` のみ」として扱う。
  さらに main 側の保険として `recorder:start` 送信後 `maxSeconds + 30s` のウォッチドッグを張り、
  `done` / `error` どちらも来なければ `finishRecordingState()` + エラー通知。
- **V-2 (P2) `recorder:done` でディレクトリ作成失敗するとクリップが通知なしで消える**
  `recorder-ipc.ts`: `ensureCaptureSubDir` の呼び出しを try ブロックの中へ移動。
- **V-4 (P2) 拡張が無応答のとき古いターゲット・古いメタデータで録画される**
  `recording.ts` の `startRecording()`: `requestRecordingTarget()` が null（タイムアウト）の場合、
  最終 timecode の鮮度を確認し、古ければ録画を中止して「動画を検出できませんでした」通知。
  **shiori には `getLastTimecodeAt()`（`timecode.ts`）が既にあるので、それを使う**
  （スクショ側の鮮度チェックが bootstrap.ts で同じことをしている。しきい値もそちらに合わせる）。
- **V-5 (P2) 音声キャプチャ失敗で録画全体が失敗する**
  `recorder.ts`（renderer）: audio+video の `getUserMedia` が失敗したら video のみで一度リトライし、
  成功したら「音声なしで録画しています」warning を通知。それも失敗した場合のみエラー終了。

V-3 / V-6〜V-19 は今回のスコープ外（移植後に別途対応）。ただし実装中に該当箇所を
触る場合に限り、ついでに直して良い（コミットは分けること）。

## 8. 検証

1. `npm run verify`（typecheck + vitest。移植した `ffmpeg.test.ts`・`utils.test.ts` 追加分を含めて全パス）
2. 手動確認（`dev.bat` で起動、拡張を接続した状態で）：
   - Alt+R で録画開始 → トレイが録画中表示 → Alt+R で停止 → クリップがライブラリに登録され、
     タイトル・タイムコード・URL が付き、サムネと duration が表示される
   - 再生：グリッドから開いて VideoPlayer でシークできる（Range 対応の確認）
   - トリミング：コンテキストメニュー／詳細パネルからトリマーを開き、範囲指定 → 保存で新クリップが増える
   - **V-1**: Alt+R を素早く2連打しても状態が固着せず、以後のスクショ（Alt+S）も正常
   - **V-4**: 拡張を切断した状態で Alt+R → 「動画を検出できませんでした」通知（誤録画しない）
   - 設定：「キャプチャ」タブにクリップホットキー設定が表示され、変更が反映される
   - 画像/動画フィルタが効く。既存の画像機能（キャプチャ・タグ・共有・エクスポート）に退行がない
3. パッケージ確認：`npm run package` で作った exe で録画→トリミングが動く
   （asarUnpack した ffmpeg のパス解決の確認。ここが packaged 専用の壊れポイント）

## 9. コミット方針

フェーズごと（§5 の 1〜6）に分けてコミットする。メッセージは日本語、既存の履歴の流儀に合わせる。
マージは行わず、`feature/video-port` ブランチのままレビュー待ちにすること。
