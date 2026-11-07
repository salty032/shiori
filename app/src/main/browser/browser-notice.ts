import { broadcastMessage } from './ws-server'

type NoticeLevel = 'info' | 'success' | 'warning' | 'error'

/**
 * @param pending 続きの通知で書き換える予定の通知。拡張は次の通知が来るまで消さずに残す
 *   （録画の「撮り逃しを確認中」。照合が終わる前に消えると、結果が出る前に一度消えてまた出る）。
 */
export function sendBrowserNotice(level: NoticeLevel, message: string, pending = false): void {
  broadcastMessage(pending ? { type: 'notice', level, message, pending: true } : { type: 'notice', level, message })
}
