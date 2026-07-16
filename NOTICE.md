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
| @tanstack/react-virtual | MIT | 仮想スクロール |
| electron-updater | MIT | 自動更新 |

配布時は、本表記と各パッケージのライセンス条件に従って必要なライセンス情報を同梱します。

---

## アイコン素材

- [Shiori icon by Icons8](https://icons8.com)
- 用途: アプリケーションおよびブラウザ拡張機能のアイコン

---
