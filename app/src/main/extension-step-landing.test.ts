import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// extension/content.js のコマ送り「1手の進行」の回帰テスト。
//
// 判定部（initialFrameStep / planFrameStep）は extension-frame-step.test.ts が素材 fps の
// 総当たりで見ているので、こちらは進行そのもの（stepFrame / runStepAttempt）を対象にする。
// 着地待ちを1手ごとに持てているか、着地の通知が来ない場面で手を取りこぼさないかは、
// 純粋関数側からは見えず、連打と「同じコマへのシークでは rVFC が発火しない環境」でだけ壊れる。
//
// content.js はバンドラ無しで配布される素の content script なので import できない。
// extension-frame-step.test.ts と同じく、テキストとして読み込み該当関数だけを取り出し、
// ブラウザ側（seek / seeked / rVFC / rAF）とページ側の状態はスタブを注入して評価する。
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

function constant(name: string): number {
  const hit = new RegExp(`^const ${name} = ([^\\n]+?)\\s*(?://.*)?$`, 'm').exec(contentJs)
  if (!hit) throw new Error(`${name} not found in extension source`)
  // 1 / 120 のような式もそのまま評価する（定数の定義はソース側が原本）。
  // eslint-disable-next-line no-new-func
  const value = Function(`"use strict"; return (${hit[1]})`)() as number
  if (!Number.isFinite(value)) throw new Error(`${name} is not a number`)
  return value
}

const LANDING_TIMEOUT_MS = constant('STEP_LANDING_TIMEOUT_MS')
const SETTLE_FRAMES = constant('STEP_SETTLE_FRAMES')
const PROBE_SEC = constant('STEP_PROBE_SEC')

const SRC_FPS = 24
const FRAME = 1 / SRC_FPS

type FrameCb = (now: number, meta: { mediaTime: number }) => void

/**
 * 素材 24fps のブラウザを模した環境。
 *
 * 実機で観測された性質を模す：**同じコマの中へシークしても新しい絵は提示されず rVFC は
 * 発火しない**（seeked だけが返る）。テストからは seek 完了・描画フレーム・新しい絵の提示を
 * それぞれ明示的に起こす。
 */
function createHarness(opts: { frameSec?: number } = {}) {
  // 拡張が「1コマの長さ」として使う見積もり。実際の素材（FRAME）とわざとずらせるようにして、
  // 見積もりが外れている場面（＝連打で基準確定のシークが同じコマの中に着く場面）を作る。
  const estimatedFrameSec = opts.frameSec ?? FRAME
  const seeks: number[] = []
  let timecodes = 0
  let displayedFrame = 0
  let nextCbId = 0
  const frameCbs = new Map<number, FrameCb>()
  const seekedListeners = new Set<() => void>()
  let rafs: (() => void)[] = []
  let nextRafId = 0

  const video = {
    currentTime: 0,
    duration: 100,
    requestVideoFrameCallback(cb: FrameCb): number {
      const id = ++nextCbId
      frameCbs.set(id, cb)
      return id
    },
    cancelVideoFrameCallback(id: number): void {
      frameCbs.delete(id)
    },
    addEventListener(type: string, fn: () => void): void {
      if (type === 'seeked') seekedListeners.add(fn)
    },
    removeEventListener(type: string, fn: () => void): void {
      if (type === 'seeked') seekedListeners.delete(fn)
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
      return estimatedFrameSec
    },
    requestAnimationFrame(fn: () => void): number {
      rafs.push(fn)
      return ++nextRafId
    },
    cancelAnimationFrame(): void {
      // 個別取り消しは模さない（drawFrame で settled 済みのコールバックは自分で降りる）。
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
const requestAnimationFrame = deps.requestAnimationFrame
const cancelAnimationFrame = deps.cancelAnimationFrame
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

  const h = {
    ...api,
    video,
    seeks,
    timecodes: () => timecodes,
    /** 直近に登録された rVFC コールバック（取り消し済みでも参照は保持する）。 */
    latestFrameCallback(): FrameCb | undefined {
      return frameCbs.get(nextCbId)
    },
    /** シーク完了（seeked）。新しい絵が出るかどうかとは独立に返る。 */
    completeSeek(): void {
      for (const fn of [...seekedListeners]) fn()
    },
    /** 描画フレームを1回進める。 */
    drawFrame(): void {
      const due = rafs
      rafs = []
      for (const fn of due) fn()
    },
    /** ブラウザが「t を含むコマ」を提示したことにする（rVFC 発火）。 */
    present(t: number): void {
      const cb = frameCbs.get(nextCbId)
      if (!cb) throw new Error('提示できる rVFC コールバックが無い')
      displayedFrame = Math.floor((t + 1e-9) / FRAME)
      cb(0, { mediaTime: displayedFrame * FRAME })
    },
    /** シーク完了 → 新しい絵は出ない、という実機の挙動をまとめて起こす。 */
    settleWithoutNewFrame(): void {
      h.completeSeek()
      for (let i = 0; i < SETTLE_FRAMES; i++) h.drawFrame()
    },
    /** 最後にシークした位置。 */
    lastSeek(): number {
      return seeks[seeks.length - 1]
    },
    /** いま表示しているコマの番号。 */
    displayedFrame(): number {
      return displayedFrame
    },
    /** 途中のコマを表示している状態から始めるための初期化。 */
    seedDisplayed(frameIndex: number): void {
      displayedFrame = frameIndex
      video.currentTime = frameIndex * FRAME
      api.seedLastFrame(frameIndex * FRAME)
    },
    /**
     * 直前のシークに対するブラウザの反応を1回ぶん進める。
     * 着地先が今表示しているコマと違えば新しい絵が出る（rVFC）。同じコマなら seeked だけ。
     */
    react(): void {
      const target = h.lastSeek()
      if (Math.floor((target + 1e-9) / FRAME) !== displayedFrame) h.present(target)
      else h.settleWithoutNewFrame()
    },
    /** 1手が終わる（sendTimecode が呼ばれる）まで反応を進める。 */
    runStepToEnd(limit = 60): void {
      const before = timecodes
      let guard = 0
      while (timecodes === before && guard++ < limit) h.react()
      if (timecodes === before) throw new Error('1手が終わらなかった')
    }
  }
  return h
}

describe('コマ送り1手の進行（extension/content.js）', () => {
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
    expect(h.seeks[0]).toBeLessThan(FRAME)   // 初手は見積もりコマ長の手前＝まだコマ0の中

    // 同じコマなので新しい絵は出ない。刻みを伸ばして次のシークへ。
    h.settleWithoutNewFrame()
    expect(h.seeks).toHaveLength(2)
    expect(h.lastSeek()).toBeGreaterThanOrEqual(FRAME)

    h.present(h.lastSeek())
    expect(h.timecodes()).toBe(1)
    expect(h.lastFrameTime()).toBeCloseTo(FRAME, 6)
  })

  it('新しい絵が出ない判定は seeked から数フレームで済ませる（固定待ちに落ちない）', () => {
    const h = createHarness()
    h.seedLastFrame(0)
    h.stepFrame(h.video, 1)

    h.settleWithoutNewFrame()
    // タイマーを一切進めないまま次のシークへ入っていること。
    expect(h.seeks).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(1)   // 最後の砦のタイマーは張り替えられて1本だけ
  })

  it('seeked が来ない環境でも、最後の砦のタイマーで1手は進む', () => {
    const h = createHarness()
    h.seedLastFrame(0)
    h.stepFrame(h.video, 1)

    vi.advanceTimersByTime(LANDING_TIMEOUT_MS)
    expect(h.seeks).toHaveLength(2)
  })

  it('連打で追い越しても、後の手は着地待ちを失わず最後まで進む', () => {
    const h = createHarness()
    h.seedLastFrame(0)

    h.stepFrame(h.video, 1)
    const staleCallback = h.latestFrameCallback()
    expect(staleCallback).toBeDefined()

    h.stepFrame(h.video, 1)
    const seeksAtOvertake = h.seeks.length

    // 1手目の着地が遅れて届く。cancelVideoFrameCallback では既に発火待ちのコールバックまでは
    // 止められないので、取り消し済みでも呼ばれうる。ここで2手目の着地待ちを巻き添えに消すと、
    // 2手目が待ちっぱなしになる。
    staleCallback?.(0, { mediaTime: 0 })
    expect(h.seeks).toHaveLength(seeksAtOvertake)
    expect(h.timecodes()).toBe(0)

    h.settleWithoutNewFrame()
    expect(h.seeks.length).toBeGreaterThan(seeksAtOvertake)
  })

  it('連打の基準確定が無反応でも、1手を捨てずに隣のコマへ入る', () => {
    // 見積もりが実際のコマ長より短い状況（素材 24fps に対し 60fps 相当の見積もり）。
    // このとき基準確定のシークは同じコマの中に着くので、実機では必ず無反応になる。
    const h = createHarness({ frameSec: 1 / 60 })
    h.seedLastFrame(0)

    // 1手目。着地はまだ返ってこない。
    h.stepFrame(h.video, 1)
    // 追い越して2手目。基準が楽観更新値なので「表示中コマの先頭が未確定」の経路に入り、
    // まず現在位置へシークして基準を取り直そうとする。
    h.stepFrame(h.video, 1)
    const seeksBefore = h.seeks.length

    h.settleWithoutNewFrame()

    // ここで打ち切ると、押した1手が黙って消える（連打すると押した回数ぶんコマが進まない）。
    expect(h.seeks.length).toBeGreaterThan(seeksBefore)
    expect(h.timecodes()).toBe(0)

    // 以後は最小刻みで下から詰めていき、コマの境目を跨いだところで1手が完了する。
    h.runStepToEnd()
    expect(h.timecodes()).toBe(1)
    // ちょうど1コマだけ進んでいること（飛び越していない）。
    expect(h.displayedFrame()).toBe(1)
    expect(h.lastFrameTime()).toBeCloseTo(FRAME, 6)
  })

  it('連打しても、押した回数ぶんだけコマが進む', () => {
    const h = createHarness({ frameSec: 1 / 60 })
    h.seedLastFrame(0)

    // 着地を待たずに3回押す（実機の連打）。最後の1手だけが生き残る。
    h.stepFrame(h.video, 1)
    h.stepFrame(h.video, 1)
    h.stepFrame(h.video, 1)
    h.runStepToEnd()
    // 追い越された手は進まないので、この時点では1コマ。ここが0コマだと「押しても動かない」。
    expect(h.displayedFrame()).toBe(1)

    // 続けて、着地を待ちながら2回押す。押した回数ぶん進むこと。
    h.stepFrame(h.video, 1)
    h.runStepToEnd()
    h.stepFrame(h.video, 1)
    h.runStepToEnd()
    expect(h.displayedFrame()).toBe(3)
  })

  it('下から詰める刻みは最短コマ長以下（隣のコマを飛び越さない）', () => {
    const h = createHarness()
    h.seedLastFrame(0)
    h.stepFrame(h.video, 1)

    h.settleWithoutNewFrame()
    const first = h.seeks[0]
    const second = h.seeks[1]
    expect(second - first).toBeCloseTo(PROBE_SEC, 9)
  })

  it('後退は1回のシークで直前のコマへ着く', () => {
    const h = createHarness()
    h.seedDisplayed(3)
    const seeksBefore = h.seeks.length

    h.stepFrame(h.video, -1)
    h.react()
    expect(h.seeks.length - seeksBefore).toBe(1)
    expect(h.displayedFrame()).toBe(2)
    expect(h.timecodes()).toBe(1)
  })
})
