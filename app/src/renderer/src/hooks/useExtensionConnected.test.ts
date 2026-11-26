import { describe, expect, it } from 'vitest'
import { EXTENSION_TIMEOUT_MS, isExtensionConnected } from './useExtensionConnected'
import type { ExtensionTimecode } from '../types'

const status = (lastSeenAt: number) => ({ lastSeenAt, data: {} as ExtensionTimecode })

// 設定画面と初回の案内が同じ判定を使う。境目を変えたら両方の表示が一緒に変わる。
describe('isExtensionConnected', () => {
  it('受信が無ければ未接続', () => {
    expect(isExtensionConnected(null, 1000)).toBe(false)
  })
  it('最後の受信から上限ちょうどまでは接続中、過ぎたら未接続', () => {
    expect(isExtensionConnected(status(0), EXTENSION_TIMEOUT_MS)).toBe(true)
    expect(isExtensionConnected(status(0), EXTENSION_TIMEOUT_MS + 1)).toBe(false)
  })
})
