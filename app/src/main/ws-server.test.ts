import { describe, expect, it, beforeEach } from 'vitest'
import { createServer } from 'http'
import { parseExtensionMessage, isAllowedHttpOrigin, isAllowedWsOrigin, _resetWsStateForTest, onPortInUse, startWsServer, stopWsServer, PORT } from './ws-server'

// 有効な timecode メッセージの最小構成
const VALID_TIMECODE = {
  type: 'timecode',
  currentTime: 42.5,
  title: 'Episode 1',
  url: 'https://example.com',
  focused: true,
  windowLeft: 0,
  windowTop: 0,
  windowWidth: 1920,
  windowHeight: 1080,
  innerWidth: 1920,
  innerHeight: 1080,
  devicePixelRatio: 1,
  videoRect: null,
}

function str(obj: unknown): string {
  return JSON.stringify(obj)
}

describe('parseExtensionMessage — ping', () => {
  it('ping', () => {
    expect(parseExtensionMessage(str({ type: 'ping' }))).toEqual({ type: 'ping' })
  })
  it('未知の type は null', () => {
    expect(parseExtensionMessage(str({ type: 'unknown-type', reason: 'drm' }))).toBeNull()
  })
  it('frame-gap（コマ通知が途切れた知らせ）は値を持たずに通る', () => {
    // 落とすと「表が録画の途中で終わっているのに誰も気づかない」状態に戻る。
    expect(parseExtensionMessage(str({ type: 'frame-gap' }))).toEqual({ type: 'frame-gap' })
    // 余計な値が付いていても持ち込まない
    expect(parseExtensionMessage(str({ type: 'frame-gap', at: 12345 }))).toEqual({ type: 'frame-gap' })
  })
})

describe('parseExtensionMessage — timecode 正常系', () => {
  it('有効な timecode', () => {
    const result = parseExtensionMessage(str(VALID_TIMECODE))
    expect(result?.type).toBe('timecode')
    expect((result as { currentTime: number }).currentTime).toBe(42.5)
  })
  it('currentTime が null でも有効', () => {
    const result = parseExtensionMessage(str({ ...VALID_TIMECODE, currentTime: null }))
    expect(result?.type).toBe('timecode')
    expect((result as { currentTime: null }).currentTime).toBeNull()
  })
  it('requestId あり', () => {
    const result = parseExtensionMessage(str({ ...VALID_TIMECODE, requestId: 'abc-123' }))
    expect((result as { requestId: string }).requestId).toBe('abc-123')
  })
  it('requestId は 80 文字に切り詰め', () => {
    const longId = 'x'.repeat(100)
    const result = parseExtensionMessage(str({ ...VALID_TIMECODE, requestId: longId }))
    expect((result as { requestId: string }).requestId).toHaveLength(80)
  })
  it('videoRect あり', () => {
    const rect = { left: 10, top: 20, width: 640, height: 360 }
    const result = parseExtensionMessage(str({ ...VALID_TIMECODE, videoRect: rect }))
    expect((result as { videoRect: typeof rect }).videoRect).toEqual(rect)
  })
  it('title は MAX_TITLE_LENGTH (500) に切り詰め', () => {
    const longTitle = 'a'.repeat(600)
    const result = parseExtensionMessage(str({ ...VALID_TIMECODE, title: longTitle }))
    expect((result as { title: string }).title).toHaveLength(500)
  })
})

describe('parseExtensionMessage — timecode 異常系', () => {
  it('window サイズが 0 → null', () => {
    expect(parseExtensionMessage(str({ ...VALID_TIMECODE, windowWidth: 0 }))).toBeNull()
  })
  it('window サイズが負 → null', () => {
    expect(parseExtensionMessage(str({ ...VALID_TIMECODE, windowHeight: -1 }))).toBeNull()
  })
  it('window サイズが 20000 超 → null', () => {
    expect(parseExtensionMessage(str({ ...VALID_TIMECODE, windowWidth: 20001 }))).toBeNull()
  })
  it('devicePixelRatio が 0.25 未満 → null', () => {
    expect(parseExtensionMessage(str({ ...VALID_TIMECODE, devicePixelRatio: 0.1 }))).toBeNull()
  })
  it('devicePixelRatio が 8 超 → null', () => {
    expect(parseExtensionMessage(str({ ...VALID_TIMECODE, devicePixelRatio: 9 }))).toBeNull()
  })
  it('currentTime が不正な数値 → null', () => {
    expect(parseExtensionMessage(str({ ...VALID_TIMECODE, currentTime: 'bad' }))).toBeNull()
  })
  it('currentTime が負 → null', () => {
    expect(parseExtensionMessage(str({ ...VALID_TIMECODE, currentTime: -1 }))).toBeNull()
  })
  it('url が http/https 以外 → null に変換 (全体は有効)', () => {
    const result = parseExtensionMessage(str({ ...VALID_TIMECODE, url: 'javascript:alert(1)' }))
    expect(result?.type).toBe('timecode')
    expect((result as { url: null }).url).toBeNull()
  })
})

describe('origin allowlist', () => {
  const EXT_A = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const EXT_B = 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

  beforeEach(() => _resetWsStateForTest())

  it('allowlist に A のみ設定 → A は許可・B は拒否', () => {
    _resetWsStateForTest({ allowedIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] })
    expect(isAllowedWsOrigin(EXT_A)).toBe(true)
    expect(isAllowedWsOrigin(EXT_B)).toBe(false)
  })

  it('allowlist が空なら HTTP・WS とも拒否', () => {
    expect(isAllowedHttpOrigin(EXT_A)).toBe(false)
    expect(isAllowedWsOrigin(EXT_A)).toBe(false)
  })

  it('chrome-extension 以外の origin は拒否', () => {
    _resetWsStateForTest({ allowedIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] })
    expect(isAllowedHttpOrigin('https://example.com')).toBe(false)
    expect(isAllowedWsOrigin('https://evil.com')).toBe(false)
  })

  it('undefined origin は拒否', () => {
    _resetWsStateForTest({ allowedIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] })
    expect(isAllowedHttpOrigin(undefined)).toBe(false)
    expect(isAllowedWsOrigin(undefined)).toBe(false)
  })

  it('allowlist に B のみ設定 → A は拒否・B は許可', () => {
    _resetWsStateForTest({ allowedIds: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] })
    expect(isAllowedHttpOrigin(EXT_A)).toBe(false)
    expect(isAllowedWsOrigin(EXT_B)).toBe(true)
  })
})

// Firefox の moz-extension UUID はインストールごとに変わり allowlist に載せられないため、
// UUID 形式の検証のみで通す（形式が不正なものは従来どおり拒否）。
describe('origin — moz-extension (Firefox)', () => {
  const MOZ = 'moz-extension://a1b2c3d4-1234-4abc-89de-0123456789ab'

  beforeEach(() => _resetWsStateForTest())

  it('allowlist に無くても UUID 形式なら許可', () => {
    _resetWsStateForTest({ allowedIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] })
    expect(isAllowedWsOrigin(MOZ)).toBe(true)
    expect(isAllowedHttpOrigin(MOZ)).toBe(true)
  })

  it('allowlist が空でも許可（Chromium 用 allowlist に依存しない）', () => {
    expect(isAllowedWsOrigin(MOZ)).toBe(true)
  })

  it('UUID 形式でないホストは拒否', () => {
    expect(isAllowedWsOrigin('moz-extension://not-a-uuid')).toBe(false)
    expect(isAllowedWsOrigin('moz-extension://A1B2C3D4-1234-4ABC-89DE-0123456789AB')).toBe(false)
    expect(isAllowedWsOrigin('moz-extension://')).toBe(false)
    expect(isAllowedHttpOrigin('moz-extension://not-a-uuid')).toBe(false)
  })

  it('拡張スキーム以外は UUID 風でも拒否', () => {
    expect(isAllowedWsOrigin('https://a1b2c3d4-1234-4abc-89de-0123456789ab')).toBe(false)
  })
})

describe('parseExtensionMessage — 不正ペイロード', () => {
  it('不正 JSON → null', () => {
    expect(parseExtensionMessage('{ not json')).toBeNull()
  })
  it('不明な type → null', () => {
    expect(parseExtensionMessage(str({ type: 'unknown' }))).toBeNull()
  })
  it('配列 → null', () => {
    expect(parseExtensionMessage(str([1, 2, 3]))).toBeNull()
  })
  it('空文字 → null', () => {
    expect(parseExtensionMessage('')).toBeNull()
  })
  it('ペイロード超過 (16KB+1) → null', () => {
    const huge = 'a'.repeat(16 * 1024 + 1)
    expect(parseExtensionMessage(huge)).toBeNull()
  })
  it('ペイロードがちょうど 16KB → JSON として無効なら null', () => {
    // 16384 バイトは制限内だが不正 JSON なので null
    const edge = 'a'.repeat(16 * 1024)
    expect(parseExtensionMessage(edge)).toBeNull()
  })
})

describe('onPortInUse — ポート占有の通知', () => {
  beforeEach(() => _resetWsStateForTest())

  it('EADDRINUSE を購読者へ通知し、検知後に登録した購読者にも即時通知する', async () => {
    // EADDRINUSE は listen 後の非同期 error イベントで初めて分かる。旧実装のように
    // startWsServer 直後に同期でフラグを見る方式だと、この通知を必ず取りこぼしていた。
    const blocker = createServer()
    const boundHere = await new Promise<boolean>((resolve) => {
      blocker.once('error', () => resolve(false)) // 既に他プロセスが占有 → それでも占有状態は同じ
      blocker.listen(PORT, '127.0.0.1', () => resolve(true))
    })
    try {
      const notified = new Promise<void>((resolve) => onPortInUse(resolve))
      startWsServer({ allowedExtensionIds: [] })
      await notified

      let lateSubscriberNotified = false
      onPortInUse(() => { lateSubscriberNotified = true })
      expect(lateSubscriberNotified).toBe(true)
    } finally {
      stopWsServer()
      if (boundHere) await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })
})
