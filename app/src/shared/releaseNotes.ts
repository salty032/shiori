import type { Lang } from './types'

// バージョンごとの「変更点お知らせ」文面。リリースのたびに手動で1エントリ追記する。
// キーは package.json の version と一致させること。
// エントリが無い（または空配列の）バージョンでは、お知らせモーダルの代わりに
// 従来通りの「Shiori を vX.X.X に更新しました」トーストにフォールバックする
// （version-notice.ts の decideVersionNotice を参照）。
//
// 日英の両方を必ず書くこと（表示言語で出し分ける）。まだ英語文面が無い項目は
// 英語ユーザーにお知らせモーダルを出さないため、そのバージョンの en を空配列にしておく
// と、英語側だけ従来トーストにフォールバックする。
// 書き方の指針：**利用者から見て何が変わったか**だけを書く。内部の用語（フレーム表・供給
// レート・オフセット等）は出さない。読む人はコードを知らないので、画面のどこがどう変わるかで
// 書けないなら、その項目は載せない方がよい。
// **保証できないことは書かない**のも同じ（「撮り逃しが 0 になった」と言い切らない。素材と
// 状況次第で出る）。
//
// **書く範囲は「前に配った版から何が変わったか」。** 直前の作業で変えた分ではない。
// 1.2.0 では一度これを取り違えて、直前に触っていたコマ送りの話だけを並べていた。実際には
// 1.1.3 に録画もタイムシートも無く、コマ送りのキーまで変わっている。いちばん大きい変更が
// 1 行も無いお知らせになりかけた。**書く前に前回のタグとの差分を見ること。**
export const RELEASE_NOTES: Record<string, Record<Lang, string[]>> = {
  '1.2.0': {
    ja: [
      '動画クリップを録画できるようになりました。再生中のプレーヤーで Alt+D を押すと、最長30秒のクリップが撮れます。撮ったクリップはアプリの中で再生・トリミングでき、手元の .webm / .mp4 をドロップして取り込むこともできます。',
      'コマ送りのキーが「,」と「.」に変わりました。これまでの Shift+←/→ では動きません。ブラウザのプレーヤーでも、アプリのビューア・トリミング画面でも同じキーです。',
      'クリップのコマ送りが、素材の実際のコマ単位で動くようになりました。映像の左下に「コマ 128 / 719」と今どのコマかが出ます。',
      '専用の絵を撮れなかったコマには「流用」「要確認」と表示されます。コマ送りで絵が変わらないとき、素材でも同じ絵が続いているのか、撮り逃しによるものなのかをその場で見分けられます。',
      'コマ精度を保証するのは 24 / 29.97 / 30fps の素材までです。60fps の素材でも録画はできますが、撮り切れないコマが「流用」「要確認」として画面に出ます。',
      'タイムシートを作れるようになりました。コマ送りしながら数字を打つと表ができ、コピーして東映デジタルタイムシートへそのまま貼り付けられます。',
      'クリップもビューアで拡大できるようになりました（+ / − / ホイール）。画質を目視で確かめられます。',
      '画面の配色・角の丸み・余白を作り直しました。ライトとダークで別々だった色の決め方を揃え、選択中のサムネイルがどれか分かるようにしています。全画面にするとサムネイルが小さすぎて中身が分からなかった問題も直しました。',
      '検索が半角カナ・全角英数の違いを吸収するようになりました。「ドキドキ」と打てば「ﾄﾞｷﾄﾞｷ」を含むタイトルも見つかります。覚えている語を順不同で並べても絞り込めます。',
      'Bilibili で作品名に宣伝文句が混ざる・話を切り替えた直後に前の話の名前が入る・プレーヤーの操作パネルが写り込む問題と、DMM TV でコマ送りを押すと再生速度が変わる問題を直しました。',
      '記録したタグ・メモ・タイムシートの守りを厚くしました。起動時に壊れていないかを確かめ、1日1回バックアップを取ります（7日分）。設定が保存できていないのに保存できたように見えていた問題も直しています。',
      'ブラウザ拡張がアプリに繋がらなくなったとき、画面に打つ手が出るようになりました。',
      '変更点のお知らせを、あとからいつでも読み返せるようになりました。不具合・要望の報告に GitHub のアカウントは要りません。',
      '詳細パネルに、記録した解像度が出るようになりました。他の人からもらった素材は、自分のキャプチャと取得日で混ざらないように分けて並びます。',
    ],
    en: [
      'You can now record video clips. Press Alt+D while a player is playing to capture a clip of up to 30 seconds. Clips play and trim inside Shiori, and you can also drop your own .webm / .mp4 files in.',
      'Frame stepping has moved to the “,” and “.” keys. Shift+←/→ no longer works. The same keys are used in the browser player and in Shiori’s viewer and trimmer.',
      'Frame stepping in clips now moves one real source frame at a time. The current position is shown at the bottom left of the video as “Frame 128 / 719”.',
      'Frames that could not be captured on their own are marked “reused” or “needs review”, so you can tell whether an unchanged picture comes from the source or from a missed capture.',
      'Frame accuracy is guaranteed for 24 / 29.97 / 30fps sources. 60fps sources still record, but frames that cannot be captured are shown as “reused” or “needs review”.',
      'You can now build a timesheet. Type numbers while stepping through frames, then copy the sheet and paste it straight into Toei Digital Timesheet.',
      'Clips can now be zoomed in the viewer (+ / − / wheel), so you can check the recorded quality by eye.',
      'Colours, corner rounding and spacing have been rebuilt. Light and dark themes now follow the same rules, the selected thumbnail is easy to pick out, and thumbnails no longer shrink too small to read in full screen.',
      'Search now ignores half-width katakana and full-width alphanumeric differences, so typing “ドキドキ” also finds titles written as “ﾄﾞｷﾄﾞｷ”. Words can also be typed in any order.',
      'Fixed Bilibili picking up promotional text in the title, keeping the previous episode’s title right after you switch episodes, and leaving the player controls in the picture — and DMM TV changing playback speed when you press the frame-step keys.',
      'Your tags, notes and timesheets are better protected. Shiori checks the library for damage at startup and keeps a daily backup (7 days). Settings that failed to save no longer look as though they saved.',
      'When the browser extension loses its connection to Shiori, the screen now tells you what to do.',
      'Release notes can now be reopened at any time, and reporting a bug or request no longer needs a GitHub account.',
      'The detail panel now shows the resolution the clip was recorded at. Material shared from someone else is kept separate from your own captures instead of mixing in by date.',
    ],
  },
}

// 表示言語に対応する変更点配列を返す。未定義バージョン・未翻訳言語は undefined。
export function releaseNotesFor(version: string, lang: Lang): string[] | undefined {
  return RELEASE_NOTES[version]?.[lang]
}
