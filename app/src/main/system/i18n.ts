// main プロセス側の文言解決。呼び出しのたびに loadSettings() から現在の言語を読むので、
// 設定変更後に main が保持している状態を作り直す必要はない（loadSettings はキャッシュ済みで
// ディスクアクセスは発生しない）。唯一の例外は、生成時に文字列を焼き込むトレイメニューで、
// これだけは言語変更時に rebuildTray() で組み直す。
import { loadSettings } from './settings'
import { translate, LOCALE_TAG, type MessageKey, type Params, type Lang } from '../../shared/i18n'

export function currentLang(): Lang {
  return loadSettings().language
}

export function t(key: MessageKey, params?: Params): string {
  return translate(currentLang(), key, params)
}

function currentLocaleTag(): string {
  return LOCALE_TAG[currentLang()]
}
