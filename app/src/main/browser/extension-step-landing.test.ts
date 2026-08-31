import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contentJs, extractFunction } from './extension-source'

// extension/content.js のコマ送り「1手の進行」の回帰テスト。
//
// 判定部（initialFrameStep / planFrameStep）は extension-frame-step.test.ts が素材 fps の
// 総当たりで見ているので、こちらは進行そのもの（stepFrame / runStepAttempt）を対象にする。
// 着地待ちを1手ごとに持てているか、着地の通知が来ない場面で手を取りこぼさないかは、
// 純粋関数側からは見えず、連打と「同じコマへのシークでは rVFC が発火しない環境」でだけ壊れる。
//
// 読み込みと切り出しは extension-source.ts（content.js は import できないため）。
// ブラウザ側（seek / seeked / rVFC / rAF）とページ側の状態はスタブを注入して評価する。

const constLines = contentJs.match(/^const STEP_[A-Z0-9_]+ = [^\n]+$/gm)
if (!constLines || constLines.length < 6) throw new Error('STEP_* constants not found in extension source')
const STEP_CONSTS = constLines.join('\n')

function constant(name: string): number {
  const hit = new RegExp(`^const ${name} = ([^\\n]+?)\\s*(?://.*)?$`, 'm').exec(contentJs)
  if (!hit) throw new Error(`${name} not found in extension source`)
  // 1 / 120 のような式もそのまま評価する（定数の定義はソース側が原本）。
  const value = Function(`"use strict"; return (${hit[1]})`)() as number
  if (!Number.isFinite(value)) throw new Error(`${name} is not a number`)
  return value
}

const LANDING_TIMEOUT_MS = constant('STEP_LANDING_TIMEOUT_MS')
const SETTLE_FRAMES = constant('STEP_SETTLE_FRAMES')
const PROBE_SEC = constant('STEP_PROBE_SEC')
const SEEK_START_MS = constant('STEP_SEEK_START_MS')

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
function createHarness(opts: { frameSec?: number, srcFrameSec?: number, seedSec?: number | null } = {}) {
  // 拡張が「1コマの長さ」として使う見積もり。実際の素材（SRC）とわざとずらせるようにして、
  // 見積もりが外れている場面（＝連打で基準確定のシークが同じコマの中に着く場面）を作る。
  const estimatedFrameSec = opts.frameSec ?? FRAME
  // 素材の実際のコマ長。既定は 24fps だが、YouTube のように 30/60fps の素材も作れる。
  const SRC = opts.srcFrameSec ?? FRAME
  // 近道の置き場所（実測されたコマ長）。null なら近道を使わない＝最小刻みから詰める。
  const seedSec = opts.seedSec === undefined ? estimatedFrameSec : opts.seedSec
  const seeks: number[] = []
  const shown: number[] = []
  const readouts: { pending: number, dropped: number }[] = []
  let timecodes = 0
  let displayedFrame = 0
  let nextCbId = 0
  const frameCbs = new Map<number, FrameCb>()
  const seekedListeners = new Set<() => void>()
  const seekingListeners = new Set<() => void>()
  let rafs: (() => void)[] = []
  let nextRafId = 0

  const video = {
    currentTime: 0,
    duration: 100,
    seeking: false,
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
      if (type === 'seeking') seekingListeners.add(fn)
    },
    removeEventListener(type: string, fn: () => void): void {
      if (type === 'seeked') seekedListeners.delete(fn)
      if (type === 'seeking') seekingListeners.delete(fn)
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
    seedSec(): number | null {
      return seedSec
    },
    requestAnimationFrame(fn: () => void): number {
      rafs.push(fn)
      return ++nextRafId
    },
    // 読み取り表示は DOM に触るのでスタブ。何を出そうとしたかだけ控える。
    showReadout(pending: number, dropped: number): void {
      readouts.push({ pending, dropped })
    },
    cancelAnimationFrame(): void {
      // 個別取り消しは模さない（drawFrame で settled 済みのコールバックは自分で降りる）。
    }
  }

  // 自プロジェクトのソースを読むだけで外部入力は含まないため Function での評価は許容する。
  const api = Function('deps', `"use strict";
${STEP_CONSTS}
const MAX_PENDING_STEPS = ${constant('MAX_PENDING_STEPS')}
let lastFrameTime = null
let lastFrameTimeEstimated = false
let confirmedFrameTime = null
let stepStartedFrom = null
let measuredFrameDur = null
let stepMeasuredDur = null
const settingsFpsAuto = false
let stepSeq = 0
let abortStepAttempt = null
let stepping = false
let pendingSteps = 0
let droppedSteps = 0
const seekVideo = deps.seekVideo
const sendTimecode = deps.sendTimecode
const requestAnimationFrame = deps.requestAnimationFrame
const cancelAnimationFrame = deps.cancelAnimationFrame
function getFrameSec() { return deps.frameSec() }
function getSeedFrameSec() { return deps.seedSec() }
function showStepReadout() { deps.showReadout(pendingSteps, droppedSteps); droppedSteps = 0 }
// 着地ログ（stepLog）はテストでは黙らせる。Console へ出すだけで進行には関わらない。
function stepLog() {}
${extractFunction(contentJs, 'initialFrameStep')}
${extractFunction(contentJs, 'planFrameStep')}
${extractFunction(contentJs, 'requestFrameStep')}
${extractFunction(contentJs, 'endStep')}
${extractFunction(contentJs, 'stepFrame')}
${extractFunction(contentJs, 'runStepAttempt')}
return {
  stepFrame: requestFrameStep,
  seedLastFrame(t) { lastFrameTime = t; lastFrameTimeEstimated = false; confirmedFrameTime = t },
  lastFrameTime() { return lastFrameTime },
  pendingSteps() { return pendingSteps },
  stepping() { return stepping }
}
`)(deps) as {
    stepFrame: (video: unknown, dir: number) => void
    seedLastFrame: (t: number) => void
    lastFrameTime: () => number | null
    pendingSteps: () => number
    stepping: () => boolean
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
    /** シーク開始（seeking）。要求が受け付けられたことを表す。 */
    startSeek(): void {
      video.seeking = true
      for (const fn of [...seekingListeners]) fn()
    },
    /** シーク完了（seeked）。新しい絵が出るかどうかとは独立に返る。 */
    completeSeek(): void {
      if (!video.seeking) h.startSeek()
      video.seeking = false
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
      displayedFrame = Math.floor((t + 1e-9) / SRC)
      shown.push(displayedFrame)
      cb(0, { mediaTime: displayedFrame * SRC })
    },
    /** 1手の途中で画面に出たコマの並び（着地が正しくても、ここが往復すれば画面は変に見える）。 */
    shown: (): number[] => shown,
    /** 読み取り表示に出そうとした内容（待ち数・捨てた数）。 */
    readouts: (): { pending: number, dropped: number }[] => readouts,
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
      video.currentTime = frameIndex * SRC
      api.seedLastFrame(frameIndex * SRC)
    },
    /**
     * 直前のシークに対するブラウザの反応を1回ぶん進める。
     * 着地先が今表示しているコマと違えば新しい絵が出る（rVFC）。同じコマなら seeked だけ。
     */
    react(): void {
      const target = h.lastSeek()
      if (Math.floor((target + 1e-9) / SRC) !== displayedFrame) h.present(target)
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

    // タイマーを一切進めないまま（＝固定待ちに落ちずに）次のシークへ入っていること。
    h.settleWithoutNewFrame()
    expect(h.seeks).toHaveLength(2)
  })

  it('シークが黙って捨てられたら、待たずに次の刻みへ進む（Netflix の細かいシーク）', () => {
    const h = createHarness()
    h.seedLastFrame(0)
    h.stepFrame(h.video, 1)
    expect(h.seeks).toHaveLength(1)

    // Netflix は同じコマの中への細かいシークを黙って捨てる。seeking も seeked も来ず、
    // video.seeking も立たない。最後の砦（120ms）まで待つと1手ごとにそれが乗る。
    vi.advanceTimersByTime(SEEK_START_MS)
    expect(h.seeks).toHaveLength(2)
  })

  it('シークが始まっていれば、開始待ちの締め切りでは打ち切らない', () => {
    const h = createHarness()
    h.seedLastFrame(0)
    h.stepFrame(h.video, 1)

    h.startSeek()                       // 受け付けられた（完了はまだ）
    vi.advanceTimersByTime(SEEK_START_MS)
    expect(h.seeks).toHaveLength(1)     // 進行中のシークに次を重ねない

    h.completeSeek()
    for (let i = 0; i < SETTLE_FRAMES; i++) h.drawFrame()
    expect(h.seeks).toHaveLength(2)
  })

  it('シークは始まったのに完了通知が来ない場合は、最後の砦のタイマーで進む', () => {
    const h = createHarness()
    h.seedLastFrame(0)
    h.stepFrame(h.video, 1)

    h.startSeek()   // 受け付けられたので開始待ちの締め切りは効かない
    vi.advanceTimersByTime(LANDING_TIMEOUT_MS)
    expect(h.seeks).toHaveLength(2)
  })

  it('進行中に押した手は待ち行列へ積み、着地してから順に処理する', () => {
    const h = createHarness()
    h.seedDisplayed(0)

    h.stepFrame(h.video, 1)
    const seeksAfterFirst = h.seeks.length
    // 2手目。まだ1手目が飛んでいるので、この時点ではシークを重ねない。
    h.stepFrame(h.video, 1)
    expect(h.seeks).toHaveLength(seeksAfterFirst)
    expect(h.pendingSteps()).toBe(1)

    h.runStepToEnd()            // 1手目が着地 → 2手目が自動で始まる
    expect(h.displayedFrame()).toBe(1)
    expect(h.pendingSteps()).toBe(0)
    expect(h.stepping()).toBe(true)

    h.runStepToEnd()
    expect(h.displayedFrame()).toBe(2)
    expect(h.stepping()).toBe(false)
  })

  it('遅れて届いた古い着地は、次の手の着地待ちを巻き添えにしない', () => {
    const h = createHarness()
    h.seedDisplayed(0)

    h.stepFrame(h.video, 1)
    const staleCallback = h.latestFrameCallback()
    expect(staleCallback).toBeDefined()
    h.stepFrame(h.video, 1)     // 待ち行列へ
    h.runStepToEnd()            // 1手目が着地し、2手目が走り出す
    const seeksInSecond = h.seeks.length

    // 1手目のコールバックが遅れて届く。cancelVideoFrameCallback では既に発火待ちのものまでは
    // 止められないので、取り消し済みでも呼ばれうる。ここで2手目の着地待ちを消してしまうと、
    // 2手目が待ちっぱなしになる（押した手が黙って消える）。
    staleCallback?.(0, { mediaTime: 0 })
    expect(h.seeks).toHaveLength(seeksInSecond)

    h.runStepToEnd()
    expect(h.displayedFrame()).toBe(2)
  })

  it('連打しても、押した回数ぶんだけコマが進む', () => {
    const h = createHarness({ frameSec: 1 / 60 })
    h.seedDisplayed(0)

    // 着地を待たずに3回押す（実機の連打）。1手も捨てない。
    h.stepFrame(h.video, 1)
    h.stepFrame(h.video, 1)
    h.stepFrame(h.video, 1)
    h.runStepToEnd()
    h.runStepToEnd()
    h.runStepToEnd()
    expect(h.displayedFrame()).toBe(3)
    expect(h.stepping()).toBe(false)
  })

  it('連打に ←→ が混ざったら差し引きになる（行って戻れば同じコマ）', () => {
    const h = createHarness()
    h.seedDisplayed(10)

    h.stepFrame(h.video, 1)     // 1手目。すぐ走り出す
    h.stepFrame(h.video, 1)     // 待ち +1
    h.stepFrame(h.video, -1)    // 待ち 0（この2手は打ち消し合う）
    expect(h.pendingSteps()).toBe(0)

    h.runStepToEnd()
    expect(h.displayedFrame()).toBe(11)   // 押した通り合計 +1
    expect(h.stepping()).toBe(false)
  })

  it('溜め込みは上限で頭打ちにし、捨てたことを画面に出す', () => {
    const max = constant('MAX_PENDING_STEPS')
    const h = createHarness()
    h.seedDisplayed(0)

    for (let i = 0; i < max + 3; i++) h.stepFrame(h.video, 1)
    expect(h.pendingSteps()).toBe(max)
    // 捨てた手は黙って消さない（読み取り表示に出す）
    expect(h.readouts().some((r) => r.dropped > 0)).toBe(true)
  })

  it('基準が確定していないとき（外部シーク直後）でも、1手を捨てずに隣のコマへ入る', () => {
    // 見積もりが実際のコマ長より短い状況（素材 24fps に対し 60fps 相当の見積もり）。
    // このとき基準確定のシークは同じコマの中に着くので、実機では必ず無反応になる。
    const h = createHarness({ frameSec: 1 / 60 })
    h.seedDisplayed(4)
    h.seedLastFrame(0)          // lastFrameTime が現在位置から乖離＝外部シーク直後
    h.stepFrame(h.video, 1)
    const seeksBefore = h.seeks.length

    h.settleWithoutNewFrame()

    // ここで打ち切ると、押した1手が黙って消える。
    expect(h.seeks.length).toBeGreaterThan(seeksBefore)
    expect(h.timecodes()).toBe(0)

    // 以後は最小刻みで下から詰めていき、コマの境目を跨いだところで1手が完了する。
    h.runStepToEnd()
    expect(h.timecodes()).toBe(1)
    expect(h.displayedFrame()).toBe(5)
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

  it('実測が無いうちは、素材が何fpsでも画面が行ったり戻ったりしない', () => {
    // 見積もり 24fps（既定）のまま 30fps / 60fps の素材を送る＝YouTube で起きていた状況。
    // 近道を推定から置くと初手が次のコマへ入り、着地の検証でそれを捨てて元の位置から
    // 詰め直すため、画面には「進む→戻る→また進む」が出ていた。
    for (const srcFps of [30, 60]) {
      const h = createHarness({ frameSec: FRAME, srcFrameSec: 1 / srcFps, seedSec: null })
      h.seedDisplayed(100)

      h.stepFrame(h.video, 1)
      h.runStepToEnd()

      expect(h.displayedFrame()).toBe(101)
      expect(h.shown()).toEqual([101])   // 途中で 102 や 100 を出さない
    }
  })

  it('探索で確定したコマ長を近道に使うと、次の手は2回のシークで済む', () => {
    const h = createHarness({ frameSec: FRAME, srcFrameSec: 1 / 30, seedSec: null })
    h.seedDisplayed(100)
    h.stepFrame(h.video, 1)
    h.runStepToEnd()
    const seeksWithoutShortcut = h.seeks.length

    // 実測（1/30）が入った後の1手。content.js では onLand が stepMeasuredDur に採る値。
    const after = createHarness({ frameSec: FRAME, srcFrameSec: 1 / 30, seedSec: 1 / 30 })
    after.seedDisplayed(100)
    after.stepFrame(after.video, 1)
    after.runStepToEnd()

    expect(after.displayedFrame()).toBe(101)
    expect(after.shown()).toEqual([101])
    expect(after.seeks).toHaveLength(2)
    expect(after.seeks.length).toBeLessThan(seeksWithoutShortcut)
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
