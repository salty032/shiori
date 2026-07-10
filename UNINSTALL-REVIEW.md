# Shiori アンインストール状況メモ

## 結論

現状は、Windows の通常アンインストールで **アプリ本体は削除できる**。
ただし、ユーザーデータ・Chrome 拡張の登録・スタートアップ設定まで含めた
「クリーンアンインストール」とはまだ言い切れない。

## 現状のアンインストール対象

`app/package.json` では Windows 向けに NSIS インストーラーを使っている。

- `target: nsis`
- デスクトップショートカット作成あり
- スタートメニューショートカット作成あり
- `uninstallDisplayName: Shiori`

そのため、Windows の「アプリと機能」から Shiori 本体のアンインストールは可能。

## 残りそうなもの

Shiori の主要データは Electron の `app.getPath('userData')` 配下に保存される。
Windows では通常 `%APPDATA%\Shiori` に相当する。

残りそうなもの:

- `%APPDATA%\Shiori\captures`
- `%APPDATA%\Shiori\thumbnails`
- `%APPDATA%\Shiori\Shiori.db`
- `%APPDATA%\Shiori\settings.json`
- `%APPDATA%\Shiori\extension`
- `%APPDATA%\Shiori\models\wd-vit-tagger-v3`
- Chrome 側でサイドロードした Shiori 拡張の登録
- Shiori 側で有効化したスタートアップ登録

## 根拠

- キャプチャ画像: `app/src/main/paths.ts` の `captureDir()`
- サムネイル: `app/src/main/paths.ts` の `thumbnailDir()`
- DB: `app/src/main/db.ts` の `Shiori.db`
- 設定: `app/src/main/settings.ts` の `settings.json`
- 拡張コピー先: `app/src/main/extension-updater.ts` の `installedExtensionPath()`
- AI タグ付けモデル: `app/src/main/tagger.ts` の `modelDir()`
- スタートアップ登録: `app/src/main/bootstrap.ts` の `app.setLoginItemSettings`

## ユーザー向けに案内するなら

現状で完全削除したい場合は、次の手順が必要。

```text
1. Windows の「アプリと機能」から Shiori をアンインストール
2. Chrome の chrome://extensions で Shiori 拡張を削除
3. 必要なら %APPDATA%\Shiori を手動削除
4. スタートアップを有効にしていた場合は、Windows のスタートアップ設定も確認
```

## 改善案

### 案1: ドキュメントで明示する

最小対応。README または新規ドキュメントに、通常アンインストールでは
ライブラリデータが残ること、完全削除には `%APPDATA%\Shiori` の削除と
Chrome 拡張の削除が必要なことを書く。

メリット:

- すぐ対応できる
- キャプチャ画像を誤って削除しない

デメリット:

- ユーザーが手動で消す必要がある

### 案2: アプリ内に「データ削除」導線を作る

設定画面に「ローカルデータを削除」または「アンインストール前のデータ削除」導線を追加する。
確認ダイアログを挟み、DB・キャプチャ・サムネ・モデル・拡張コピーを削除する。

メリット:

- ユーザーが何を消すか把握しやすい
- キャプチャ画像の削除を明示確認できる
- Chrome 拡張の削除手順も同じ画面で案内できる

デメリット:

- 実装と検証が必要
- 実行中の DB / モデル / WebSocket / トレイ常駐との終了順序に注意が必要

### 案3: アンインストーラーにユーザーデータ削除オプションを追加する

NSIS のアンインストール時に `%APPDATA%\Shiori` を削除する仕組みを追加する。

メリット:

- Windows のアンインストール操作だけで完結しやすい

デメリット:

- キャプチャ画像を巻き込むため、誤削除リスクが高い
- Chrome にサイドロードした拡張登録は別途削除が必要
- 現在の electron-builder 設定では `deleteAppDataOnUninstall` は未設定

## 推奨

まずは **案1: ドキュメントで明示** を入れる。
その後、ユーザー体験として必要なら **案2: アプリ内のデータ削除導線** を追加する。

キャプチャ画像はユーザーの成果物なので、アンインストーラーで自動削除するより、
アプリ内で明示確認して削除する方が安全。
