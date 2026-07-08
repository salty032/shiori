# コードレビュー（v1.0.4 リリース後・全体レビュー）

- 実施日: 2026-07-07
- 対象: リポジトリ全体（main プロセス / renderer / Chrome 拡張 / ビルド設定）を全ファイル通読
- 目的: 機能ごとの詳細レビュー。**修正は別モデルが行う前提**で、指摘ごとに再現条件・修正方針を記載する
- 既存の [RELEASE-REVIEW.md](RELEASE-REVIEW.md)（v1.0.3 時点）と重複する指摘は省いた

## 総評

セキュリティ（IPC 送信元検証・パス三重ガード・WS オリジン許可リスト・モデル SHA-256 ピン）、
競合対策（世代カウンタ・タガー直列化・キャプチャ再入防止・削除の Undo 猶予）はいずれも
高水準で、リリースを妨げる致命傷はない。以下は**実ユーザーが踏みうるバグ 3 件**と、
UX・整合性の改善提案。番号順に優先度が高い。

---

## A. バグ（ユーザーが実際に踏む）

### A-1. 拡張のコマ送りキーがテキスト入力中の Shift+←/→ を乗っ取る

- 場所: [content.js:994-1004](extension/content.js#L994-L1004)
- 症状: 対応サイトの**テキスト入力欄**（YouTube の検索ボックス・コメント欄、niconico のコメント入力等）で
  Shift+←/→ による**テキスト範囲選択が一切できない**。押した瞬間に `preventDefault` され、
  裏で動画が一時停止してコマ送りされる。
- 原因: keydown ハンドラ（capture フェーズ）が編集中ターゲットの除外をしていない。
  アプリ側の useSelection / useGlobalKeys は全て `isEditing` 判定をしているのに、拡張側だけ抜けている。
- 修正方針: ハンドラ冒頭に編集中判定を追加して素通しする。
  ```js
  const t = e.target
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  ```
  ※ `e.composedPath()[0]` を見ると Shadow DOM 内の入力（Disney+ 等）も拾える。可能ならそちらを優先。
- 確認: YouTube 動画ページの検索ボックスで Shift+← が文字選択になり、動画が止まらないこと。
  入力欄以外では従来どおりコマ送りが動くこと。

### A-2. ライブラリ書き出しの settings.json（スマートフォルダ）が読み込み側で無視される

- 場所: 書き出し [ipc-share.ts:83-88](app/src/main/ipc-share.ts#L83-L88) / 読み込み [ipc-share.ts:95-195](app/src/main/ipc-share.ts#L95-L195)
- 症状: 「ライブラリを書き出す」はスマートフォルダを `settings.json` として保存するが、
  「ライブラリを読み込む」は `metadata.jsonl` しか読まないため、**スマートフォルダは永遠に取り込まれない**。
  ファイル冒頭コメント（1行目）自身が「スマートフォルダ設定の取り込み」を責務として謳っており、実装漏れ。
- 修正方針: shareImport で `join(srcDir, 'settings.json')` を読み、`smartFolders` を検証
  （[settings.ts](app/src/main/settings.ts) の `smartFolders()` 正規化関数を export して再利用）した上で、
  既存の `loadSettings().smartFolders` に **id 重複を避けてマージ**して `saveSettings`。
  取り込んだ件数を戻り値に足し、renderer 側（[SettingsModal.tsx:351-366](app/src/renderer/src/components/SettingsModal.tsx#L351-L366) と
  [App.tsx:701-714](app/src/renderer/src/App.tsx#L701-L714)）で settings を再取得して表示に反映する
  （renderer の settingsStore は main の保存値と乖離するので、`getSettings()` を呼び直すこと）。
- 注意: A-3 の色フィルタを削除しない場合、`folder.color` 持ちのフォルダを取り込むと
  「開いても 0 件・理由が見えない」状態になる（下記 A-3 参照）。マージ時に `color: null` へ落とすのが安全。

### A-3. 色フィルタ機能が「設定 UI なし・データも常に NULL」の死に機能として残っている

- 場所（残骸の全リスト）:
  - DB: `colors` カラム / [db.ts:281-306](app/src/main/db.ts#L281-L306) `colorDist`・`listColors`・`_colorsCache` / `buildImageFilter` の `f.color`（[db.ts:251](app/src/main/db.ts#L251)）
  - IPC: `imagesListColors`（[ipc-images.ts:69](app/src/main/ipc-images.ts#L69)）、`optionalColor`（[ipc-validation.ts:42](app/src/main/ipc-validation.ts#L42)）
  - renderer: `filterStore` の `colorFilter`/`allColors`/`setAllColors`、[Toolbar.tsx:252-254](app/src/renderer/src/components/Toolbar.tsx#L252-L254) の解除チップ、`SmartFolder.color`
- 事実確認: `colors` はキャプチャ / クリップボード / フォルダ取り込み / 共有取り込みの**全挿入経路で `null` 固定**。
  色を抽出する処理も、`setColorFilter` に非 null を渡す UI も存在しない（呼び出しは解除の `null` のみ）。
  唯一 full 版時代の settings.json に `color` 付きスマートフォルダが残っていた場合だけ発火し、
  その場合 `colors LIKE ...` が全行 NULL に対して走って**必ず 0 件**になる。画面には色チップも出ないため、
  ユーザーには「このフォルダを開くと何も表示されない」ようにしか見えない。
- 修正方針（どちらか。**推奨は前者**）:
  1. 残骸を一括削除する: 上記リスト＋ `Settings`/`SmartFolder` 型の `color` を撤去し、
     `normalizeSettings` は既存 settings.json の `color` を黙って捨てる。
  2. 機能として復活させる: キャプチャ/サムネ生成時に代表色を抽出して `colors` に保存し、
     サイドバー等に色パレット UI を追加する（工数大）。
- 確認: 1 を選んだ場合、`npm run verify` と、色付きフォルダを含む旧 settings.json を置いた状態での起動
  （正規化で無害化されること）。

---

## B. UX・整合性（中優先度）

### B-1. フォルダドロップ取り込みで一部失敗してもトーストが成功一色

- 場所: [App.tsx:137-154](app/src/renderer/src/App.tsx#L137-L154) `handleFileDrop`
- 症状: 10 ファイル中 3 件が失敗（非対応拡張子・コピー失敗等）でも `count > 0` なら
  「7枚をインポートしました」の success だけが出て、**失敗 3 件はユーザーに一切伝わらない**
  （`result.errors` は count===0 のときしか使われない）。
- 修正方針: `errors.length > 0` なら文言に「（N件は取り込めませんでした）」を足し、tone を warning に。
  200 件上限の truncated 表示と同じ流儀で。

### B-2. 「既存画像にタグ付け」だけ原本フル解像度で推論しており、キャプチャ時と結果がズレる

- 場所: [ipc-tagger.ts:79-94](app/src/main/ipc-tagger.ts#L79-L94)
- 内容: キャプチャ・取り込み時の自動タグ付けは 480px サムネで推論する
  （[bootstrap.ts:334](app/src/main/bootstrap.ts#L334) `autoTag.path = thumbPath`）のに、
  retagAll は `filepath`（原本）を使う。`listImagesForRetag` が `thumb_path` を SELECT しているのに未使用。
  同じ画像でも経路によって付くタグが変わりうる上、原本 PNG のデコード＋448px 縮小のぶん一括処理が遅い。
- 修正方針: retagAll も `thumb_path ?? filepath` を使う（`resolveRealCapturePath` を通す既存の流れのまま）。

### B-3. 素のキーワード検索が 1 打鍵ごとにフルクエリ＋選択クリアを起こす（コメントと実装の乖離）

- 場所: [Toolbar.tsx:273-279](app/src/renderer/src/components/Toolbar.tsx#L273-L279) と
  [Toolbar.tsx:302](app/src/renderer/src/components/Toolbar.tsx#L302) のコメント
- 内容: onChange で `isPureKeywordSearch` なら即 `commitSearch` するため、1 文字打つたびに
  FTS 検索＋COUNT の IPC が 2 本走り、queryKey 変化で**選択も毎打鍵クリア**される。
  302 行目のコメントは「Enter は 200ms デバウンスを待たず」と**存在しないデバウンス**に言及しており、
  実装からデバウンスが失われた形跡がある。
- 修正方針: commitSearch 呼び出しを 200ms 程度のトレーリングデバウンスにする（Enter・サジェスト確定・
  チップ操作は即時のまま）。IME は `searchComposing` が既にあるので composition 終了時にも確定を流す。

### B-4. トレイ常駐なのに更新確認が起動時 1 回だけ

- 場所: [updater.ts:25-29](app/src/main/updater.ts#L25-L29)
- 内容: 「次回起動時にまとめて確認する方針」とコメントされているが、このアプリはトレイ常駐で
  ウィンドウを閉じても終了しない設計（README にも明記）。PC を点けっぱなしのユーザーは
  **何週間も更新通知を受け取れない**。方針とアプリの性質が噛み合っていない。
- 修正方針: `setInterval` で 24h ごと、またはメインウィンドウ `show` 時に再確認
  （`lastNotifiedVersion` ガードは既にあるので多重通知はしない）。

### B-5. ビューアの画像切り替えで白フラッシュ（フル解像度のデコード待ち）

- 場所: [Viewer.tsx:246-259](app/src/renderer/src/components/Viewer.tsx#L246-L259)
- 内容: `<img src={mediaUrl(img.id)}>` を直接差し替えるため、大きい PNG では矢印キー移動時に
  デコード完了まで空白になる。DetailPanel は同じ問題を「サムネ先行表示→原本差し替え」（R-7）で
  解決済みなのに、ビューアは未対応。
- 修正方針: DetailPanel と同じ 2 段表示（`thumbSrc` を即表示し、`new Image()` の preload 完了で原本へ）＋
  `index±1` の原本を先読みしておく。

### B-6. 選択エクスポート中と共有書き出し中の同時実行で進捗・中止が混線する

- 場所: [exportStore.ts](app/src/renderer/src/stores/exportStore.ts) / [App.tsx:465-492](app/src/renderer/src/App.tsx#L465-L492)
- 内容: `export:progress` チャンネルと exportStore は 1 系統しかないため、選択エクスポート中に
  設定画面から「ライブラリを書き出す」を開始すると進捗バーが混ざり、「中止」ボタンは後勝ちの
  `exportKind` 側しかキャンセルできない。
- 修正方針: いずれかの実行中はもう一方のボタンを disabled にするのが最小修正
  （exportStore に `exportKind !== null` を見るだけで済む）。

### B-7. 一括削除が 1 枚ずつ IPC（最大数千往復）

- 場所: [useSelection.ts:80-95](app/src/renderer/src/hooks/useSelection.ts#L80-L95)
- 内容: `deleteImage(id)` を同時実行数 4 で回すため、数千枚の削除は分単位。
  ゴミ箱移動（shell）が 1 件ずつなのは Windows 都合として妥当だが、**DB 削除まで 1 行ずつ**なのは無駄。
- 修正方針: `images:deleteBulk(ids)` を追加し、main 側で「DB は 1 トランザクションで一括削除 →
  ゴミ箱移動は逐次ベストエフォート＋進捗イベント」にする。既存の「DB 先行・ファイル後始末」の
  設計思想はそのまま保てる。

### B-8. 「元に戻す」トーストが後続トーストに押し出されると Undo 手段が見えなくなる

- 場所: [useToast.ts:70-82](app/src/renderer/src/hooks/useToast.ts#L70-L82)（MAX_TOASTS=3 の追い出し）
- 内容: 削除直後にキャプチャ完了などが 3 連続すると、猶予 4 秒が残っているのに
  「元に戻す」ボタンごと画面から消える（Ctrl+Z は効くが気付けない）。
- 修正方針: `action` 付きトーストは追い出し対象から除外する（先に action なしの最古を落とす）。

---

## C. 低優先度・小粒

### C-1. Netflix コマ送りの尺超過シークに上限クランプがない
[content.js:97-101](extension/content.js#L97-L101) `seekVideo` は `Math.max(0, …)` だけで上限がない。
[NETFLIX-FRAMESTEP-ISSUE.md](NETFLIX-FRAMESTEP-ISSUE.md) 候補 D のとおり、末尾付近の前方ステップで
尺超えの ms を内部 API に渡しうる。`video.duration` が有限なら `Math.min(duration - 0.1, t)` でクランプ
しておくのが安全（本命候補 A/B の切り分けとは独立に、先に潰せる）。
なお同メモは未コミット（untracked）。issue として残すならコミットするか、GitHub Issues へ移すこと。

### C-2. サムネサイズ設定に旧値が残ると S/M/L が全部非アクティブ
[Sidebar.tsx:342-348](app/src/renderer/src/components/Sidebar.tsx#L342-L348)。settings.json の
`thumbnailSize` は 80–360 を許容するが UI は 120/160/220 の 3 択。旧版・手編集で別値が入っていると
`indexOf === -1` でハイライトだけ S 位置に出て、どのボタンもアクティブにならない。
最近傍値へスナップして表示（または保存時に 3 値へ正規化）する。

### C-3. ConfirmDialog: フォーカスが「キャンセル」にあっても Enter で確定される
[ConfirmDialog.tsx:26-41](app/src/renderer/src/components/ConfirmDialog.tsx#L26-L41)。capture フェーズで
Enter を一律 confirm に割り当てているため、Tab でキャンセルへフォーカスして Enter しても削除が走る。
`document.activeElement` がボタンなら素通しする。ついでに effect の依存配列が無く毎レンダー再登録
なので `[busy]` を付ける。

### C-4. トレイアイコンが 16px 単一で HiDPI だとぼやける
[tray.ts:22-24](app/src/main/tray.ts#L22-L24)。32px 版も用意して
`trayIcon.addRepresentation({ scaleFactor: 2, ... })` で持たせる。

### C-5. 共有バンドルの再取り込みで丸ごと重複する
[ipc-share.ts:95-](app/src/main/ipc-share.ts#L95) shareImport は同じフォルダを 2 回読み込むと全件複製される。
最低限、確認ダイアログ文言（SettingsModal の hint）に「再読み込みすると重複します」と書く。
理想はエントリ単位のハッシュ（元 filename + captured_at）で既取り込みをスキップ。

### C-6. タイムラインの ↑↓ ナビがグループ境界で列ズレする
[App.tsx:176-180](app/src/renderer/src/App.tsx#L176-L180) の `navigationColumnsRef` はフラット配列に
列数演算するだけなので、グループ末尾の欠け行をまたぐと視覚位置と一致しない（既知の近似）。
直すならグループ内 (row, col) を保った移動に変える。優先度は低い。

### C-7. 設定「データ」タブの書き出し説明が対象範囲を言っていない
[SettingsModal.tsx:316](app/src/renderer/src/components/SettingsModal.tsx#L316)。書き出しは
`source='capture'` のみ（[db.ts:480](app/src/main/db.ts#L480)）で取り込み画像は含まれないが、
UI の説明文からは分からない。「（ローカル取り込み分は含まれません）」を追記。

### C-8. `T` キー（クイックタグ）がどこにも案内されていない
[useGlobalKeys.ts:71](app/src/renderer/src/hooks/useGlobalKeys.ts#L71)。`/` は検索プレースホルダーに
案内があるが T は無い。DetailPanel のタグ見出しか空状態ヒントに「T: 選択中にタグ追加」を足す。

---

## D. 確認して問題なしと判断した点（再調査不要）

- capfile プロトコル: id 経由解決・Range 対応・拡張子ホワイトリストとも妥当
- computeVideoCrop の DPI/最大化/縦タブ補正: コメントどおりの実装で境界処理も整合
- タガーのアイドル解放・削除・ダウンロード中断のレース: チェーン直列化で全経路閉じている
- 削除の「DB 先行 → ファイル後始末」順序と Undo スナップショット復元
- FTS5 trigram + 3 文字未満 LIKE フォールバック、`escapeLike`/ESCAPE 句の対応
- 検索演算子（tag:/site:/from:/to:）のパース・チップ・履歴・サジェストの一貫性
- 拡張⇔SW⇔WS の双方向バリデーション対称性、UI 非表示のウォッチドッグ（8 秒）
- prefers-reduced-motion 対応、フォーカスリング、role=switch などのアクセシビリティ配慮

## 推奨対応順

1. A-1（拡張のキー乗っ取り。ユーザー被害が明確・修正 3 行）
2. A-2（共有機能の実装漏れ）＋ C-5 の文言
3. A-3（死に機能の掃除。A-2 と同時にやると settings 正規化を 1 回で済ませられる）
4. B-1 / B-3 / B-4（小さく効く UX 修正）
5. 残りは任意。修正のたびに `npm run verify`（typecheck + 235 tests）を回すこと。
