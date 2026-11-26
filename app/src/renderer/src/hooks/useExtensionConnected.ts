// 拡張と繋がっているか。**設定画面と初回の案内で同じ判定を使う**——別々に書いていた頃は、
// 片方の秒数だけ変えると設定画面は「接続中」・案内は「未接続」と食い違う作りだった。
//
// extensionStatus は最後に受信したイベントのスナップショットなので、拡張を無効化したり
// ブラウザを閉じたりしても「受信中」のまま変わらない。画面を開いている間は 1 秒ごとに
// lastSeenAt からの経過時間を見て、タイムコード送信間隔（5 秒）の 3 回分途絶えたら「未受信」とみなす。
import { useEffect, useState } from 'react'
import type { ExtensionTimecode } from '../types'

export const EXTENSION_TIMEOUT_MS = 15_000

export type ExtensionStatus = { lastSeenAt: number; data: ExtensionTimecode } | null

export function isExtensionConnected(status: ExtensionStatus, now: number): boolean {
  return status !== null && now - status.lastSeenAt <= EXTENSION_TIMEOUT_MS
}

export function useExtensionConnected(status: ExtensionStatus): boolean {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return isExtensionConnected(status, now)
}
