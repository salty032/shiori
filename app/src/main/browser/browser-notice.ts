import { broadcastMessage } from './ws-server'

type NoticeLevel = 'info' | 'success' | 'warning' | 'error'

export function sendBrowserNotice(level: NoticeLevel, message: string): void {
  broadcastMessage({ type: 'notice', level, message })
}
