# サードパーティ表記 (Third-Party Notices)

Shiori は以下のサードパーティ製ソフトウェア・モデルを利用しています。
配布物には各ライセンスの要求に従い、本表記を同梱します。

---

## 機械学習モデル

### WD ViT Tagger v3

- 配布元: [SmilingWolf/wd-vit-tagger-v3](https://huggingface.co/SmilingWolf/wd-vit-tagger-v3)
- ライセンス: Apache License 2.0
- 用途: スクリーンショットの自動タグ付け（ローカル ONNX 推論）
- 備考: モデルファイル（`model.onnx` / `selected_tags.csv`）はアプリ初回利用時に
  ユーザーの操作で HuggingFace からダウンロードされ、ローカルに保存されます。

---

## 動画処理エンジン（FFmpeg）

Shiori は動画クリップの録画後トリミング・サムネイル生成・尺の判定・書き出し時の mp4（H.264）変換に FFmpeg を利用します。

- 同梱ビルド: **`ffmpeg-n6.1.2-192-g78690eba61-win64-lgpl-6.1`**
  （[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) の autobuild-2025-07-31-14-15 リリース）
- ライセンス: **GNU Lesser General Public License v3（LGPL v3）**
- ビルド構成: `--enable-version3` 付きの LGPL ビルドで、GPL を要求する構成要素
  （`libx264` / `libx265` / `libxvid` / `libvidstab` / `librubberband` 等）は**すべて無効**です。
  Shiori が利用するのは `libvpx`（VP8/VP9）・`libopus`・`libopenh264`・`aac`・`mjpeg` と
  標準フィルタのみで、いずれも LGPL ビルドに含まれます。
  **mp4 での書き出しに使う H.264 エンコーダは、GPL の `libx264` ではなく
  `libopenh264`（Cisco Systems 製・BSD-2-Clause）です。**
- 用途: 録画クリップのトリミング・サムネイル生成・タイムラインストリップ生成・尺およびフレーム時刻の取得・
  撮り逃し検証用のフレーム署名・書き出し時の H.264 変換
- 呼び出し形態: アプリ本体とは**リンクせず、独立した実行ファイルを子プロセスとして起動**して利用します。
  バイナリは**改変せず**そのまま同梱・再配布します。
- ライセンス全文: 配布物に同梱される `ffmpeg-LICENSE.txt`（LGPL v3 全文）を参照
- 対応ソースコード: 本バイナリに対応する FFmpeg のソース一式を
  [GitHub Releases](https://github.com/salty032/shiori/releases) の各リリースに添付しています。
  同じソースは [git.ffmpeg.org](https://git.ffmpeg.org/ffmpeg.git) のコミット `78690eba61`
  からも取得できます（リリース系列は `n6.1.2`）。ビルドスクリプトおよびビルド環境の構成は
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) で公開されています。

---

## 主要な npm 依存パッケージ

| パッケージ | ライセンス | 用途 |
|---|---|---|
| Electron | MIT | アプリケーション基盤 |
| React / React DOM | MIT | UI |
| zustand | MIT | 状態管理 |
| better-sqlite3 | MIT | メタデータDB |
| onnxruntime-node | MIT | ONNX 推論ランタイム |
| ws | MIT | WebSocket サーバー |
| screenshot-desktop | MIT | スクリーンショット取得 |
| fix-webm-duration | MIT | 録画 WebM の尺メタデータ補正 |
| @tanstack/react-virtual | MIT | 仮想スクロール |
| electron-updater | MIT | 自動更新 |

配布物には、実際にインストールされた本番用 npm 依存パッケージからビルド時に自動生成する
`THIRD-PARTY-LICENSES.txt` を同梱します。

---

## アイコン素材

- [Shiori icon by Icons8](https://icons8.com)
- 用途: アプリケーションおよびブラウザ拡張機能のアイコン

---
