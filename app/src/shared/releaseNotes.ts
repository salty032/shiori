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
export const RELEASE_NOTES: Record<string, Record<Lang, string[]>> = {
  '1.2.0': {
    ja: [
      'クリップのコマ送りが、素材の実際のコマ単位で動くようになりました。映像の左下に「コマ 128 / 719」と今どのコマかが出ます。',
      '専用の絵を撮れなかったコマには「流用」「要確認」と表示されます。コマ送りで絵が変わらないとき、素材でも同じ絵が続いているのか、撮り逃しによるものなのかをその場で見分けられます。',
      '録画後に撮り逃したコマを画像で照合し、実際に確認が必要なコマ数だけを詳細パネルに表示するようになりました。',
      '画面キャプチャの取得枚数を引き上げました。24fps の素材では撮り逃しがほとんど出なくなります。',
      '60fps の素材で映像が粗くなる問題を直しました。素材のコマ数に応じて録画のビットレートを上げます。',
      'コマ精度を保証するのは 24 / 29.97 / 30fps の素材までです。60fps の素材でも録画はできますが、撮り切れないコマが「流用」「要確認」として画面に出ます。',
      'クリップもビューアで拡大できるようになりました（+ / − / ホイール）。画質を目視で確かめられます。',
      '検索が半角カナ・全角英数の違いを吸収するようになりました。「ドキドキ」と打てば「ﾄﾞｷﾄﾞｷ」を含むタイトルも見つかります。',
      '録画を止めたあと、配信プレーヤーの操作パネルがすぐ戻るようになりました。',
      '詳細パネルに、記録した解像度が出るようになりました。',
    ],
    en: [
      'Frame stepping in clips now moves one real source frame at a time. The current position is shown at the bottom left of the video as “Frame 128 / 719”.',
      'Frames that could not be captured on their own are marked “reused” or “needs review”, so you can tell whether an unchanged picture comes from the source or from a missed capture.',
      'After recording, missed frames are checked against the recorded pictures, and the detail panel now shows only the frames that genuinely need review.',
      'Screen capture now delivers more frames per second. With 24fps sources, missed frames are now rare.',
      'Fixed 60fps sources looking coarse. The recording bitrate now scales with how many frames the source actually has.',
      'Frame accuracy is guaranteed for 24 / 29.97 / 30fps sources. 60fps sources still record, but frames that cannot be captured are shown as “reused” or “needs review”.',
      'Clips can now be zoomed in the viewer (+ / − / wheel), so you can check the recorded quality by eye.',
      'Search now ignores half-width katakana and full-width alphanumeric differences, so typing “ドキドキ” also finds titles written as “ﾄﾞｷﾄﾞｷ”.',
      'The streaming player’s controls now come back as soon as recording stops.',
      'The detail panel now shows the resolution the clip was recorded at.',
    ],
  },
}

// 表示言語に対応する変更点配列を返す。未定義バージョン・未翻訳言語は undefined。
export function releaseNotesFor(version: string, lang: Lang): string[] | undefined {
  return RELEASE_NOTES[version]?.[lang]
}
