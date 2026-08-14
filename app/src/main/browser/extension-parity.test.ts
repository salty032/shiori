import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  MAX_TITLE_LENGTH, MAX_URL_LENGTH, MAX_WS_PAYLOAD_BYTES, MAX_REQUEST_ID_LENGTH,
  MAX_TIMECODE_SECONDS, MIN_SCREEN_COORD, MAX_SCREEN_COORD, MAX_EPOCH_MS,
  MIN_SCREEN_SIZE, MAX_SCREEN_SIZE, MIN_DEVICE_PIXEL_RATIO, MAX_DEVICE_PIXEL_RATIO,
  MIN_SOURCE_FRAME_MS, MAX_SOURCE_FRAME_MS,
} from './ws-server'
import { NAMED_CAPTURE_KEY_VALUES } from '../../shared/hotkey'
import { backgroundJs, contentJs } from './extension-source'

// extension/background.js・content.js はバンドラ無しで配布されるため、app 側（ws-server.ts /
// shared/hotkey.ts）と同じ検証定数・キー集合をコピー実装として持っている（M-1）。
// 片側だけ値を変えて食い違うことを防ぐため、テキストとして読み込んで正規表現で値を
// 抽出し、app 側の export 値と一致することを assert する（ビルド無しでドリフト検知）。
// 読み込み自体は extension-source.ts（3 本のテストで共通）。

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
    expect(extractConst(backgroundJs, 'MAX_EPOCH_MS')).toBe(MAX_EPOCH_MS)
    expect(extractConst(backgroundJs, 'MIN_SOURCE_FRAME_MS')).toBe(MIN_SOURCE_FRAME_MS)
    expect(extractConst(backgroundJs, 'MAX_SOURCE_FRAME_MS')).toBe(MAX_SOURCE_FRAME_MS)
  })

  // 素材のコマ間隔は content.js が測り、background.js が中継し、ws-server.ts が受ける。
  // **background.js の normalizePortMessage は項目を1つずつ書き写して作り直す**ので、
  // そこに書き足し忘れると content.js が送っていても消える。実際にそれで「ビットレートが
  // 素材 fps に連動しない」状態になった（2026-08-13）。3 段すべてを固定する。
  it('素材のコマ間隔が content.js → background.js の両方を素通りする', () => {
    expect(contentJs).toMatch(/frameDurMs:\s*measuredFrameDur\s*!=\s*null/)
    expect(backgroundJs).toMatch(/frameDurMs:\s*boundedNumber\(\s*msg\.frameDurMs/)
  })

  // コマ送りの読み取り表示に出す文言は bootstrap.ts（原本は ja.ts）→ background.js →
  // content.js の3段を通る。**拡張は文言を持たない**ので、どこか1段でも落ちると
  // 「これ以上進めません」が黙って空文字になり、動けなかったことが画面から消える。
  it('コマ送りの文言が bootstrap → background.js → content.js の3段を素通りする', () => {
    const bootstrapTs = readFileSync(join(__dirname, '../bootstrap.ts'), 'utf-8')
    expect(bootstrapTs).toMatch(/stepLabels: browserStepLabels\(\)/)
    expect(bootstrapTs).toMatch(/blocked: t\('video\.stepBlocked'\), dropped: t\('video\.stepDropped'\)/)
    for (const src of [backgroundJs, contentJs]) {
      expect(src).toMatch(/blocked: label\(msg\.stepLabels\?\.blocked\)/)
      expect(src).toMatch(/dropped: label\(msg\.stepLabels\?\.dropped\)/)
    }
    expect(extractConst(contentJs, 'MAX_STEP_LABEL_LENGTH')).toBe(extractConst(backgroundJs, 'MAX_STEP_LABEL_LENGTH'))
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

  it('background.js と content.js の MAX_UI_HOLD_MS が一致する（pre-capture の holdMs 上限）', () => {
    expect(extractConst(contentJs, 'MAX_UI_HOLD_MS'))
      .toBe(extractConst(backgroundJs, 'MAX_UI_HOLD_MS'))
  })

  it('UI 非表示の上限がクリップ最長（30秒）＋停止マージンを十分に上回る', () => {
    // 上限がクリップ長を下回ると、録画中に強制復元が走ってプレーヤー UI が写り込む。
    const maxHoldMs = extractConst(contentJs, 'MAX_UI_HOLD_MS')
    expect(maxHoldMs).toBeGreaterThan((30 + 10) * 1000)
  })
})

describe('録画停止後のプレーヤー UI 復帰（post-capture の immediate）', () => {
  // ホスト別の復帰待ちはスクリーンショット用に調整された値。クリップでは合図が「録画が
  // 実際に止まった後」にしか来ないので、待っても写り込みは防げず停止から数秒 UI が
  // 戻らないだけになる。クリップだけこの待ちを飛ばす経路を、両端で固定する。
  const delayFn = contentJs.match(/function restoreDelayFor\(host, immediate\)[\s\S]*?\n}/)?.[0] ?? ''
  const delayTable = contentJs.match(/const POST_CAPTURE_RESTORE_DELAY_BY_HOST = \{[\s\S]*?\n\}/)?.[0] ?? ''
  const defaultDelay = contentJs.match(/const DEFAULT_POST_CAPTURE_RESTORE_DELAY_MS = [^\n]+/)?.[0] ?? ''
  // eslint-disable-next-line no-new-func
  const restoreDelayFor = Function(`"use strict";
${defaultDelay}
${delayTable}
${delayFn}
return restoreDelayFor`)() as (host: string, immediate: boolean) => number

  it('immediate なら待たない', () => {
    expect(restoreDelayFor('youtube.com', true)).toBe(0)
    expect(restoreDelayFor('example.test', true)).toBe(0)
  })

  it('immediate でなければ従来どおりホスト別に待つ（スクショの挙動を変えない）', () => {
    expect(restoreDelayFor('youtube.com', false)).toBeGreaterThan(0)
    // 表に無いホストも既定値で待つ
    expect(restoreDelayFor('example.test', false)).toBeGreaterThan(0)
  })

  it('immediate が background.js / content.js の検疫を素通りする', () => {
    // どちらかが落とすと、印を付けても届かず待ちが残る（三重実装・M-1 と同じ形）。
    expect(backgroundJs).toContain("{ type: 'post-capture', immediate: msg.immediate === true }")
    expect(contentJs).toContain("{ type: 'post-capture', immediate: msg.immediate === true }")
  })

  it('印を付けるのは録画側だけで、スクリーンショット側は従来どおり', () => {
    const recordingTs = readFileSync(join(__dirname, '../video/recording.ts'), 'utf-8')
    const bootstrapTs = readFileSync(join(__dirname, '../bootstrap.ts'), 'utf-8')
    expect(recordingTs).toContain("broadcastMessage({ type: 'post-capture', immediate: true })")
    expect(bootstrapTs).toContain("broadcastMessage({ type: 'post-capture' })")
    expect(bootstrapTs).not.toContain('immediate: true')
  })
})

describe('コマ通知が途切れる経路（content.js の rVFC ループ）', () => {
  it('録画中の復帰確認はタイムコードの定期送信より十分に短い間隔で回る', () => {
    // rVFC ループは <video> の差し替えで止まる。復帰が定期送信（5秒）頼みだと、
    // 30 秒クリップの 1/6 でコマ通知が途切れたままになる。
    const watchdogMs = extractConst(contentJs, 'FRAME_WATCHDOG_MS')
    const pollMs = extractConst(contentJs, 'TIMECODE_POLL_MS')
    expect(watchdogMs).toBeLessThan(pollMs / 4)
    expect(watchdogMs).toBeGreaterThanOrEqual(100)   // 無駄に回さない下限
  })

  it('録画中にトラッカーが止まったら main へ知らせる', () => {
    // 途切れた区間のコマは表に入らず、撮り逃しの枚数にも割合にも現れない。
    // 黙って通すと「最も精度が良く見えるクリップの後半が対応していない」形になる。
    const stopFn = contentJs.match(/function stopFrameTracker\(\)[\s\S]*?\n}/)?.[0] ?? ''
    expect(stopFn).toContain('reportingFrames')
    expect(stopFn).toContain('reportFrameGap()')
  })

  it('同じ <video> 要素でもトラッカーの生存を確かめ直す', () => {
    // 要素が一時的に DOM から外れるだけでもループは自分で止まる。observedVideo が
    // 変わらないため、ここで早期 return すると二度と復帰しない経路だった。
    const observeFn = contentJs.match(/function observeVideo\(video\)[\s\S]*?\n}/)?.[0] ?? ''
    expect(observeFn).toMatch(/video === observedVideo\s*\)\s*\{\s*startFrameTracker\(video\)/)
  })

  it('frame-gap は background.js と ws-server.ts の両方で素通しされる', () => {
    // 片側だけだと中継の途中で落ちて、知らせが届かない。
    const wsServerTs = readFileSync(join(__dirname, './ws-server.ts'), 'utf-8')
    expect(backgroundJs).toContain("msg.type === 'frame-gap'")
    expect(wsServerTs).toContain("msg.type === 'frame-gap'")
  })
})
