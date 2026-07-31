# デモ素材の置き場

Web デモ版（GitHub Pages）が表示する画像・動画をこのフォルダに置きます。

## 置き方

このフォルダ直下にファイルを入れるだけです。サブフォルダは見ません。

- 画像: `.png` `.jpg` `.jpeg` `.webp` `.avif` `.gif`
- 動画: `.mp4` `.webm` `.mov`

ファイル名がそのまま作品名（タイトル）になります（`_` と `-` は空白に変換）。
撮影日時・サービス・再生位置・タグは `app/scripts/build-demo-manifest.mjs` が
5 件ずつ 1 日にまとめて自動で割り振ります。

> **公開されます。** GitHub Pages は誰でも見られるので、配信サービスの画面を
> キャプチャしたものは置かないでください。権利が自分にある素材だけを置くこと。

## 個別に指定したいとき

`meta.json` を置くとファイル単位で上書きできます。指定しなかった項目は自動割り当てのままです。

```json
{
  "defaults": { "host": "youtube.com" },
  "files": {
    "sample.png": {
      "title": "サンプル 第3話",
      "host": "netflix.com",
      "url": "https://www.netflix.com/",
      "currentTime": 742,
      "capturedAt": "2026-07-20T21:04:00",
      "memo": "この構図がよかった",
      "tags": ["背景", "作画"],
      "aiTags": ["1girl", "outdoors"]
    }
  }
}
```

- `currentTime` / `duration` は秒。`duration` を省いた動画は、起動時にブラウザが実尺を読みます。
- `tags` は手動タグ、`aiTags` は AI タグ扱い（設定の「AIタグを表示」で出し分けられます）。

## ビルド

`manifest.json` はビルドのたびに生成されるので、手で書く必要も、コミットする必要もありません。

```
npm run web:build     # 目録生成 + ビルド（app/dist-web/ へ出力）
npm run web:dev       # ローカルで確認
```
