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
export const RELEASE_NOTES: Record<string, Record<Lang, string[]>> = {}

// 表示言語に対応する変更点配列を返す。未定義バージョン・未翻訳言語は undefined。
export function releaseNotesFor(version: string, lang: Lang): string[] | undefined {
  return RELEASE_NOTES[version]?.[lang]
}
