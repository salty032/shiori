// renderer 側の文言解決。表示言語は settingsStore が持つ Settings の一部なので、
// i18n 専用の Context は作らない（設定の真実を 2 か所に置かないため）。
//
// 使い分けは 1 点だけ守ること：
//   * React コンポーネント / フックの中 → useT()
//     言語を購読するので、設定画面で切り替えた瞬間に再描画される。
//   * ストア・イベントハンドラなど React の外 → t()
//     購読しないため、呼んだ瞬間の言語で 1 度だけ解決する。トーストのように
//     「その場で文字列を作って投げる」用途はこれでよい。
//
// コンポーネント内で t() を使うと言語切り替えで再描画されず、古い言語のまま残る。
import { useMemo } from 'react'
import { useSettingsStore } from './stores/settingsStore'
import {
  translate, translatePlural, LOCALE_TAG,
  type MessageKey, type Params, type Lang
} from '../../shared/i18n'

export type { MessageKey, Lang }

export type Translate = {
  t: (key: MessageKey, params?: Params) => string
  // 英語で件数により語形が変わる文言用。辞書に `<base>.one` / `<base>.other` を置く。
  tp: (base: string, count: number, params?: Params) => string
  // toLocaleString / toLocaleDateString へ渡す BCP 47 タグ。引数なしで呼ぶと OS ロケール
  // 依存になり、表示言語と書式がちぐはぐになるため必ずこれを渡す。
  locale: string
}

function useLang(): Lang {
  return useSettingsStore((s) => s.settings.language)
}

export function useT(): Translate {
  const lang = useLang()
  return useMemo(() => ({
    t: (key, params) => translate(lang, key, params),
    tp: (base, count, params) => translatePlural(lang, base, count, params),
    locale: LOCALE_TAG[lang],
  }), [lang])
}

// React の外から使う版。zustand の getState() は購読しないので、呼び出し時点の言語で解決する。
export function currentLang(): Lang {
  return useSettingsStore.getState().settings.language
}

export function t(key: MessageKey, params?: Params): string {
  return translate(currentLang(), key, params)
}

export function tp(base: string, count: number, params?: Params): string {
  return translatePlural(currentLang(), base, count, params)
}

export function currentLocale(): string {
  return LOCALE_TAG[currentLang()]
}
