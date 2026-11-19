import { randomUUID } from 'crypto'
import { broadcastMessage, hasExtensionClient, onExtensionMessage } from './ws-server'
import { sendToRenderer, whenRendererReady } from '../system/windows'
import { CH } from '../../shared/api'

type NoticeLevel = 'info' | 'success' | 'warning' | 'error'

// 知らせは、その出来事が起きたときに利用者が見ている場所に 1 つだけ出す（2026-11-18 に決めた）。
// ホットキーで撮る・録るときに起きたことは視聴中のブラウザに、アプリを操作して起きたことはアプリに。
// 以前は録画・キャプチャの失敗をアプリとブラウザの両方に出していて、同じ知らせが 2 か所に出ていた。

// ブラウザに出せたかの返事を待つ時間。拡張はアクティブなタブへ送り、ページが出したら返す（ローカルの往復）。
const NOTICE_SHOWN_TIMEOUT_MS = 1500

/**
 * 視聴中のブラウザにだけ出す。出せたかどうかを確かめないので、成功の知らせと、すぐ書き換える
 * 「確認中」（pending）にだけ使う。見逃しても困らないものだけ。
 * @param pending 続きの通知で書き換える予定の通知。拡張は次の通知が来るまで消さずに残す
 *   （録画の「撮り逃しを確認中」。照合が終わる前に消えると、結果が出る前に一度消えてまた出る）。
 */
export function sendBrowserNotice(level: NoticeLevel, message: string, pending = false): void {
  broadcastMessage(pending ? { type: 'notice', level, message, pending: true } : { type: 'notice', level, message })
}

/**
 * アプリの画面に、閉じるまで消えない知らせとして出す。ウィンドウが無いとき（閉じたらメモリを空ける設定・
 * 起動直後）は捨てずに、次に画面ができたときに出す。
 */
export function sendAppFailureNotice(level: 'warning' | 'error', message: string): void {
  whenRendererReady(() => sendToRenderer(CH.appNotice, { level, message, sticky: true }))
}

/**
 * ホットキーで撮る・録るときに起きた警告・失敗。**視聴中のブラウザに出し、出せなかったときだけアプリに回す。**
 *
 * ホットキーは Shiori が前面でないときに押すので、そのとき見ているのはブラウザ。ただし拡張は
 * アクティブなタブにしか出せず、配信以外のタブを見ていると黙って消える。拡張が繋がっていないときも同じ。
 * 出せたかはページから返してもらい（notice-shown）、返らなければアプリに閉じるまで残す
 * （ウィンドウを隠していても、次に開いたときに見える）。
 * 古い拡張は返事をしないので、拡張を更新するまではアプリにも出る（黙って消えるよりよい）。
 */
export function sendWatchingNotice(level: 'warning' | 'error', message: string): void {
  if (!hasExtensionClient()) { sendAppFailureNotice(level, message); return }
  const id = randomUUID()
  let settled = false
  const off = onExtensionMessage((msg) => {
    if (msg.type !== 'notice-shown' || msg.requestId !== id || settled) return
    settled = true
    clearTimeout(timer)
    off()
  })
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    off()
    sendAppFailureNotice(level, message)
  }, NOTICE_SHOWN_TIMEOUT_MS)
  broadcastMessage({ type: 'notice', level, message, id })
}
