# Firefox 対応 実装フロー（ハンドオフ用）

このドキュメントは Shiori の拡張機能を Firefox に対応させるための実装手順書です。
実装は別モデル/別セッションで行う前提で、変更対象・判断ポイント・検証手順を具体的に記します。

## 前提：Chromium 系は対応済み

Edge / Brave / Vivaldi / Opera など Chromium 系ブラウザは **無改造で動作する**（Vivaldi・Edge は実機確認済み）。
理由は拡張 ID が `extension/manifest.json` の `key`（公開鍵）から決定論的に導出され、その導出アルゴリズムが
全 Chromium で同一だから。導出される固定 ID `cgoodmpndbpjjlhpeimjjjjccioebdpn` がアプリ側の
WebSocket allowlist（`app/src/main/settings.ts` の `EXTENSION_ID`）に一致するため、設定変更なしで接続が通る。

**したがって本タスクの対象は Firefox のみ。Safari はスコープ外**（Apple の変換ツール + Xcode +
Developer 登録が必要で実質別プロジェクト）。

## アーキテクチャのおさらい

```
[ブラウザ拡張]                          [Shiori アプリ (Electron)]
 content.js  --port-->  background.js  --WebSocket-->  ws-server.ts
 (各動画ページ)          (SW/背景)      ws://127.0.0.1:39821   (allowlist で origin 検証)
```

- 拡張 → アプリは `ws://127.0.0.1:39821` の WebSocket 1 本（`extension/background.js:1`）。
- アプリは接続元 origin を検証し、許可拡張 ID 以外を弾く（`app/src/main/ws-server.ts` の `verifyClient`）。
- Alt+S 等のキャプチャ操作はアプリ側のグローバルショートカットが起点。拡張はタイムコード提供役。

---

## 変更対象は 2 レイヤ

### A. 拡張側（`extension/`）— manifest 中心、コードは軽微
### B. アプリ側（`app/src/main/ws-server.ts`）— **origin 検証の設計判断が本丸**

---

## A. 拡張側の変更

### A-1. `chrome.*` 名前空間（おそらくほぼ無改造で可）

Firefox は互換のため **`chrome.*` のコールバック形式 API を実装している**ため、現行コードの
`chrome.*` 呼び出しは大半がそのまま動く見込み。ただし各 API を実機で個別検証すること。使用箇所は以下のみ：

| API | 箇所 | Firefox 対応 |
|---|---|---|
| `chrome.runtime.connect` | `extension/content.js:953` | 対応 |
| `chrome.runtime.onConnect` | `extension/background.js:229` | 対応 |
| `chrome.runtime.lastError` | `extension/background.js:248` | 対応 |
| `chrome.windows.getLastFocused`（`windowTypes` 付き） | `extension/background.js:167` | 対応（要確認） |
| `chrome.windows.get` | `extension/background.js:247` | 対応 |
| `chrome.tabs.query` | `extension/background.js:169` | 対応 |

- **方針**: まず無改造で動作確認する。もし特定 API が期待どおり動かない場合のみ、
  ファイル冒頭に `const api = globalThis.browser ?? globalThis.chrome` のラッパーを 1 つ置き、
  問題のあった呼び出しを `api.*` に差し替える。全面 polyfill 導入までは不要。
- `permissions: ["tabs", "windows"]`（`manifest.json:13`）は Firefox でも同名で有効。

### A-2. manifest の背景スクリプト指定（要変更）

現状は service worker のみ（`manifest.json:30-32`）：

```json
"background": { "service_worker": "background.js" }
```

Firefox は MV3 でも `background.scripts`（イベントページ）を使う実装が主流。両対応にするため
**両方のキーを併記**する（Chrome は `service_worker` を、Firefox は `scripts` を選ぶ）：

```json
"background": {
  "service_worker": "background.js",
  "scripts": ["background.js"]
}
```

`background.js` は DOM 非依存（WebSocket / setTimeout / runtime ポートのみ）なので、
イベントページ実行でもそのまま動く。

### A-3. `browser_specific_settings.gecko` を追加（要追加）

Firefox は拡張 ID を manifest で明示する必要がある。`manifest.json` に追加：

```json
"browser_specific_settings": {
  "gecko": {
    "id": "shiori@salty032",
    "strict_min_version": "128.0"
  }
}
```

- `strict_min_version` を **128** にするのは A-4 の `world: "MAIN"` が Firefox 128+ 必須のため。
- Chromium 系は `browser_specific_settings` を無視するので、共通 manifest のままでよい。
- `manifest.json:4` の `key` は Firefox では無視される（Chromium 用なので残置で問題なし）。

### A-4. `world: "MAIN"` コンテンツスクリプト（バージョン注意）

Netflix 用ブリッジ（`manifest.json:52-57` の `netflix-main.js`、`world: "MAIN"`）は
**Firefox 128 以降でのみ対応**。A-3 の `strict_min_version: "128.0"` で担保する。
128 未満では Netflix のコマ送りだけが無反応になる（他サイトは影響なし）。

### A-5. host_permissions

`manifest.json:14-29` の host_permissions（`localhost` と各動画サイト）は Firefox でも同形式で有効。変更不要。

---

## B. アプリ側の変更（ws-server.ts）— **設計判断ポイント**

### B-1. 問題：Firefox の origin はインストールごとにランダム

Chromium の接続 origin は `chrome-extension://<固定ID>` だが、Firefox は
`moz-extension://<ランダムUUID>` で、この **UUID はプロファイル/インストールごとに生成され、
`gecko.id` とは別物で固定できない**。

現行の origin 検証（`app/src/main/ws-server.ts:51-61` の `extensionOrigin`）は
`chrome-extension:` スキームかつ `/^[a-p]{32}$/` の ID しか通さないため、
Firefox は **スキームと ID 形式の両方で弾かれる**。かつ allowlist に固定 ID を足す方式は
UUID が固定できない以上そのまま使えない。

### B-2. 選択肢（どちらかを採用する判断が必要）

**選択肢 1：`moz-extension://` を全許可（MVP 向け・推奨）**
- `extensionOrigin` を拡張し、`moz-extension:` スキームなら UUID 部分は形式チェックのみ
  （例：`/^[0-9a-f-]{36}$/` の UUID）で通す。ID 単位の照合はしない。
- リスク：同一マシンの **他の Firefox 拡張も接続可能**になる。ただし接続先は `127.0.0.1` 限定で、
  送れるのはタイムコード等の限定メッセージのみ（`parseExtensionMessage` で厳格検証済み）。
  ローカル限定・低リスクと判断できるなら、これが最小実装。

**選択肢 2：ハンドシェイクトークン（堅牢だが工数増）**
- アプリ起動時にトークンを生成 → 何らかの経路で拡張に渡し、接続時に検証。
- origin に依存しないので Firefox/Chromium 共通で使える。ただしトークンの受け渡し経路の設計が必要で
  工数が大きい。セキュリティ要件が上がった場合の将来対応として記録に留める。

**推奨：選択肢 1**。ローカルホスト限定・メッセージ厳格検証済みという前提でリスクは限定的。

### B-3. 具体的な変更（選択肢 1 の場合）

`app/src/main/ws-server.ts` の `extensionOrigin`（51-61 行）を、`chrome-extension:` に加えて
`moz-extension:` を許容するよう拡張する。判断ポイント：

- `chrome-extension://<[a-p]{32}>` → 従来どおり allowlist 照合（`isAllowedWsOrigin`）。
- `moz-extension://<uuid>` → UUID 形式を検証し、allowlist 照合は **スキップして許可**
  （UUID が固定できないため）。
- `isAllowedHttpOrigin` / `isAllowedWsOrigin`（67-79 行）の分岐もこの新ロジックに合わせる。
- **テスト更新必須**：`app/src/main/ws-server.test.ts` に moz-extension 受理/不正形式拒否のケースを追加。
  `app/src/main/settings.test.ts` の allowlist 挙動は Chromium 側なので変更不要。

### B-4. Private Network Access プリフライト（対応不要の見込み）

`ws-server.ts:182-205` の HTTP OPTIONS ハンドラは Chromium の PNA プリフライト用。
Firefox は PNA プリフライトを送らず WebSocket upgrade に直行するため、この経路は
Firefox では通らない（`verifyClient` の origin ゲートは通る）。**基本は変更不要**だが、
Firefox からの接続で 403 や upgrade 失敗が出た場合はこの周辺のログを確認する。

---

## 実装順序（推奨）

1. **B-3（サーバ origin 検証）を先に実装** — これが無いと Firefox は接続すら通らず、拡張側の
   動作確認ができない。テストも同時に追加。
2. **A-2 / A-3（manifest の background・gecko 設定）** を追加。
3. Firefox で `about:debugging` → 「一時的なアドオン」から `extension/` を読み込む。
4. **A-1 の各 `chrome.*` API を実機で確認**。動かないものだけ `api` ラッパーに差し替え。
5. 対応動画サイトを開き、Shiori 設定画面の「拡張機能」バッジが「受信中」になるか確認。
6. Alt+S でキャプチャ → タイトル/タイムコード/URL が正しく保存されるか確認。
7. Netflix でコマ送り（A-4 の `world: "MAIN"` 動作確認、FF 128+ で）。

## 検証チェックリスト

- [ ] Firefox で WebSocket が接続され「受信中」表示になる
- [ ] Alt+S でキャプチャが保存され、メタデータ（タイトル/時刻/URL）が正しい
- [ ] 撮影領域（ウィンドウ座標）が正しい ← `moz-extension` の windowLeft/Top 上書きが効くか
- [ ] コマ送り（Shift+←/→）が各サイトで動く
- [ ] Netflix のコマ送り（main world ブリッジ）が動く（FF 128+）
- [ ] 既存の Chromium 系が回帰していない（origin 検証変更の影響確認）
- [ ] `npm run verify`（typecheck + test）が通る

## 配布・パッケージングの注意

- Firefox 版拡張は **署名が必須**（`about:debugging` の一時読み込みは再起動で消える）。恒久利用には
  AMO（addons.mozilla.org）への提出か、自己配布用の署名（`web-ext sign`）が必要。
- 現状の同梱フロー（`app/src/main/extension-updater.ts` が `userData/extension` にコピー →
  ユーザーがサイドロード）は Chromium 前提。Firefox 向けには署名済み `.xpi` の配布経路を別途検討する。
  ※本タスクのスコープは「動作する」ところまで。配布経路整備は別タスク。

## スコープ外

- Safari 対応（別プロジェクト規模）。
- 選択肢 2（ハンドシェイクトークン）の実装。将来セキュリティ要件が上がった場合に再検討。
- Firefox 版拡張の署名・ストア提出フローの整備。
