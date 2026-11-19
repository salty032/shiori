// アプリと拡張のあいだのメッセージが、途中の段で項目を落としていないかを、**拡張の関数を実際に動かして**確かめる。
//
// 拡張は項目を 1 つずつ書き写して作り直す（background.js の normalizePortMessage / normalizeServerMessage、
// content.js の normalizePortMessage）。書き写しが 1 つ漏れると、送っているのに黙って消える。画面には何も出ない。
// 過去に素材のコマ間隔・映像の画素数・拡張の版がこれで落ちていた（extension-parity.test.ts の注記）。
//
// **拡張 → アプリのコマ通知（frame）は、コマの対応付けと、対応のずれを調べる診断の元データ。**
// 時刻・コマの累積数・控えの絵のどれが落ちても録画は保存され、精度だけが黙って下がる。
//
// 見本は型の全項目を必ず持つ（Required）。**型に項目を足すと、見本に足すまで型検査が通らない**ので、
// 足した項目は自動でこのテストの対象になる。項目ごとにテストを手で足す必要は無い。
import { describe, expect, it } from 'vitest'
import { backgroundJs, contentJs, extractFunction } from './extension-source'
import { parseExtensionMessage, type ExtensionMessage } from './ws-server'
import { FRAME_THUMB_BASE64_LENGTH, readGeneratedBlock } from '../../shared/wire-limits'
import type { AppToExtensionMessage } from '../../shared/wire-messages'

type Normalizer = (msg: unknown) => unknown

// background.js を丸ごと読み込み、2 つの検査だけを取り出す。接続まわり（chrome・WebSocket・タイマー）は空にする。
function loadBackground(): { normalizePortMessage: Normalizer; normalizeServerMessage: Normalizer } {
  const chrome = { runtime: { onConnect: { addListener: () => {} } } }
  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    readyState = 0
    addEventListener(): void {}
    close(): void {}
    send(): void {}
  }
  const quiet = { log: () => {}, warn: () => {}, error: () => {} }
  return new Function(
    'chrome', 'WebSocket', 'console', 'setTimeout', 'clearTimeout',
    `${backgroundJs}\nreturn { normalizePortMessage, normalizeServerMessage }`
  )(chrome, FakeWebSocket, quiet, () => 0, () => {})
}

// content.js は読み込むだけでページを触るので、検査とそれが使うものだけを切り出す。
function loadContentNormalizer(): Normalizer {
  const keyCodes = contentJs.match(/const NAMED_CAPTURE_KEY_CODES = \{[\s\S]*?\n\}/)?.[0]
  if (!keyCodes) throw new Error('NAMED_CAPTURE_KEY_CODES not found in content.js')
  const functions = ['stepLabel', 'isValidCaptureKey', 'clampNumber', 'normalizePortMessage']
    .map((name) => extractFunction(contentJs, name))
  return new Function(
    `${readGeneratedBlock(contentJs, 'limits')}\n${keyCodes}\n${functions.join('\n')}\nreturn normalizePortMessage`
  )()
}

const background = loadBackground()
const contentNormalize = loadContentNormalizer()

// 各種類の、全項目を入れた見本。**値は拡張の既定値と違うものにする**（項目が落ちて既定値に
// 置き換わったとき、たまたま同じ値で通ってしまわないように）。
const TO_EXTENSION: { [K in AppToExtensionMessage['type']]: Required<Extract<AppToExtensionMessage, { type: K }>> } = {
  connected: { type: 'connected' },
  'pre-capture': { type: 'pre-capture', holdMs: 40_000, video: true },
  'post-capture': { type: 'post-capture', immediate: true },
  'clip-arming': { type: 'clip-arming', label: '録画の準備中' },
  'clip-armed': { type: 'clip-armed', requestId: 'armed-1' },
  'request-timecode': { type: 'request-timecode', requestId: 'tc-1', immediate: true },
  notice: { type: 'notice', level: 'warning', message: '録画を保存しました', pending: true, id: 'notice-1' },
  settings: {
    type: 'settings', frameFps: 30, frameFpsAuto: false, captureKey: 'D',
    stepLabels: { blocked: 'これ以上進めません', dropped: '{count}回分を省略しました' }
  }
}

const FROM_EXTENSION: { [K in ExtensionMessage['type']]: Required<Extract<ExtensionMessage, { type: K }>> } = {
  timecode: {
    type: 'timecode', currentTime: 754.25, title: '作品名 第1話', url: 'https://example.com/watch?v=1',
    focused: true, requestId: 'tc-2',
    windowLeft: 12, windowTop: 34, windowWidth: 1280, windowHeight: 800, innerWidth: 1264, innerHeight: 708,
    devicePixelRatio: 1.5,
    videoRect: { left: 0, top: 48, width: 1264, height: 711 },
    videoSize: { width: 1920, height: 1080 },
    fullscreen: true, frameDurMs: 41.7, version: '9.8.7'
  },
  ping: { type: 'ping' },
  frame: {
    type: 'frame', mediaTime: 12.512, displayAt: 1_700_000_000_000, presentedFrames: 4321,
    presentedAt: 1_700_000_000_004, calledAt: 1_700_000_000_009,
    thumb: `${'A'.repeat(FRAME_THUMB_BASE64_LENGTH - 2)}==`
  },
  'frame-gap': { type: 'frame-gap' },
  'clip-armed-painted': { type: 'clip-armed-painted', requestId: 'armed-2', paintedAt: 1_700_000_000_100 },
  'notice-shown': { type: 'notice-shown', requestId: 'notice-1' }
}

describe('アプリ → 拡張：送った項目が 1 つも欠けずにページまで届く', () => {
  for (const sample of Object.values(TO_EXTENSION)) {
    it(`${sample.type}: background.js の検査を通り抜ける`, () => {
      expect(background.normalizeServerMessage(JSON.stringify(sample))).toEqual(sample)
    })
    // 「繋がった」の合図は background.js で止まり、ページへは background.js 自身の知らせ（ws-connected）が行く。
    if (sample.type === 'connected') continue
    it(`${sample.type}: content.js の検査を通り抜ける`, () => {
      expect(contentNormalize(background.normalizeServerMessage(JSON.stringify(sample)))).toEqual(sample)
    })
  }
})

describe('拡張 → アプリ：ページが送った項目が 1 つも欠けずにアプリまで届く', () => {
  for (const sample of Object.values(FROM_EXTENSION)) {
    it(`${sample.type}: background.js の中継と、アプリの受け口（ws-server.ts）を通り抜ける`, () => {
      const relayed = background.normalizePortMessage(sample)
      expect(relayed).toEqual(sample)
      expect(parseExtensionMessage(JSON.stringify(relayed))).toEqual(sample)
    })
  }
})

// 上の 2 つは「型に載っている項目が途中で落ちない」こと。ここは「ページが実際に送っている項目が、
// 型（＝見本）に全部載っている」こと。載っていない項目は、上のテストの対象に入らない。
describe('content.js が送る項目は、アプリの型に全部載っている', () => {
  it('再生位置の知らせ（timecode）', () => {
    const from = contentJs.search(/function buildPayload\(\)[\s\S]*?return \{/)
    expect(from).toBeGreaterThanOrEqual(0)
    const body = contentJs.slice(from, contentJs.indexOf('\n  }', contentJs.indexOf('return {', from)))
    // `key: 値` と、省略記法の `key,` の両方を拾う。requestId は応答のときだけ後から足される。
    const sent = [...body.matchAll(/^ {4}([A-Za-z]+)(?::|,\r?$)/gm)].map((m) => m[1]).concat('requestId')
    expect(sent.length).toBeGreaterThan(10)
    expect([...sent].sort()).toEqual(Object.keys(FROM_EXTENSION.timecode).sort())
  })

  it('コマ通知（frame）', () => {
    const source = extractFunction(contentJs, 'reportFrame')
    const literal = source.match(/const msg = \{([^}]*)\}/)?.[1] ?? ''
    const sent = [
      ...[...literal.matchAll(/([A-Za-z]+):/g)].map((m) => m[1]),
      ...[...source.matchAll(/msg\.([A-Za-z]+) = /g)].map((m) => m[1])
    ]
    expect([...sent].sort()).toEqual(Object.keys(FROM_EXTENSION.frame).sort())
  })
})
