// 配信サービスのページの作りが変わって、拡張が黙って壊れたことに気づくためのログ。
//
// 作品名が空になる・撮影中に隠すはずのプレーヤーの UI が写り込む、はどちらも画面に何も出ず、撮った後に
// 気づくしかない。**ほかの利用者のデータは集めない**（2026-11-19 に決めた）。診断の目印（diag-log.on）の
// ある PC でだけ main.log に 1 行残し、本人が使っていて壊れたら直す。目印の無い PC では何もしない。
import { diagLogEnabled } from '../system/diag-log'

// 同じサービスで同じことを何度も書かない（撮るたびに書くとログが埋まる）。起動ごとに 1 回。
const noted = new Set<string>()

function hostOf(url: string | null | undefined): string {
  if (!url) return 'unknown'
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return 'unknown' }
}

function noteOnce(key: string, line: string): void {
  if (noted.has(key) || !diagLogEnabled()) return
  noted.add(key)
  console.warn(line)
}

/** 撮った・録ったものに作品名が入らなかった（拡張がタブ名やページから読めなかった）。 */
export function noteMissingTitle(url: string | null | undefined, what: 'capture' | 'clip'): void {
  const host = hostOf(url)
  noteOnce(`title:${host}`, `[ext-diag] ${host}: saved a ${what} without a title (the extension could not read it from the page)`)
}

/**
 * 撮影の前に隠すはずのプレーヤーの UI が、ページに 1 つも見つからなかった（拡張の content-capture.js）。
 * ページの作りが変わったか、撮った瞬間に UI が出ていなかっただけのこともある。
 */
export function notePlayerUiMissing(host: string): void {
  noteOnce(`ui:${host}`, `[ext-diag] ${host}: none of the player UI selectors matched while hiding it for a capture (page layout changed, or the UI was simply not shown)`)
}
