# 開発環境セットアップ

## 前提

- Node.js（LTS）が必要。未インストールの場合：
  ```
  winget install OpenJS.NodeJS.LTS
  ```
  インストール後は **ターミナルを開き直す**（PATH 反映のため）。

- PowerShell で `npm` が使えない場合は実行ポリシーを変更：
  ```powershell
  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
  ```

## インストール

```
cd app
npm install
```

`postinstall` で `electron-rebuild` が自動実行され、`better-sqlite3` と `onnxruntime-node` の Electron 向けネイティブビルドが行われる（数分かかる）。

## 起動

リポジトリルートの `dev.bat` をダブルクリック、または：

```
cd app
npm run dev
```

## 型チェック

```
cd app
npm run typecheck
node --check ../extension/background.js
node --check ../extension/content.js
```

## テスト

```
cd app
npm test
```

大半のテストは Node 環境（vitest.config.ts の既定）で動くが、DOM 操作を伴うフック
（`useSelection.test.ts` 等）はファイル先頭の `// @vitest-environment jsdom` で個別に
jsdom 環境を指定している。`jsdom` / `@testing-library/react` は devDependencies に含まれるため、
`npm install` 以外の追加作業は不要。

型チェック + テストをまとめて実行：

```
cd app
npm run verify
```

## 既知のセットアップ上の問題

| 症状 | 原因 | 対処 |
|---|---|---|
| Electron 起動時に `electron.app` が undefined でクラッシュ | `electron-rebuild` 実行後にセッションへ `ELECTRON_RUN_AS_NODE=1` が残る | `dev.bat` に `set ELECTRON_RUN_AS_NODE=` を追加済み。直接 `npm run dev` する場合は事前に変数をクリアする |
| Electron バイナリが見つからないエラー | クローン直後は `npm install` が未実行でバイナリ未ダウンロード | `npm install` を実行する（`node node_modules/electron/install.js` でバイナリのみ再取得も可） |
