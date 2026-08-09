import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// extension/content.js のコマ送り「着地待ち」の回帰テスト。
//
// 判定部（initialFrameStep / planFrameStep）は extension-frame-step.test.ts が見ているので、
// こちらは 1 手の進行そのもの（stepFrame / runStepAttempt）を対象にする。着地待ちタイマーを
// 1 手ごとに持てているかは純粋関数側からは見えず、連打で初めて壊れるため。
//
// content.js はバンドラ無しで配布される素の content script なので import できない。
// extension-frame-step.test.ts と同じく、テキストとして読み込み該当関数だけを取り出し、
// DOM とページ側の状態（seekVideo / sendTimecode / getFrameSec）はスタブを注入して評価する。
const contentJs = readFileSync(join(__dirname, '../../../extension/content.js'), 'utf-8')

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`function not found in extension source: ${name}`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error(`unbalanced braces in extension source: ${name}`)
}

const constLines = contentJs.match(/^const STEP_[A-Z0-9_]+ = [^\n]+$/gm)
if (!constLines || constLines.length < 6) throw new Error('STEP_* constants not found in extension source')
const STEP_CONSTS = constLines.join('\n')

const LANDING_TIMEOUT_MS = Number(
  /^const STEP_LANDING_TIMEOUT_MS = (\d+)/m.exec(contentJs)?.[1]
)
if (!Number.isFinite(LANDING_TIMEOUT_MS)) throw new Error('STEP_LANDING_TIMEOUT_MS not found')

const SRC_FPS = 24
const FRAME = 1 / SRC_FPS

type FrameCb = (now: number, meta: { mediaTime: number }) => void

/** 素材 24fps のブラウザを模したビデオ。rVFC はテスト側が明示的に発火させる。 */
function createHarness() {
  const seeks: number[] = []
  let timecodes = 0
  let nextCbId = 0
  const pending = new Map<number, FrameCb>()

  const video = {
    currentTime: 0,
    duration: 100,
    requestVideoFrameCallback(cb: FrameCb): number {
      const id = ++nextCbId
      pending.set(id, cb)
      return id
    },
    cancelVideoFrameCallback(id: number): void {
      pending.delete(id)
    }
  }

  const deps = {
    seekVideo(v: typeof video, t: number): number {
      const clamped = Math.max(0, t)
      seeks.push(clamped)
      v.currentTime = clamped
      return clamped
    },
    sendTimecode(): void {
      timecodes++
    },
    frameSec(): number {
      return FRAME
    }
  }

  // 自プロジェクトのソースを読むだけで外部入力は含まないため Function での評価は許容する。
  // eslint-disable-next-line no-new-func
  const api = Function('deps', `"use strict";
${STEP_CONSTS}
let lastFrameTime = null
let lastFrameTimeEstimated = false
let measuredFrameDur = null
const settingsFpsAuto = false
let stepSeq = 0
let abortStepAttempt = null
const seekVideo = deps.seekVideo
const sendTimecode = deps.sendTimecode
function getFrameSec() { return deps.frameSec() }
${extractFunction(contentJs, 'initialFrameStep')}
${extractFunction(contentJs, 'planFrameStep')}
${extractFunction(contentJs, 'stepFrame')}
${extractFunction(contentJs, 'runStepAttempt')}
return {
  stepFrame,
  seedLastFrame(t) { lastFrameTime = t; lastFrameTimeEstimated = false },
  lastFrameTime() { return lastFrameTime }
}
`)(deps) as {
    stepFrame: (video: unknown, dir: number) => void
    seedLastFrame: (t: number) => void
    lastFrameTime: () => number | null
  }

  return {
    ...api,
    video,
    seeks,
    timecodes: () => timecodes,
    /** 直近に登録された rVFC コールバック（取り消されていても参照は保持する）。 */
    latestCallback(): FrameCb {
      const cb = pending.get(nextCbId)
      if (!cb) throw new Error('no pending frame callback')
      return cb
    },
    /** ブラウザが「t を含むコマ」を提示したことにして着地させる。 */
    present(cb: FrameCb, t: number): void {
      cb(0, { mediaTime: Math.floor((t + 1e-9) / FRAME) * FRAME })
    }
  }
}

describe('コマ送り1手の着地待ち（extension/content.js）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('同じコマへ着地したら刻みを伸ばして隣のコマまで進む（通常の1手）', () => {
    const h = createHarness()
    h.seedLastFrame(0)

    h.stepFrame(h.video, 1)
    expect(h.seeks).toHaveLength(1)
    // 初手は見積もりコマ長の 0.9 倍手前。まだコマ0の中。
    expect(h.seeks[0]).toBeLessThan(FRAME)

    h.present(h.latestCallback(), h.seeks[0])   // コマ0のまま
    expect(h.seeks.length).toBeGreaterThan(1)

    h.present(h.latestCallback(), h.seeks[h.seeks.length - 1])
    expect(h.timecodes()).toBe(1)
    expect(h.lastFrameTime()).toBeCloseTo(FRAME, 6)
  })

  it('連打で追い越しても、後の手は着地待ちを失わず最後まで進む', () => {
    const h = createHarness()
    h.seedLastFrame(0)

    // 1手目。着地（rVFC）はまだ返ってこない。
    h.stepFrame(h.video, 1)
    const staleCallback = h.latestCallback()
    expect(h.seeks).toHaveLength(1)

    // 追い越して2手目。
    h.stepFrame(h.video, 1)
    expect(h.seeks).toHaveLength(2)
    const seeksAtOvertake = h.seeks.length

    // 1手目の着地が遅れて届く。cancelVideoFrameCallback では既に発火待ちのコールバックまでは
    // 止められないので、取り消し済みでも呼ばれうる。ここで2手目の着地待ちを巻き添えに消すと、
    // 「同じコマへのシークでは rVFC が発火しない」環境で2手目が待ちっぱなしになる。
    h.present(staleCallback, 0)
    expect(h.seeks).toHaveLength(seeksAtOvertake)   // 追い越された手は何もしない
    expect(h.timecodes()).toBe(0)

    // 2手目の着地待ちが生きていれば、時間切れで自力で次へ進む。
    vi.advanceTimersByTime(LANDING_TIMEOUT_MS)
    expect(h.seeks.length).toBeGreaterThan(seeksAtOvertake)
    expect(h.timecodes()).toBeGreaterThan(0)
  })
})
