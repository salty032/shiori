import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 知らせは「見ている場所に 1 つだけ」。ブラウザに出せたらアプリには出さず、出せなかったときだけアプリに回す。
const broadcastMessage = vi.fn()
let connected = true
let handler: ((msg: { type: string; requestId?: string }) => void) | null = null
vi.mock('./ws-server', () => ({
  broadcastMessage: (...args: unknown[]) => broadcastMessage(...args),
  hasExtensionClient: () => connected,
  onExtensionMessage: (h: typeof handler) => { handler = h; return () => { if (handler === h) handler = null } }
}))
const sendToRenderer = vi.fn()
vi.mock('../system/windows', () => ({
  sendToRenderer: (...args: unknown[]) => sendToRenderer(...args),
  // ウィンドウがあるものとしてすぐ実行する（無いときに預かるのは windows.ts の役目）。
  whenRendererReady: (fn: () => void) => fn()
}))

import { sendAppFailureNotice, sendWatchingNotice } from './browser-notice'
import { CH } from '../../shared/api'

beforeEach(() => {
  vi.useFakeTimers()
  broadcastMessage.mockClear()
  sendToRenderer.mockClear()
  connected = true
  handler = null
})
afterEach(() => vi.useRealTimers())

const sentId = (): string => (broadcastMessage.mock.calls[0][0] as { id: string }).id

describe('sendWatchingNotice', () => {
  it('ページが「出した」と返したら、アプリには出さない', () => {
    sendWatchingNotice('error', '録画の保存に失敗しました')
    expect(broadcastMessage).toHaveBeenCalledWith({ type: 'notice', level: 'error', message: '録画の保存に失敗しました', id: sentId() })
    handler?.({ type: 'notice-shown', requestId: sentId() })
    vi.advanceTimersByTime(5000)
    expect(sendToRenderer).not.toHaveBeenCalled()
  })

  it('返事が無ければ（別のタブを見ていた・古い拡張）、アプリに閉じるまで残る知らせとして出す', () => {
    sendWatchingNotice('error', '録画の保存に失敗しました')
    vi.advanceTimersByTime(5000)
    expect(sendToRenderer).toHaveBeenCalledWith(CH.appNotice, { level: 'error', message: '録画の保存に失敗しました', sticky: true })
  })

  it('別の知らせへの返事では、出せたことにしない', () => {
    sendWatchingNotice('warning', '映像が見つかりませんでした')
    handler?.({ type: 'notice-shown', requestId: 'other' })
    vi.advanceTimersByTime(5000)
    expect(sendToRenderer).toHaveBeenCalledTimes(1)
  })

  it('拡張が繋がっていなければ、ブラウザへ送らずすぐアプリに出す', () => {
    connected = false
    sendWatchingNotice('error', 'キャプチャの保存に失敗しました')
    expect(broadcastMessage).not.toHaveBeenCalled()
    expect(sendToRenderer).toHaveBeenCalledWith(CH.appNotice, { level: 'error', message: 'キャプチャの保存に失敗しました', sticky: true })
  })
})

describe('sendAppFailureNotice', () => {
  it('アプリにだけ、閉じるまで残る知らせとして出す', () => {
    sendAppFailureNotice('error', 'ホットキーを登録できませんでした')
    expect(broadcastMessage).not.toHaveBeenCalled()
    expect(sendToRenderer).toHaveBeenCalledWith(CH.appNotice, { level: 'error', message: 'ホットキーを登録できませんでした', sticky: true })
  })
})
