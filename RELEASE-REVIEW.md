# リリース前最終レビュー（v1.0.0）

- 実施日: 2026-07-05
- 対象: リポジトリ全体（git 履歴ではなく現在のツリー全ファイル）
- 方法: 全ソースコードの通読レビュー + `npm run verify`（型チェック・テスト）実行

## 総合判断: **リリース可**

コード品質・入力検証・エラーハンドリング・ユーザーへのフィードバックのいずれも
個人開発アプリとしては非常に高い水準にあり、リリースを止めるべき問題は見つからなかった。
下記の「軽微な指摘」は任意対応でよい。

---

## 検証結果

| 項目 | 結果 |
|---|---|
| `npm run verify`（typecheck + vitest） | ✅ 235 テスト全パス、型エラーなし |
| `node --check` extension/background.js / content.js | ✅ 構文OK |
| 個人情報・秘密情報（メール・ローカルパス・APIキー等）の混入 | ✅ なし |
| TODO/FIXME 等の作業残しコメント | ✅ なし |
| 拡張IDの整合（manifest の `key` から導出したID = settings.ts の既定許可ID） | ✅ 一致（`cgoo...bdpn`） |
| バージョン整合（app 1.0.0 / extension 1.0.0 / README の表記） | ✅ 一致 |
| リリース設定（publish 先 `salty032/shiori` = git remote） | ✅ 一致 |

---

## 領域別の所見

### ドキュメント（README / SETUP / LICENSE / NOTICE）
- README は機能・インストール手順・プライバシー・免責事項・ライセンスが揃っており、
  利用者向けの注意（各サービスの利用規約・私的利用の範囲）も明記されている。
- LICENSE（個人利用ライセンス）と package.json の `UNLICENSED`、README の記述は整合。
- SETUP.md は既知のセットアップ問題（`ELECTRON_RUN_AS_NODE` 残留等）まで記載されており親切。

### ビルド・CI・リリース
- CI（push/PR で verify）・Release（`v*` タグで electron-builder → GitHub Releases）とも妥当。
- ネイティブモジュール（better-sqlite3 / onnxruntime-node）のため Windows ランナー固定である理由もコメント済み。
- afterPack で不要ロケール削除、onnxruntime の他OS向けバイナリ除外など配布サイズへの配慮あり。
- extraResources で LICENSE / NOTICE.md / extension を同梱。

### メインプロセス
- **セキュリティ対策が体系的**:
  - `app.enableSandbox()`、`contextIsolation: true`、`nodeIntegration: false`、権限リクエスト全拒否
  - IPC は全チャンネルで送信元検証（`handleTrusted` / `isTrustedSender`）
  - `capfile://` プロトコルは DB の id 経由でのみファイル解決（生パスを受けない）
  - パス解決は `realpath` + 許可ベースディレクトリ + 拡張子ホワイトリストの三重ガード
  - WS サーバーは 127.0.0.1 バインド + 拡張IDオリジン許可リスト + ペイロード上限 + 全フィールド境界検証
  - WD Tagger モデルは SHA-256 ピン留め + サイズ上限 + 無通信タイムアウト付きダウンロード
- **堅牢性への配慮**: 設定ファイルのアトミック書き込み（tmp→rename）と破損時の退避・通知、
  DB行削除を先行させる削除順序（ゴースト行の構造的回避）、タグ付けの直列化チェーン、
  キャプチャの再入防止と UI 復帰の exactly-once 保証など、エッジケースの検討が行き届いている。

### Chrome 拡張
- background / content とも受信メッセージを全フィールド検証してから中継しており、
  アプリ側と対称的なバリデーションになっている。
- プレーヤーUI非表示が固着しないためのウォッチドッグ（8秒で強制復元）あり。
- ホスト権限は対応サービスのみで最小限。

### レンダラー（UI）
- 状態管理の責務分割（imageStore が画像の単一の真実、filterStore が確定フィルタ）と
  世代カウンタによる競合対策が一貫している。
- 削除は Undo 猶予付き（4秒）楽観更新 + 失敗時の自動復元。上限系（インポート200件、
  エクスポート1000件、タイムライン5000件）はすべてトーストで打ち切りを明示しており
  「黙って一部だけ処理される」ことがない。
- 型チェック・テスト（ws-server / paths / settings / db / capture / tagger / utils / imageStore 等）が
  リスクの高い箇所を押さえている。

---

## 軽微な指摘

1. **NOTICE.md の文言**（NOTICE.md:33）→ ✅ 修正済み
   「配布物には、各パッケージの完全なライセンス本文を集約して同梱する」とあったが、
   ビルドは集約ファイルを生成していない。各ライセンス本文は配布物内の node_modules に
   同梱される実態に合わせて文言を修正した。
2. **クリップボード貼り付けの連打**（useGlobalKeys.ts）→ ✅ 修正済み
   Ctrl+V ハンドラが async で再入ガードがなく、キー長押しで同じ画像が複数回
   取り込まれうる問題があった。処理中は後続の Ctrl+V を無視する再入ガードを追加した。
3. **起動時サムネイル検査**（ipc-images.ts `backfillThumbnails`）→ 据え置き（意図的）
   毎起動で全画像行を走査する（1行ごとに realpath/access）。数万件規模では起動直後の
   バックグラウンドI/Oが増えるが、非同期実行のため体感への影響は小さい。これは
   「欠損・生成失敗したサムネを検出して補完する」という機能の目的そのものであり、
   マーカー方式でスキップすると欠損検出ができなくなるため、あえて変更しない。

---

## リリース手順の確認

1. `git tag v1.0.0 && git push origin v1.0.0` で Release ワークフローが起動
2. `Shiori-Setup-1.0.0.exe` が GitHub Releases に公開される（draft ではなく即公開設定）
3. electron-updater は同リポジトリの Releases を4時間ごとに確認し、新版があれば
   アプリ内バナーで通知（未署名のため自動DLはしない設計）
