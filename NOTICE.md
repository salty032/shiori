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

Shiori は動画クリップの録画後トリミング・サムネイル生成・尺の判定に FFmpeg を利用します。

- 取得元: [ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static)（npm ラッパー、GPL-3.0-or-later）が同梱する
  Windows 向けバイナリ `ffmpeg.exe`
- 同梱ビルド: **FFmpeg 6.1.1 essentials build（`gyan.dev`）**
- ライセンス: **GNU General Public License v3（GPL v3）**
- 用途: ffmpeg / ffprobe 相当機能によるトリミング・サムネイル・尺取得
- 呼び出し形態: アプリ本体とは**リンクせず、独立した実行ファイルを子プロセスとして起動**して利用します。
  バイナリは**改変せず**そのまま同梱・再配布します。
- ライセンス全文: 配布物に同梱される `ffmpeg.exe.LICENSE`（GPL v3 全文）および `ffmpeg.exe.README`（ビルド構成）を参照
- 対応ソースコード: FFmpeg 6.1.1 のソースは [ffmpeg.org](https://ffmpeg.org/download.html) および
  [git.ffmpeg.org](https://git.ffmpeg.org/ffmpeg.git)（タグ `n6.1.1`）から入手できます。
  Windows ビルドの構成は [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) を参照してください。

> GPL v3 は同ライセンスのバイナリを再配布する際、対応するソースコードの提供（または書面による申し出）を求めます。
> Shiori 本体のライセンスとは独立した義務のため、配布形態の詳細は上記の入手先案内で満たしています。

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

配布時は、本表記と各パッケージのライセンス条件に従って必要なライセンス情報を同梱します。

---

## アイコン素材

- [Shiori icon by Icons8](https://icons8.com)
- 用途: アプリケーションおよびブラウザ拡張機能のアイコン

---
