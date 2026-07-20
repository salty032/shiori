// 日本語/英語の 2 言語だけを対象にした最小の文言解決。汎用の i18n 基盤（ロケール交渉・
// フォールバック連鎖・名前空間の遅延ロード）は意図的に作らない。対応言語が 2 つに
// 固定されている限り、辞書 2 枚を直接引くのが最も読みやすく、壊れにくい。
//
// 訳し忘れは型で防ぐ。en.ts は Record<MessageKey, string> を満たす必要があるため、
// ja.ts にキーを足して en.ts に足し忘れると npm run typecheck が落ちる。
import type { Lang } from '../types'
import { ja } from './ja'
import { en } from './en'

export type { Lang }
export type MessageKey = keyof typeof ja

const DICTS: Record<Lang, Record<MessageKey, string>> = { ja, en }

// {name} 形式のプレースホルダだけを差し込む。式や書式指定は持たせない
// （辞書側に表示ロジックが漏れ出すと翻訳者が読めなくなるため）。
export type Params = Record<string, string | number>

export function translate(lang: Lang, key: MessageKey, params?: Params): string {
  const template = DICTS[lang][key]
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

// 英語は件数で語形が変わる（1 item / 2 items）。該当する文言だけ `<base>.one` と
// `<base>.other` の 2 キーを辞書に持たせ、ここで振り分ける。日本語側は両キーに
// 同じ文字列を入れておけばよい（数で形が変わらないため）。
// count は params にも自動で渡すので、辞書側は {count} をそのまま書ける。
export function translatePlural(
  lang: Lang,
  base: string,
  count: number,
  params?: Params
): string {
  const key = `${base}.${count === 1 ? 'one' : 'other'}` as MessageKey
  return translate(lang, key, { count, ...params })
}

// 数値・日付の書式に使う BCP 47 タグ。表示言語と書式を必ず一致させるため、
// toLocaleString() を引数なしで呼ぶ（＝OS ロケール依存）箇所はすべてこれを渡す。
export const LOCALE_TAG: Record<Lang, string> = { ja: 'ja-JP', en: 'en-US' }

// OS の言語設定から初期表示言語を 1 度だけ決める（app.getLocale() の戻り値を渡す）。
// 以降はユーザーが設定画面で選んだ値を settings.json に持ち、OS 側の変更には追従しない。
export function langFromLocale(locale: string): Lang {
  return locale.toLowerCase().startsWith('ja') ? 'ja' : 'en'
}
