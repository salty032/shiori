# 開発環境セットアップ

**日本語** ・ [English](SETUP.en.md)

## 前提

- Node.js（LTS）が必要です。インストールされていない場合：
  ```
  winget install OpenJS.NodeJS.LTS
  ```
  インストール後は、PATH を反映するために **ターミナルを開き直してください**。

- PowerShell で `npm` を実行できない場合は、実行ポリシーを変更します：
  ```powershell
  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
  ```

## インストール

```
cd app
npm install
```

`postinstall` で以下の処理が自動的に実行されます。

1. `scripts/fetch-ffmpeg.mjs` が `app/resources/ffmpeg.exe`（LGPL ビルド、約92MB）を取得します。
   このファイルはリポジトリに含まれていないため、クローン後の初回実行時には必ずダウンロードされます（数分かかる場合があります）。
   正しいバイナリがすでに存在する場合、この処理はスキップされます。
2. `electron-rebuild` が `better-sqlite3` と `onnxruntime-node` を Electron 向けにネイティブビルドします（数分かかる場合があります）。

### ffmpeg の取得だけやり直す

```
cd app
npm run fetch-ffmpeg          # 不足時のみ取得
node scripts/fetch-ffmpeg.mjs --force   # 強制的に取り直す
```

URL と SHA256 はスクリプト内で固定されています。**GPL ビルドに差し替えないでください。**
Shiori 本体は proprietary ライセンスのため、GPL 版 ffmpeg を同梱すると
ライセンスが衝突します（詳細は NOTICE.md）。

## 起動

リポジトリルートの `dev.bat` をダブルクリックするか、次のコマンドを実行します：

```
cd app
npm run dev
```

## 型チェック

```
cd app
npm run typecheck
```

`extension/` は、バンドラーを通さない JavaScript であるため型検査の対象外です。構文が正しいことと、
manifest が参照するファイルの存在は、`npm test` の `extension-integrity.test.ts` で確認されます。
そのため、`node --check` を個別に実行する必要はありません。より包括的な検査には
`npm run ext:lint` を使用します（web-ext はネットワークからの取得を伴うため、`verify` には含めていません。
拡張機能を変更した場合は、リリース前に一度実行してください）。

## テスト

```
cd app
npm test
```

大半のテストは Node 環境（vitest.config.ts の既定）で動作しますが、DOM 操作を伴うフック
（`useSelection.test.ts` 等）はファイル先頭の `// @vitest-environment jsdom` で個別に
jsdom 環境を指定しています。`jsdom` / `@testing-library/react` は devDependencies に含まれているため、
`npm install` 以外の追加作業は不要です。

型チェックとテストをまとめて実行する場合：

```
cd app
npm run verify
```

## 既知のセットアップ上の問題

| 症状 | 原因 | 対処 |
|---|---|---|
| Electron 起動時に `electron.app` が undefined でクラッシュ | 実行環境で `ELECTRON_RUN_AS_NODE=1` が設定されている | `dev.bat` は起動前に変数をクリアする。直接 `npm run dev` する場合も、事前に `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue` を実行する |
| Electron バイナリが見つからないエラー | クローン直後は `npm install` が未実行でバイナリ未ダウンロード | `npm install` を実行する（`node node_modules/electron/install.js` でバイナリのみ再取得も可） |
