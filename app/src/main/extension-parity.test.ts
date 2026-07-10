import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  MAX_TITLE_LENGTH, MAX_URL_LENGTH, MAX_WS_PAYLOAD_BYTES, MAX_REQUEST_ID_LENGTH,
  MAX_TIMECODE_SECONDS, MIN_SCREEN_COORD, MAX_SCREEN_COORD,
  MIN_SCREEN_SIZE, MAX_SCREEN_SIZE, MIN_DEVICE_PIXEL_RATIO, MAX_DEVICE_PIXEL_RATIO,
} from './ws-server'
import { NAMED_CAPTURE_KEY_VALUES } from '../shared/hotkey'

// extension/background.js・content.js はバンドラ無しで配布されるため、app 側（ws-server.ts /
// shared/hotkey.ts）と同じ検証定数・キー集合をコピー実装として持っている（M-1）。
// 片側だけ値を変えて食い違うことを防ぐため、テキストとして読み込んで正規表現で値を
// 抽出し、app 側の export 値と一致することを assert する（ビルド無しでドリフト検知）。
const backgroundJs = readFileSync(join(__dirname, '../../../extension/background.js'), 'utf-8')
const contentJs = readFileSync(join(__dirname, '../../../extension/content.js'), 'utf-8')

function extractConst(source: string, name: string): number {
  const m = source.match(new RegExp(`const\\s+${name}\\s*=\\s*([^;\\n]+)`))
  if (!m) throw new Error(`constant not found in extension source: ${name}`)
  // 定数式は `16 * 1024` 等の単純な算術リテラルのみ（自プロジェクトのソースを読むだけで
  // 外部入力は含まないため Function での評価は許容する）。
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${m[1]});`)() as number
}

function extractSet(source: string, name: string): Set<string> {
  const m = source.match(new RegExp(`const\\s+${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`))
  if (!m) throw new Error(`set not found in extension source: ${name}`)
  // eslint-disable-next-line no-new-func
  const items = Function(`"use strict"; return [${m[1]}];`)() as string[]
  return new Set(items)
}

describe('extension との定数パリティ（M-1）', () => {
  it('background.js の WS メッセージ検証上限が ws-server.ts と一致する', () => {
    expect(extractConst(backgroundJs, 'MAX_WS_MESSAGE_BYTES')).toBe(MAX_WS_PAYLOAD_BYTES)
    expect(extractConst(backgroundJs, 'MAX_TITLE_LENGTH')).toBe(MAX_TITLE_LENGTH)
    expect(extractConst(backgroundJs, 'MAX_URL_LENGTH')).toBe(MAX_URL_LENGTH)
    expect(extractConst(backgroundJs, 'MAX_REQUEST_ID_LENGTH')).toBe(MAX_REQUEST_ID_LENGTH)
    expect(extractConst(backgroundJs, 'MAX_TIMECODE_SECONDS')).toBe(MAX_TIMECODE_SECONDS)
    expect(extractConst(backgroundJs, 'MIN_SCREEN_COORD')).toBe(MIN_SCREEN_COORD)
    expect(extractConst(backgroundJs, 'MAX_SCREEN_COORD')).toBe(MAX_SCREEN_COORD)
    expect(extractConst(backgroundJs, 'MIN_SCREEN_SIZE')).toBe(MIN_SCREEN_SIZE)
    expect(extractConst(backgroundJs, 'MAX_SCREEN_SIZE')).toBe(MAX_SCREEN_SIZE)
    expect(extractConst(backgroundJs, 'MIN_DEVICE_PIXEL_RATIO')).toBe(MIN_DEVICE_PIXEL_RATIO)
    expect(extractConst(backgroundJs, 'MAX_DEVICE_PIXEL_RATIO')).toBe(MAX_DEVICE_PIXEL_RATIO)
  })

  it('background.js の NAMED_CAPTURE_KEYS が shared/hotkey.ts の正規化後キー名と一致する', () => {
    expect(extractSet(backgroundJs, 'NAMED_CAPTURE_KEYS')).toEqual(NAMED_CAPTURE_KEY_VALUES)
  })

  it('content.js が独自に持つ検証上限（capture:done 送信前の自衛用）も ws-server.ts と一致する', () => {
    // content.js は background.js 経由で ws-server に届く前段のメッセージ組み立て側。
    // ここだけ値がズレると、抑止されるはずの長い title/url が background.js 側の
    // チェックまで素通りしてしまう（三重実装の3本目・M-1）。
    expect(extractConst(contentJs, 'MAX_TITLE_LENGTH')).toBe(MAX_TITLE_LENGTH)
    expect(extractConst(contentJs, 'MAX_URL_LENGTH')).toBe(MAX_URL_LENGTH)
    expect(extractConst(contentJs, 'MAX_REQUEST_ID_LENGTH')).toBe(MAX_REQUEST_ID_LENGTH)
  })

  it('background.js と content.js の MAX_NOTICE_MESSAGE_LENGTH が一致する（app側に対応定数は無い拡張内独自値）', () => {
    expect(extractConst(contentJs, 'MAX_NOTICE_MESSAGE_LENGTH'))
      .toBe(extractConst(backgroundJs, 'MAX_NOTICE_MESSAGE_LENGTH'))
  })
})
