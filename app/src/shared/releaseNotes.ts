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
  '1.3.0': {
    ja: [
      '録画したクリップを mp4 で書き出せるようになりました。設定 > データ > 動画の変換 で「mp4」を選ぶと、書き出すときに H.264 へ変換します（既定はこれまでどおり webm です）。画質はわずかに落ちますが、コマの位置と枚数は変わりません。効くのは選んだクリップの書き出しだけで、ライブラリはそのままです。変換できなかったクリップは元の形式のまま書き出し、その本数を画面に表示します。',
      '録画の先頭でコマが欠けにくくなりました。Alt+D を押したあと、記録は準備が整ってから始まります。待っている間は映像の中央に「録画の準備中」と表示され、この表示が消えた時点が記録の開始です（待つのは最長 2 秒です）。',
      'コマ送りの注記を作り直しました。絵が撮れていないコマは「未取得」、コマ自体が届いていない箇所は「8 コマ抜け」、録画全体としてコマ送りが当てにならないものはコマ番号ごと赤で「要注意」と表示されます。それぞれの意味は、コマ番号を押すと一覧で読めます。',
      '以前のバージョンでコマ単位の送りを諦め、黄色い「フレーム 128 / 719」と表示されていたクリップが、素材のコマ単位に戻ることがあります。起動してしばらくすると自動で見直します。',
      '詳細パネルの表示を整理しました。「未通知」「要確認」をやめ、取れていないコマの合計（「12コマ未取得」）と、録画全体の「要注意」だけを表示します。',
      'データの保護を強めました。新しいバージョンで更新したライブラリを古いバージョンで開こうとした場合は、書き換えずに停止します。ライブラリの構造を変える更新の前には必ずバックアップを取り、取れなかったときは何も変更せず中止します。また、設定ファイルを読み込めなかった起動では、設定の変更をファイルへ書き込まなくなりました（これまでは初期設定で上書きされていました）。',
    ],
    en: [
      'Clips can now be exported as mp4. Choose “mp4” under Settings > Data > Video conversion and Shiori converts to H.264 on export (webm stays the default). The picture loses a little quality, but frame positions and the frame count stay the same. Only the export is converted — your library is left as it is. Clips that could not be converted are exported in their original format, and the number is shown on screen.',
      'Fewer frames are lost at the start of a recording. After Alt+D, recording now waits until capture has settled. While it waits, “Preparing to record” appears in the middle of the video, and recording begins the moment it disappears (the wait is at most 2 seconds).',
      'Frame-stepping annotations have been rebuilt. A frame whose picture was not captured is marked “not captured”, a point where the frames themselves never arrived is marked “8 frames missing”, and a clip whose frame stepping cannot be trusted turns the frame number red and reads “unreliable”. Press the frame number to read what each one means.',
      'Clips that earlier versions gave up on — showing a yellow “Frame 128 / 719” instead of source frames — may go back to stepping one source frame at a time. Shiori re-checks them shortly after startup.',
      'The detail panel has been tidied up. “Unreported” and “needs review” are gone; it now shows the total number of frames that are not there (“12 frames not captured”) and, for the clip as a whole, “unreliable”.',
      'Your data is better protected. A library that a newer version of Shiori has updated will not be opened or rewritten by an older one. A backup is now required before any update that changes the library structure — if it cannot be made, the update is cancelled and nothing is changed. And when the settings file cannot be read at startup, changes are no longer written to it (they used to overwrite it with the defaults).',
    ],
  },
  '1.2.0': {
    ja: [
      '動画クリップを録画できるようになりました。動画の再生中に Alt+D を押すと、最長30秒のクリップを録画できます。録画したクリップはアプリ内で再生・トリミングできるほか、手元にある .webm / .mp4 ファイルをドロップして取り込むこともできます。',
      'コマ送りに使うキーを「,」と「.」に変更しました。これまでの Shift+←/→ では操作できません。ブラウザのプレーヤーと、アプリのビューア・トリミング画面で共通のキーを使用できます。',
      'クリップを、元の動画のコマ単位で送れるようになりました。映像の左下には、現在の位置が「コマ 128 / 719」のように表示されます。',
      '個別に取り込めなかったコマは「未取得」、素材のコマとの対応を保証できない録画は「要注意」と表示されます。コマ送りの精度を保証できない場所や録画を、その場で確認できます。',
      'コマ単位の精度を保証できる素材は、24 / 29.97 / 30fps です。60fps の素材も録画できますが、取り込めなかったコマや精度を保証できない録画には「未取得」または「要注意」と表示されます。',
      'タイムシートを作成できるようになりました。コマ送りをしながら数字を入力して表を作成し、その内容をコピーして東映デジタルタイムシートへ直接貼り付けられます。',
      'クリップをビューアで拡大できるようになりました（+ / − / ホイール）。録画した映像の画質を細部まで確認できます。',
      '画面の配色、角の丸み、余白を見直しました。ライトテーマとダークテーマで色のルールを統一し、選択中のサムネイルを判別しやすくしました。全画面表示でサムネイルが小さくなりすぎる問題も修正しています。',
      '半角カナと全角英数字を区別せずに検索できるようになりました。たとえば「ドキドキ」と入力すると、「ﾄﾞｷﾄﾞｷ」を含むタイトルも見つかります。複数のキーワードは、入力する順序にかかわらず絞り込みに使用できます。',
      'Bilibili で、作品名に宣伝文句が混ざる問題、話を切り替えた直後に前の話の名前が入る問題、プレーヤーの操作パネルが映り込む問題を修正しました。また、DMM TV でコマ送りのキーを押すと再生速度が変わる問題も修正しています。',
      '記録したタグ、メモ、タイムシートをより安全に保管できるようになりました。起動時にデータが壊れていないかを確認し、1日1回、過去7日分のバックアップを保存します。設定を保存できなかった場合にも、保存済みと表示されていた問題を修正しました。',
      'ブラウザ拡張とアプリの接続が切れた場合に、対処方法を画面に表示するようになりました。',
      '変更点のお知らせを、あとからいつでも読み返せるようになりました。また、GitHub アカウントがなくても不具合や要望を報告できます。',
      '詳細パネルに、記録した解像度を表示するようになりました。他の人から受け取った素材は、自分でキャプチャした素材と取得日順で混在しないよう、分けて表示されます。',
    ],
    en: [
      'You can now record video clips. Press Alt+D while a player is playing to capture a clip of up to 30 seconds. Clips play and trim inside Shiori, and you can also drop your own .webm / .mp4 files in.',
      'Frame stepping has moved to the “,” and “.” keys. Shift+←/→ no longer works. The same keys are used in the browser player and in Shiori’s viewer and trimmer.',
      'Frame stepping in clips now moves one real source frame at a time. The current position is shown at the bottom left of the video as “Frame 128 / 719”.',
      'Frames that could not be captured are marked “not captured”, and clips whose source-frame alignment cannot be guaranteed are marked “unreliable”. This makes accuracy limitations visible while you step through a clip.',
      'Frame accuracy is guaranteed for 24 / 29.97 / 30fps sources. 60fps sources still record, but missing frames or clips whose accuracy cannot be guaranteed are marked “not captured” or “unreliable”.',
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
