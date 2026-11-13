import { broadcastMessage } from './ws-server'
import { sendNotice } from '../system/windows'

type NoticeLevel = 'info' | 'success' | 'warning' | 'error'

/**
 * @param pending 続きの通知で書き換える予定の通知。拡張は次の通知が来るまで消さずに残す
 *   （録画の「撮り逃しを確認中」。照合が終わる前に消えると、結果が出る前に一度消えてまた出る）。
 */
export function sendBrowserNotice(level: NoticeLevel, message: string, pending = false): void {
  broadcastMessage(pending ? { type: 'notice', level, message, pending: true } : { type: 'notice', level, message })
}

/**
 * 録画・キャプチャの失敗を、Shiori の画面と視聴中のブラウザの両方へ出す。
 *
 * ホットキーは Shiori が前面でないときに押すので、失敗した瞬間に見ているのはブラウザ。
 * Shiori の画面だけに出すと気づかれず、「閉じたらメモリを空ける」設定でウィンドウが無いときは
 * 通知そのものが捨てられて、撮れたつもりのまま次へ進んでしまう。
 */
export function sendFailureNotice(level: 'warning' | 'error', message: string): void {
  sendNotice(level, message)
  sendBrowserNotice(level, message)
}
