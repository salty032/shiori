import { afterEach, describe, expect, it, vi } from 'vitest'
import { UNFOCUSED_GRACE_MS, waitForPreferredReply, waitForPreferredTimecode } from './timecode-request'
import type { ExtensionMessage } from './ws-server'

function harness() {
  let handler: ((msg: ExtensionMessage) => void) | null = null
  let unsubscribeCount = 0
  const subscribe = (next: (msg: ExtensionMessage) => void): (() => void) => {
    handler = next
    return () => { handler = null; unsubscribeCount++ }
  }
  const emit = (overrides: Partial<Extract<ExtensionMessage, { type: 'timecode' }>> = {}): void => {
    handler?.({
      type: 'timecode', requestId: 'req', title: 'title', currentTime: 1, url: null,
      focused: false, windowLeft: 0, windowTop: 0, windowWidth: 100, windowHeight: 100,
      innerWidth: 100, innerHeight: 100, devicePixelRatio: 1, videoRect: null, videoSize: null, fullscreen: false,
      frameDurMs: null,
      ...overrides
    })
  }
  return { subscribe, emit, unsubscribeCount: () => unsubscribeCount }
}

describe('waitForPreferredTimecode', () => {
  afterEach(() => vi.useRealTimers())

  it('非フォーカス応答の後に来たフォーカス応答を優先する', async () => {
    vi.useFakeTimers()
    const h = harness()
    const result = waitForPreferredTimecode('req', 900, h.subscribe)
    h.emit({ title: 'fallback' })
    h.emit({ title: 'focused', focused: true })
    await expect(result).resolves.toMatchObject({ title: 'focused' })
    expect(h.unsubscribeCount()).toBe(1)
  })

  it('フォーカス応答が無ければ、最初の応答から猶予（UNFOCUSED_GRACE_MS）だけ待ってそれを使う', async () => {
    vi.useFakeTimers()
    const h = harness()
    const result = waitForPreferredTimecode('req', 900, h.subscribe)
    await vi.advanceTimersByTimeAsync(50)
    h.emit({ title: 'first' })
    h.emit({ title: 'second' })
    let settled = false
    void result.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(UNFOCUSED_GRACE_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toMatchObject({ title: 'first' })
  })

  it('猶予の間にフォーカス応答が来ればそちらを使う（時間切れの 900ms まで待たない）', async () => {
    vi.useFakeTimers()
    const h = harness()
    const result = waitForPreferredReply('req', 900, h.subscribe)
    h.emit({ title: 'unfocused' })
    await vi.advanceTimersByTimeAsync(UNFOCUSED_GRACE_MS / 2)
    h.emit({ title: 'focused', focused: true })
    await expect(result).resolves.toMatchObject({ title: 'focused' })
  })

  it('requestId違いは無視し、無応答ならnullを返す', async () => {
    vi.useFakeTimers()
    const h = harness()
    const result = waitForPreferredTimecode('req', 900, h.subscribe)
    h.emit({ requestId: 'other', focused: true })
    await vi.advanceTimersByTimeAsync(900)
    await expect(result).resolves.toBeNull()
    h.emit({ title: 'late', focused: true })
    expect(h.unsubscribeCount()).toBe(1)
  })
})
