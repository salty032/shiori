# CODE-REVIEW 2026-07-10（UI/UX 重点 + バグ/セキュリティ/設計）

対象: v1.0.4 時点のコードベース全体。
Part 1 は UI/UX（renderer）、Part 2 はバグ・回帰リスク / セキュリティ / 仕様・設計とのズレ。
main プロセス・IPC・WS サーバー・拡張・共有インポート/エクスポート・レンダラーのストア/フックを通読済み。

凡例: **高** = 機能が実質壊れている / **中** = 体験・整合性を確実に改善する / **低** = 磨き込み

---

# Part 1: UI/UX

## 中

### U-2. 絞り込み結果ゼロの空状態に「解除」導線がない

**場所**: `app/src/renderer/src/App.tsx:579-581`（グリッド）、
`app/src/renderer/src/components/TimelineView.tsx:107-110`（タイムライン）

フィルタ有効時の空状態は「該当する画像がありません」の 1 行のみで行き止まり。
リカバリーには検索欄右端の小さな ✕ を探す必要がある。初回起動時の空状態
（手順 + ボタン 2 つ + ヒント）が丁寧に作り込まれているのと対照的。

**修正**: 「絞り込みを解除」ボタンを 1 つ追加し `filters.clearAllFilters()` を呼ぶ。
グリッド側は `s.emptyBtn` スタイルを流用できる。TimelineView 側は `hasActiveFilter`
しか受け取っていないので、`onClearFilters?: () => void` を props に足すか、
空状態の描画を App.tsx 側（グリッドと共通）へ寄せる。

### U-3. ショートカットの発見可能性が低い

**場所**: アプリ全体（`useGlobalKeys.ts` / `useSelection.ts` / `Viewer.tsx`）

`/`・`T`・`Ctrl+,`・`Ctrl+C`・`Ctrl+V`・`Ctrl+A`・`Delete`・`Ctrl+Z/Y`・矢印・Ctrl+矢印・
Shift+クリック、ビューア内の `Space`/`Tab`/`+ - 0`/`Home/End` と隠しショートカットが充実しているが、
一覧できる場所がない（DetailPanel 空状態の 3 行ヒントと title 属性に散在するだけ）。

**修正案**（どちらか）:
1. SettingsModal に「ショートカット」タブを追加（静的な表を出すだけ。実装が最も安全）
2. `?` キーでチートシートオーバーレイ表示（`useGlobalKeys` に追加。`isEditingTarget` ガード必須）

### U-4. SettingsModal / QuickTagInput にフォーカストラップがない

**場所**: `app/src/renderer/src/components/SettingsModal.tsx:117-118`、
`app/src/renderer/src/components/QuickTagInput.tsx:79`

`ConfirmDialog.tsx:61` は `role="dialog" aria-modal="true"` を持つが、SettingsModal と
QuickTagInput にはどちらもなく、フォーカストラップも無い。キーイベントの window 伝搬は
遮断していても（SettingsModal.tsx:73-80）、**Tab キーによるフォーカス移動自体は防げない**ため、
モーダル表示中に Tab で背後のグリッド/サイドバーのボタンへフォーカスが抜け、
Enter で背後のボタンが押せてしまう。

**修正**: 両モーダルに `role="dialog" aria-modal="true"` を付与し、Tab/Shift+Tab を
モーダル内の focusable 要素でループさせる（keydown で先頭/末尾を判定して preventDefault +
手動 focus する 20 行程度の処理で十分。ライブラリ不要）。

### U-5. スマートフォルダの並べ替えに視覚的な手がかりがない

**場所**: `app/src/renderer/src/components/Sidebar.tsx:73`（handleSmartFolderPressStart）

長押し 350ms でドラッグ開始という実装は堅牢だが、ホバー時のカーソルは通常のまま・
title は `folder.name` のみで、機能の存在に気づく手段がない。

**修正**（小さい順にどれか / 併用可）:
- `smartFolderBtn` の title を「（長押しで並べ替え）」を含む文言にする
- 行ホバーで `cursor: grab` にする（ドラッグ中の `grabbing` は実装済み）

## 低

### U-6. ビューアの End キーが「読み込み済みの末尾」に飛ぶ

**場所**: `app/src/renderer/src/components/Viewer.tsx:89-92`

グリッドの無限スクロール中、`End` は `images.length - 1`（読み込み済み分の末尾）へ移動する一方、
カウンタは `total`（全体数）を表示するため「End を押したのに 120 / 3000」という見え方になる。
後続ロードで辿れるので実害は小さいが、挙動と表示が食い違う。
最小の対処は End 時に `imageList.requestMore()` を促す or title を「読み込み済みの最後へ」にする。

### U-7. ContextMenu がキーボード非対応

**場所**: `app/src/renderer/src/components/ContextMenu.tsx`

↑↓/Enter での項目選択ができない（Escape で閉じるのみ）。右クリック起点なので優先度は低いが、
キーボード対応が徹底されているアプリの中では目立つ。実装するなら highlightedIndex state +
keydown リスナー（既存の Escape リスナーと同じ場所）で足りる。

### U-8. DetailPanel の `viewerOpen` prop が未使用

**場所**: `app/src/renderer/src/components/DetailPanel.tsx:17,41`

受け取って破棄しているだけのデッドコード。Props 型・分割代入・App.tsx:732 の受け渡しの
3 箇所を削除する。

### U-9. トーストの EXIT_MS とアニメーション秒数の不一致

**場所**: `app/src/renderer/src/hooks/useToast.ts:22-23`、`App.tsx:652`

コメントは「App.tsx の shioriToastOut 指定秒数と合わせる」だが、実際は EXIT_MS=300ms に対し
アニメーションは 0.2s。`forwards` のおかげで見た目は壊れていない（透明のまま 100ms 残るだけ）が、
コメントと実装がズレている。EXIT_MS を 200 にするか、両方 250ms 等に揃える。

### U-10. テキストグリフと SVG アイコンの混在

**場所**: `Toolbar.tsx:434`（ソートボタンの `▾`）、`Viewer.tsx:272`（閉じるの `✕`）、
`App.tsx:506`（バナー閉じるの `✕`）

他は `Icon.tsx` の SVG コンポーネントに揃っている。C-1（トークン集約）の流れで
ChevronDownIcon / XIcon に置き換えると統一感が出る。純粋な見た目の磨き込み。

---

# Part 2: バグ・回帰リスク / セキュリティ / 仕様・設計とのズレ

## バグ・回帰リスク

### B-3. 【低】Ctrl+A（全選択）の非同期解決がフィルタ変更後に着弾するレース

**場所**: `app/src/renderer/src/hooks/useSelection.ts:566-579`

Ctrl+A は `listAllImages` を非同期で取得して選択を組み立てるが、解決を待つ間に
フィルタを変更すると、`filterQueryKey` 変化による選択クリアの**後に**古いクエリの
ID 集合で `setSelectedIds` が走り、新しいフィルタ表示の上に旧フィルタの選択が復活する。

**修正**: 発行時点の `filterQueryKey`（`selectQueryKey(useFilterStore.getState())`）を捕捉し、
resolve 時に現在値と一致する場合のみ反映する。

## セキュリティ

結論から言うと、**指摘すべき実害のある問題は見つからなかった**。個人配布の Electron アプリとしては
異例に堅牢で、以下が確認できた（修正担当者は変更時にこれらを壊さないこと）:

- **プロセス分離**: `app.enableSandbox()` + `contextIsolation` + `nodeIntegration: false` +
  permission request/check ハンドラ全拒否（bootstrap.ts:84-85）+ `will-navigate` ガード +
  `setWindowOpenHandler` deny（windows.ts）
- **IPC**: 全ハンドラが `handleTrusted`（sender の webContents ID + frame URL 検証）経由。
  引数は `ipc-validation.ts` で型・範囲・長さを正規化
- **パス防御**: `resolveRealCapturePath` が resolve → realpath → 許可ベース配下チェック →
  拡張子 allowlist の多段。共有インポートは `basename(entry.file) === entry.file` の
  等価チェックでトラバーサル不能。`capfile://` プロトコルも ID → DB → 同関数経由のみ
- **WSサーバー**: 127.0.0.1 バインド + Origin の chrome-extension ID allowlist（HTTP/WS 両方）+
  16KB ペイロード上限 + 全フィールドの型/範囲検証（拡張側 background.js にも同じ検証が対で存在）。
  Origin ヘッダはローカルの非ブラウザプロセスなら偽装可能だが、同一ユーザーのローカルプロセスは
  脅威モデル外であり、受け渡しデータ（タイムコード・座標・タイトル）に機微性もないため妥当
- **供給網**: WD Tagger モデルは SHA-256 ピン留め + サイズ上限 + tmp→rename、
  自動更新は autoDownload 無効（通知のみ）、拡張は manifest `key` で ID 固定
- **その他**: `safeExternalUrl` が http/https 限定 + 認証情報除去、settings.json はアトミック書き込み +
  破損時退避、拡張の通知描画は `textContent` のみ（XSS シンクなし）

補足（対応不要の既知留意点）: 未署名ビルドであること自体が最大のリスク要因だが、
これは README で明示済みの運用判断であり、コード側の問題ではない。

## 仕様・設計とのズレ

### D-2. 【低】共有インポートに進捗表示がない

**場所**: `app/src/main/ipc-share.ts:117-239`、`SettingsModal.tsx:354-371`

エクスポートは `export:progress` → 画面下部の進捗バー + 中止ボタンがあるのに、
インポートは件数無制限（B-2 で打ち切りキャップ撤廃済み）のファイルコピー + DB 登録を
ボタンラベルの「読み込み中...」だけで待たせる（中止手段もない）。エクスポートと同じ
`exportProgress` の枠組みに乗せるか、少なくとも件数進捗をイベントで流すと対称になる。

### D-3. 【低】タイムライン表示中のサイドバー件数が 5000 で頭打ち

**場所**: `app/src/renderer/src/App.tsx:514`

グリッド表示中は `imageList.totalCount`（COUNT クエリの真値）を出すのに、タイムライン表示中は
`timeline.images.length`（`MAX_TIMELINE_LIMIT`=5000 でキャップ済み）を出すため、
5000 件超のライブラリではビュー切替で件数表示が変わる。切り詰めトースト（B10）は出るが、
件数ラベル自体も `useTimeline` で `countImages` を並行取得して真値を出すのが一貫する
（`reloadTimeline` は既に count を取得しているので流用できる）。

---

# Part 3: セキュリティ（深掘り） / テスト不足 / 保守性

## セキュリティ（2回目: CSP・拡張MAIN world・依存関係）

Part 2 に続き、今回は前回未確認だった層を検査した。**新たな脆弱性は見つからなかった**。
確認できた事実（変更時に壊さないこと）:

- **CSP**（`app/src/renderer/index.html`）: `default-src 'none'` 基点で `script-src 'self'`、
  `img-src 'self' capfile: data:`、`connect-src 'self'` のみ。`style-src 'unsafe-inline'` は
  インラインスタイル設計上の必然で、React がテキストをエスケープする前提では実害なし。
- **MAIN world ブリッジ**（`extension/netflix-main.js`）: ページ側スクリプトから
  `shiori-nflx-cmd` を偽造できるが、露出している能力は pause/seek のみ＝MAIN world の
  ページスクリプトが元々できる操作で、権限昇格にならない。**逆方向（ページ → content script）
  のリスナーは存在しない**（content.js は dispatch のみ。`message` リスナーなし）ため、
  ページ由来の未検証データがアプリへ流れ込む経路はない。
  ⚠️ 将来ページ → content の受信を追加する場合は、そこが新しい信頼境界になるので必ず検証を挟むこと。
- **依存関係**: Electron 42 / React 19 / ws 8.18 / better-sqlite3 12 と全てメジャー最新系。
  `overrides` で esbuild 0.28.1 に固定済み（dev サーバー脆弱性対応とみられる）。

## テスト不足

現状: 13 ファイル / 約 254 テスト。main 側の純粋ロジック（hotkey/paths/ipc-validation/
settings/ws パース/capture クロップ計算/tagger 状態機械/db/share-entry）と renderer の utils
（parseSearchQuery/buildImageQuery/buildTimeline/computeGridLayout）・imageStore は良好。
以下が無防備な順:

### T-1.【高】useSelection.ts（772行・テスト0）

renderer で最も複雑な層（矩形選択の当たり判定・削除 Undo/コミットのタイマーフロー・
選択履歴・Ctrl+A）が丸ごと未テスト。前回レビュー R-2 で最有価値と判定済みだが未着手。

**費用対効果順の足し先**:
1. `hitTestBox`（useSelection.ts:36）— 既に pure 関数。DOM 不要で即テスト可能
   （colGap/rowGap 境界、右端の当たり判定）
2. 削除フロー: `queueDelete` → Undo → 猶予明けコミット、連続削除時の前回分フラッシュ、
   `pagehide` フラッシュ、チャンク失敗時の部分復元（作業ツリーの N-3 修正の回帰テスト）
3. 選択履歴 undo/redo（SELECTION_HISTORY_LIMIT 境界）と Ctrl+A の 5000 件キャップ警告。
   **B-3（Ctrl+A レース）を直すときに必ず回帰テストを添えること**

**前提作業**: `@testing-library/react` を devDependencies に追加し、対象テストファイル先頭に
`// @vitest-environment jsdom` を付ける（vitest.config.ts は node のままでよい）。
`window.api` はモック注入。

### T-4.【低】useToast の押し出しポリシー

アクション付きトーストを優先的に残す eviction（useToast.ts:74-81）は仕様が繊細で純粋。
renderHook + fake timers で数ケース書ける。

### T-5.【低】拡張（content.js 1049行 / background.js 273行）はテスト0

バンドラ無しのため直接は難しい。最小の防衛として M-1（下記）のパリティテストを推奨。
コマ送りロジック等の本格テストは R-1（分割は大改修時に同時実施）の判断を維持してよい。

## 保守性

前提: このコードベースの保守性は全体として高い（「なぜ」を書くコメント規律、レビューID による
決定のトレーサビリティ、C-1〜C-3 での重複集約済み）。以下は残っている弱点。

### M-1.【中】WS メッセージ検証ロジックの三重実装が手動同期依存

**場所**: `app/src/main/ws-server.ts`（テスト済）、`extension/background.js:34-150`（未テスト）、
`extension/content.js`（定数のみ重複）

`MAX_*` 定数群・boundedNumber・safeUrl・safeRect・isValidCaptureKey が app 側と拡張側で
コピー実装されている。拡張はバンドラ無しなので共有モジュール化はできないが、
**片側だけ定数や検証条件を変えると静かに食い違う**のが現実的なリスク
（実際 `NAMED_CAPTURE_KEYS` は shared/hotkey.ts と background.js の 2 箇所に対で存在する）。

**修正（安価で効果大）**: vitest に「パリティテスト」を1本追加する —
`extension/background.js` をテキストとして読み、`MAX_WS_MESSAGE_BYTES` 等の定数値を
正規表現で抽出して ws-server.ts の export 値と一致することを assert する。
番兵として `NAMED_CAPTURE_KEYS` のキー集合も shared/hotkey.ts と比較する。
分割・ビルド導入なしでドリフトを検知できる。

### M-3.【低】App.tsx（789行）から「タグのグローバル削除」クラスタだけ切り出す

**場所**: `app/src/renderer/src/App.tsx:396-443`

過去レビューが App.tsx の全面分割を見送った判断は妥当（配線の通読性が高い）。
ただし `deleteTagFromAllImages` / `confirmDeleteTagGlobally` / `confirmSmartFolderDelete` /
`confirmTaggerDelete` の確認ダイアログ組み立て群は配線ではなくドメインロジックで、
`useConfirmActions` フックに移すと App.tsx が 50 行前後軽くなり、テストも書きやすくなる。
優先度は低く、他の修正でこの領域に触れるときのついでで十分。

### M-4.【低】SettingsModal のタブ型が日本語リテラル

**場所**: `app/src/renderer/src/components/SettingsModal.tsx:104-105`

`useState<'基本' | 'キャプチャ' | ...>` は表示ラベルと状態識別子が同一のため、
ラベル文言の変更が型・状態キーの変更を兼ねてしまう。`{ id: 'general', label: '基本' }` 形式に
分離するのが定石だが、タブ数 4 の現状では実害が小さい。文言を変えるときに直せばよい。

---

# Part 4: UI文言 / ドキュメント

## UI文言

### W-1.【中】取り込み系の用語が「インポート / 取り込み / 読み込み」で揺れている

同じ機能の中でも混在している:

| 場所 | 文言 |
|---|---|
| `App.tsx:153` D&Dトースト | 「◯枚を**インポート**しました」 |
| `App.tsx:538` ドロップオーバーレイ | 「ドロップして**取り込み**」 |
| `App.tsx:595` 空状態ヒント | 「ドロップして**取り込め**ます」 |
| `useGlobalKeys.ts:47` Ctrl+V 成功 | 「クリップボードから**インポート**しました」 |
| `useGlobalKeys.ts:51` Ctrl+V 失敗 | 「クリップボードからの**取り込み**に失敗しました」 |
| `SettingsModal.tsx` データタブ | 「**読み込み**」「ライブラリを**読み込む**...」 |

特に Ctrl+V は**成功と失敗で単語が違う**。推奨する統一:
- ファイル単位（D&D・クリップボード・画像フォルダ）→ **「取り込み」**（README の見出しとも揃う）
- ライブラリ全体（メタデータ付き共有）→ **「書き出し / 読み込み」**（現行の設定画面のまま）
- 「インポート/エクスポート」というカタカナ語は選択画像の「エクスポート」だけに残す

### W-2.【中】画像の数え方が「枚」と「件」で混在

グリッド系トースト（削除・D&D取り込み・タグ付け）は「◯枚」、共有の書き出し/読み込み
（`SettingsModal.tsx:328,331,362`）は「◯件」。どちらも数えている対象は画像なので
**「枚」に統一**する（スマートフォルダは「件」のままでよい）。

### W-3.【低】一括タグ編集の「全員」

**場所**: `DetailPanel.tsx:407`「一部の画像のみ（クリックで**全員**に追加）」、
`DetailPanel.tsx:427` placeholder「タグを追加（**全員**に）...」

対象は画像であって人ではないので不自然。「すべての画像に追加」「タグを追加（選択中すべてに）...」等へ。

### W-4.【低】進行中タスクのラベルが機能側の呼び名と食い違う

- `App.tsx:491` の共通タスクバーは images/share どちらも「**エクスポート中**」。share 起点の
  設定画面は「**書き出し中...**」と表示しており、同じ処理が場所で違う名前になる。
  exportKind で分岐して share のときは「ライブラリを書き出し中」にする。
- `useSelection.ts:77` の進捗は「◯枚を**削除中**…」だが、完了は「ゴミ箱へ**移動**しました」。
  「◯枚をゴミ箱へ移動中…」に揃えると、ゴミ箱（復元可能）という含意が保たれる。

### W-5.【低】三点リーダーの混在

半角 `...`（「読み込み中...」「キーを押してください...」等が多数）と全角 `…`
（`useSelection.ts:77`「削除中…」）が混在。どちらかに統一（既存分布的には `...` へ寄せるのが最小差分）。

## ドキュメント

### DOC-1.【中】README の拡張機能セットアップ手順が現在の UI と食い違う

**場所**: `README.md:40`

「Shiori を起動し、**画面下部**（またはトップの空状態）にある『拡張機能フォルダを開く』ボタン」
とあるが、現在の UI に画面下部のボタンは存在しない（サイドバー下部は「設定」ボタンのみ）。
実際の場所は ① 初回起動時の空状態、② 設定 → 基本 → 拡張機能（**未受信のときだけ表示**）の 2 箇所。
手順を「初回起動画面の『拡張機能フォルダを開く』、または 設定 → 基本 → 拡張機能」に更新する。
※ライブラリに画像がある状態で拡張を入れ直すユーザーは空状態ボタンに出会えないため、
設定側のボタンを接続状態に関わらず常時表示にする選択肢もある（その場合コード変更 1 行）。

### DOC-4.【低】ドキュメントと UI の用語統一

W-1/W-2 の統一を README（「ローカルインポート」「エクスポート」「データ書き出し/読み込み」）
にも波及させ、機能名 → 用語の対応表を 1 つ決めて全体を揃える。
（BLOG-DRAFT.md は削除済みのため対象外）

### 問題なしを確認したもの

- **SETUP.md**: scripts（dev/typecheck/test/verify）・dev.bat・extension の `node --check` まで
  現状と一致。T-1 で jsdom / @testing-library を導入したら前提の追記だけ忘れないこと。
- **NOTICE.md**: WD Tagger（Apache-2.0）・npm 主要依存・Icons8 の表記あり。実依存と一致。
- **LICENSE / README の免責・プライバシー節**: 実装（ローカル保存・ws://127.0.0.1 のみ・
  HF ダウンロード時のみ外部通信）と一致していることをコード側から確認済み。

---

# 実施順の推奨

済み: B-1（AIタグ16字問題）+ T-2/M-2 の該当部分、U-1（AND/ORトグル）、S-1（release に verify）、
B-2/D-1/T-3（共有インポート: 打ち切り撤廃 + 並行ガード + parseShareEntry 抽出）。
以下は残タスク。

1. U-8, U-9（数分で終わるクリーンアップ）
2. **T-1**（useSelection テスト整備。jsdom 前提作業を含む）＋ B-3（レース修正と回帰テスト）
3. U-2, U-5, D-3（小さい追加で体験改善が確実）
4. U-4（フォーカストラップ。20-30 行）、M-1（パリティテスト）
5. U-3, D-2（ショートカット一覧・インポート進捗）
6. **DOC-1**（README 拡張機能セットアップ手順の修正）
7. W-1〜W-5, DOC-4（用語統一。一括置換なので 1 コミットでまとめて）
8. U-6, U-7, U-10, T-4, M-3, M-4（余裕があれば）

（BLOG-DRAFT.md は削除済みのため、旧 DOC-2/DOC-3/ブログ公開ブロッカーの記載は対象外）

検証メモ:
- U-4: 設定モーダルで Tab 連打 → フォーカスがモーダル外へ出ないことを確認
