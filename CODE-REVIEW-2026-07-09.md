# CODE-REVIEW 2026-07-09（外部提案の判定 + 追加調査）

対象: v1.0.4 時点のコードベース全体。`npm run typecheck` / `npm test`（11 files / 232 tests）は通過済み。
重大バグは今回も未検出。以下は「外部レビュー提案 5 点の採否判定」と「追加調査で見つけた改善点」。

採用基準の凡例: **採用** = やる価値あり / **条件付き** = タイミング・やり方を限定して採用 / **見送り** = 現時点では割に合わない

---

## Part 1: 外部レビュー提案の判定

### R-1. content.js（1049行）の分割 → **条件付き（優先度: 低）**

指摘自体は事実（サービス別 UI 非表示・タイトル取得・フレーム送り・通信・UI 復元が同居）。
ただし以下の理由で今すぐの分割は勧めない:

- サービス別の壊れやすい部分は既に**データ駆動のテーブルに集約済み**
  （`SERVICE_PLAYER_UI` / `POST_CAPTURE_RESTORE_DELAY_BY_HOST` / `FREEZE_SCOPE` / `getPageTitle` のホスト分岐）。
  配信サイトの DOM 変更への追従作業は、ファイルを分割しても減らない。
- 拡張はバンドラ無しの素の JS。分割するなら manifest の `content_scripts.js` に複数ファイルを
  列挙してスコープ共有する方式になるが、**読み込み順序依存のグローバル共有**という新しい壊れ方が増える。
- 拡張側には自動テストが無く、10 サービス分の手動回帰が必要。リスクとリターンが釣り合わない。

**やるなら**: 次に新サービス対応やコマ送りの大改修で content.js を大きく触るとき、
その改修と同時に「サービス別定義（データ）」「通信」「UI 隠し/復元」の 3 ファイルに分ける。
単独タスクとしては起票しない。

### R-2. App.tsx / useSelection への UI 回帰テスト追加 → **採用（優先度: 高。5 点の中で最有価値）**

- renderer のテストは `imageStore.test.ts` と `utils.test.ts` の 2 本のみ。
  選択・削除 Undo・ビューア追従という一番複雑な層が無防備。
- 提案どおり「分割」ではなく「テストを足す」なのが良い。この 2 ファイルはコメントが厚く
  設計意図も明確なので、リファクタより回帰網の整備が先。

**具体的な足し先**（費用対効果順）:
1. `hitTestBox`（useSelection.ts:36）は既に pure 関数。DOM 不要で即テスト可能
   （矩形選択の当たり判定、colGap/rowGap 境界、右端ズレの回帰）。
2. `useSelection` の削除フロー: `queueDelete` → Undo（`undoPendingDelete`）→
   猶予明けコミット、連続削除時の前回分フラッシュ、`pagehide` でのフラッシュ。
   `@testing-library/react` の `renderHook` + fake timers + `window.api` モックで書ける。
3. 選択履歴の undo/redo（`SELECTION_HISTORY_LIMIT` 境界含む）と Ctrl+A の
   5000 件キャップ warning トースト。
4. App.tsx の「viewer が id で同じ画像を追い続ける」effect（App.tsx:99-116）。
   これはコンポーネントテストが必要で工数が大きめ。2〜3 を先に。

前提作業: `vitest.config.ts` に jsdom 環境（renderer 側のみ）と
`@testing-library/react` の devDependency 追加。

### R-3. db.ts の migration を user_version ベースの runner に → **条件付き（次のスキーマ変更時に実施）**

- 現行の `addColumnIfMissing` + `CREATE ... IF NOT EXISTS` 積み上げは冪等で、現時点で実害なし。
- runner への移行そのものは正しい方向だが、**移行作業自体がアップグレード事故の温床**になるので、
  「次に大きめのスキーマ変更が必要になったとき」にその変更と一緒にやるのが安全。単独では起票しない。
- ただし **1 点だけ先に直す価値がある**: `addColumnIfMissing`（db.ts:42-51）は
  duplicate column 以外のエラーも `console.warn` して続行する。ディスクフル・破損等で
  ALTER が本当に失敗した場合、半端なスキーマのまま後続クエリが不可解に壊れる。
  duplicate 以外は throw して initDb の既存 catch（起動中断ダイアログ）に乗せるべき。→ N-2 として起票。

### R-4. bootstrap.ts の分割 → **見送り（優先度: 最低）**

- 405 行でコメント密度が高く、whenReady 内の初期化順序（protocol → DB → WS → IPC 登録 →
  hook → window/tray）はむしろ 1 ファイルで通読できる方が安全。
- 切り出すなら自己完結度が最も高い `capfile` protocol ハンドラ（bootstrap.ts:87-167、約 80 行）
  だけを `protocol-capfile.ts` に移す案はあるが、機能的な利益はゼロ。他のタスクのついでで十分。

### R-5. エクスポートの main 側進行中ガード → **採用（優先度: 中。小さく確実）**

- 指摘どおり renderer（exportStore の exportKind ガード）にしか防衛がない。
- さらに実装上の裏付けとして、`isImagesExportCanceled`（ipc-images.ts:27）が
  **モジュールレベルの単一フラグ**なので、万一 `images:export` が並行実行されると
  片方の中止がもう片方も止める・進捗表示が混線する。main 側ガードはこれも同時に閉じる。

**実装**: `let isImagesExporting = false` を追加し、`CH.imagesExport` ハンドラ冒頭で
進行中なら `{ canceled: true }` を即返す（ダイアログを開く前に判定）。`finally` で解除。
`ipc-share.ts` のエクスポート側にも同型のガードを揃える。

---

## Part 2: 追加調査で見つけた改善点（新規）

### N-1. FTS の UPDATE トリガーが title/memo 以外の更新でも発火する（efficiency・優先度: 中）

`images_fts_au`（db.ts:125-128）は `AFTER UPDATE ON images` なので、
`setThumbPath`（サムネ backfill で全欠損行に走る）や host backfill の UPDATE でも
FTS インデックスの delete+insert が毎行実行される。title/memo は変わっていないので純粋な無駄書き込み。

**修正**: トリガーを `AFTER UPDATE OF title, memo ON images` に変更。
既存 DB はトリガーが `IF NOT EXISTS` で残るため、`DROP TRIGGER IF EXISTS images_fts_au` →
再 CREATE を initDb に追加する（冪等なので毎回実行で可）。ai/ad トリガーは変更不要。

### N-2. addColumnIfMissing が実際の migration 失敗を握りつぶす（robustness・優先度: 中）

R-3 の判定内に記載のとおり。duplicate column 正規表現に一致しないエラーは warn ではなく throw し、
bootstrap.ts:170-185 の既存 initDb catch（エラーダイアログ + 終了）へ乗せる。
「DB が半端な状態で起動し続ける」より「起動失敗として気付ける」方が復旧しやすい。

### N-3. 一括削除の IPC 例外時に snapshot 全体を復元するとゴースト表示になる（robustness・優先度: 低）

`deleteImages`（useSelection.ts:58-113）はチャンク分割して `deleteImagesBulk` を呼ぶが、
2 チャンク目以降で invoke 自体が throw すると、`commitPendingDelete` の catch が
`restoreImages(pending.snapshot)` で**全件**をグリッドに戻す。1 チャンク目は DB から削除済みなので、
リロードまで「DB に存在しない画像」が表示に残る（サムネは capfile が 403 になり破損表示）。

**修正案**: `deleteImages` がチャンクごとに成功 ID を集めて返し、catch 側は
`restoreImages(pending.snapshot, 未処理 ID のみ)` で復元する。もしくは catch 内で
`reloadGrid`/`reloadTimeline` を呼んで DB を真実として同期し直す（こちらの方が単純で確実）。

### N-4. Ctrl+A が空リストで focusedIndex = -1 を作る（minor・優先度: 最低）

useSelection.ts:546-569。`loaded.length === 0` でも `anchorIdx.current = 0`、
`setFocusIdx(-1)` が実行される。後続の境界ガードで実害は出ていないが、
冒頭に `if (loaded.length === 0) return` を足して状態を汚さない。

### N-5. 検証定数の三重定義にドリフト検知が無い（observation・優先度: 低）

`MAX_TITLE_LENGTH` / `MAX_URL_LENGTH` / `MAX_WS_PAYLOAD_BYTES` 等の入力検証の定数・ロジックが
ws-server.ts / extension/background.js / extension/content.js に三重定義されている。
拡張は素の JS なので import 共有は不可（設計として正しい）。ただし片側だけ変えた場合に
気付く仕組みが無い。main 側 vitest に「3 ファイルをテキストとして読み、定数値の一致を
突き合わせるテスト」を 1 本足すとドリフトを CI で検知できる。R-2 のテスト整備のついでに。

---

## 推奨着手順

| 順 | 項目 | 規模 | 種別 |
|---|------|------|------|
| 1 | R-5: main 側エクスポートガード | 小 | robustness |
| 2 | N-2: addColumnIfMissing の失敗を throw に | 小 | robustness |
| 3 | N-1: FTS トリガーを UPDATE OF title, memo に | 小 | efficiency |
| 4 | N-3: 一括削除例外時のゴースト復元を修正 | 小〜中 | robustness |
| 5 | R-2: useSelection / hitTestBox のテスト整備（+ N-4, N-5 を同梱） | 中 | test |
| - | R-3: migration runner | 次のスキーマ変更時に同時実施 | 保留 |
| - | R-1: content.js 分割 | 次の拡張大改修時に同時実施 | 保留 |
| - | R-4: bootstrap 分割 | 見送り | 保留 |

各項目の完了時は本ファイルの該当行に済マークを付け、全消化後にファイルごと削除してよい
（過去のレビューノートと同じ運用）。
