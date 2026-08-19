// 検索の表記ゆれ吸収。SQLite には NFKC も Unicode プロパティ判定も無いため、正規化は
// 書き込み側の JS（main の db.ts）で行い、結果を search_text 列へ格納する
// （設計・実測の根拠と、意識的に外した案は docs/SPEC.md 5章）。
//
// 落とすのは「ユーザーが正しく打っているのに、配信サイト側の表記（半角カナ・全角英数等）
// のせいで無言で0件になる」失敗。タイポ耐性やスコアリングは対象外。

// カタカナ(全角) → ひらがな。NFKC が半角カナを全角カナへ寄せた後に通すので、半角/全角
// どちらのカナ入力でも同じ結果になる。長音符「ー」(U+30FC) はこの範囲の外（Lm）なので
// 巻き込まれず残る（「サーバ」と「サーバー」の区別を保つため意図的に残す）。
function katakanaToHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
}

// 除去対象：記号(P)・記号その他(S)・区切り(Z、全角スペース込み)・書式文字(Cf、ZWJ等)、
// および異体字セレクタ(U+FE0E/U+FE0F)。異体字セレクタは Unicode 上は Mn（結合文字）だが、
// 結合文字全般(\p{M})を対象にすると NFKC で未合成のまま残る他言語の発音区別符号まで
// 巻き込むため、絵文字の装飾記号だけを名指しで落とす。
const STRIP_RE = /[\p{P}\p{S}\p{Z}\p{Cf}︎️\s]/gu

export function normalizeSearchText(s: string): string {
  return katakanaToHiragana(s.normalize('NFKC').toLowerCase()).replace(STRIP_RE, '')
}

// 正規化ルールの版。**この関数の出力が変わる変更をしたら必ず上げること。**
//
// 保存側の `images.search_text` は書き込み時に一度だけ計算して置いてあるため、ルールを
// 変えても既存の行は古い結果のまま残る。検索語は新ルールで正規化されるので、同じ語が
// 「古い行には当たらないが新しい行には当たる」状態になる。行によって当たったり当たらな
// かったりするのは、この機能がまさに潰そうとしている「説明の付かない検索結果」そのもの。
// db.ts の initDb がこの数字の変化を見て search_text を全行作り直す。
export const SEARCH_NORMALIZE_VERSION = 1

// search_text 列の中身。title/memo それぞれを正規化して1列にまとめる（アプリは列を
// 指定した検索をしていないため分ける意味が無い）。挿入・タイトル/メモ更新の3経路から
// 呼ぶ（詳細は docs/SPEC.md 5章）。
export function buildSearchText(title: string | null | undefined, memo: string | null | undefined): string {
  return `${normalizeSearchText(title ?? '')}\n${normalizeSearchText(memo ?? '')}`
}
