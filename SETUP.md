# 開発環境セットアップ

**日本語** ・ [English](SETUP.en.md)

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

`postinstall` で以下が自動実行される。

1. `scripts/fetch-ffmpeg.mjs` が `app/resources/ffmpeg.exe`（LGPL ビルド、約92MB）を取得する。
   リポジトリには含めていないため、クローン直後は必ずこの取得が走る（初回は数分かかる）。
   既に正しいバイナリがあればスキップされる。
2. `electron-rebuild` が `better-sqlite3` と `onnxruntime-node` の Electron 向けネイティブビルドを行う（数分かかる）。

### ffmpeg の取得だけやり直す

```
cd app
npm run fetch-ffmpeg          # 不足時のみ取得
node scripts/fetch-ffmpeg.mjs --force   # 強制的に取り直す
```

URL と SHA256 はスクリプト内でピン留めしてある。**GPL ビルドに差し替えないこと** —
Shiori 本体は proprietary ライセンスのため、GPL 版 ffmpeg を同梱すると
ライセンスが衝突する（詳細は NOTICE.md）。

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
```

`extension/` は型検査の対象外（バンドラを通さない素の JS）。構文が通るか・manifest が
指すファイルが実在するかは `npm test` の `extension-integrity.test.ts` が見ているので、
手で `node --check` を回す必要は無い。より広い検査は `npm run ext:lint`
（web-ext。ネットワークからの取得を伴うため verify には入れていない。拡張を触った
リリース前に一度回すこと）。

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
| Electron 起動時に `electron.app` が undefined でクラッシュ | 実行環境で `ELECTRON_RUN_AS_NODE=1` が設定されている | `dev.bat` は起動前に変数をクリアする。直接 `npm run dev` する場合も、事前に `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue` を実行する |
| Electron バイナリが見つからないエラー | クローン直後は `npm install` が未実行でバイナリ未ダウンロード | `npm install` を実行する（`node node_modules/electron/install.js` でバイナリのみ再取得も可） |
