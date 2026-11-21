// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 録画の止め方を、recorder.ts を実際に動かして確かめる。どれも外すと verify は通ったまま、
// ファイルの末尾のコマが消える・止めた後の音が入る・画面キャプチャを掴んだままになる
// （.claude/rules/recording.md「開始と停止」）。

vi.mock('fix-webm-duration', () => ({
  default: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })
}))

type Handler = (data?: unknown) => unknown

class FakeTrack {
  stopped = false
  stoppedAt: number | null = null
  requestFrame = vi.fn()
  constructor(public kind: 'video' | 'audio') {}
  stop(): void { this.stopped = true; this.stoppedAt ??= Date.now() }
  getSettings(): { width: number; height: number } { return { width: 1920, height: 1080 } }
}

class FakeStream {
  constructor(public tracks: FakeTrack[]) {}
  getTracks(): FakeTrack[] { return this.tracks }
  getVideoTracks(): FakeTrack[] { return this.tracks.filter((t) => t.kind === 'video') }
  getAudioTracks(): FakeTrack[] { return this.tracks.filter((t) => t.kind === 'audio') }
}

class FakeRecorder {
  static instances: FakeRecorder[] = []
  static isTypeSupported(): boolean { return true }
  state: 'inactive' | 'recording' = 'inactive'
  stopCalledAt: number | null = null
  onstart: (() => void) | null = null
  ondataavailable: ((e: { data: { size: number } }) => void) | null = null
  onstop: (() => Promise<void> | void) | null = null
  onerror: ((e: unknown) => void) | null = null
  constructor(public stream: FakeStream) { FakeRecorder.instances.push(this) }
  start(): void { this.state = 'recording'; this.onstart?.() }
  stop(): void {
    this.stopCalledAt = Date.now()
    this.state = 'inactive'
    this.ondataavailable?.({ data: { size: 10 } })
    void this.onstop?.()
  }
}

let handlers: Record<string, Handler>
let api: Record<string, ReturnType<typeof vi.fn>>
let screen: FakeStream
let canvasTrack: FakeTrack

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(async () => {
  vi.useFakeTimers({ now: 1_000_000 })
  vi.resetModules()
  FakeRecorder.instances = []
  handlers = {}
  const on = (name: string) => vi.fn((cb: Handler) => { handlers[name] = cb })
  api = {
    onPrepare: on('prepare'), onStart: on('start'), onStop: on('stop'), onBench: on('bench'),
    getCrop: vi.fn(async () => ({ x: 0, y: 0, w: 100, h: 50, inset: 0 })),
    reportReady: vi.fn(), reportError: vi.fn(), reportStopped: vi.fn(), reportStartBoundary: vi.fn(),
    sendDone: vi.fn(), sendBenchResult: vi.fn()
  }
  ;(window as unknown as { recorderApi: unknown }).recorderApi = api

  screen = new FakeStream([new FakeTrack('video'), new FakeTrack('audio')])
  canvasTrack = new FakeTrack('video')
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia: vi.fn(async () => screen), getUserMedia: vi.fn() }
  })
  vi.stubGlobal('MediaStream', class extends FakeStream {})
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    drawImage: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), fillStyle: ''
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext
  ;(HTMLCanvasElement.prototype as unknown as { captureStream: unknown }).captureStream = vi.fn(() => new FakeStream([canvasTrack]))
  HTMLMediaElement.prototype.play = vi.fn(async () => {})

  await import('./recorder')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const START = { supplyFps: 50, sourceFps: 24, maxSeconds: 0, cleanAfter: null, cleanFrameDeadline: 0 }

async function prepare(sessionId = 1): Promise<void> {
  void handlers.prepare({ sourceId: 'screen:0', fps: 60, sessionId })
  await flush()
  expect(api.reportReady).toHaveBeenCalledWith(sessionId)
}

async function startRecording(start: Partial<typeof START> = {}): Promise<FakeRecorder> {
  await prepare()
  handlers.start({ ...START, ...start })
  await flush()
  expect(FakeRecorder.instances).toHaveLength(1)
  return FakeRecorder.instances[0]
}

describe('録画を止める', () => {
  it('供給と音声はすぐ止め、記録を閉じるのはエンコード待ちの絵を書き終えるまで待つ', async () => {
    const rec = await startRecording()
    const audio = screen.getAudioTracks()[0]
    vi.advanceTimersByTime(1_000)
    const framesBeforeStop = canvasTrack.requestFrame.mock.calls.length
    expect(framesBeforeStop).toBeGreaterThan(0)

    handlers.stop()
    // 音声はこの時点で止める（待つ間も録ると、止めた後の音が尺からはみ出す）
    expect(audio.stopped).toBe(true)
    // すぐ閉じると、エンコード待ちの絵が捨てられて最後のコマが消える
    expect(rec.stopCalledAt).toBeNull()

    vi.advanceTimersByTime(299)
    expect(rec.stopCalledAt).toBeNull()
    // 待つ間に新しい絵を送らない（送ると数えた枚数とファイルが食い違う）
    expect(canvasTrack.requestFrame.mock.calls.length).toBe(framesBeforeStop)

    vi.advanceTimersByTime(1)
    expect(rec.stopCalledAt).not.toBeNull()
  })

  it('尺は供給を止めた時点で測る（閉じるまでの待ちを含めない）', async () => {
    await startRecording()
    vi.advanceTimersByTime(2_000)
    handlers.stop()
    vi.advanceTimersByTime(300)
    await flush()
    expect(api.sendDone).toHaveBeenCalledTimes(1)
    expect(api.sendDone.mock.calls[0][1]).toBe(2)
  })

  it('上限の秒数で止まるときも、同じく待ってから閉じる', async () => {
    const rec = await startRecording({ maxSeconds: 3 })
    vi.advanceTimersByTime(3_000)
    expect(screen.getAudioTracks()[0].stopped).toBe(true)
    expect(rec.stopCalledAt).toBeNull()
    vi.advanceTimersByTime(300)
    expect(rec.stopCalledAt).not.toBeNull()
  })

  it('閉じた後は画面キャプチャを手放し、プレーヤーの表示を戻す合図を送る', async () => {
    await startRecording()
    handlers.stop()
    vi.advanceTimersByTime(300)
    await flush()
    expect(screen.getTracks().every((t) => t.stopped)).toBe(true)
    expect(api.reportStopped).toHaveBeenCalledWith(1)
  })
})

describe('始める前に止める', () => {
  it('開始の合図の前に止めたら、画面キャプチャを手放して中断を知らせる', async () => {
    await prepare()
    handlers.stop()
    await flush()
    expect(screen.getTracks().every((t) => t.stopped)).toBe(true)
    expect(api.reportError).toHaveBeenCalledWith('aborted', 1)
    expect(FakeRecorder.instances).toHaveLength(0)
  })

  it('止めた後に開始の合図が遅れて届いても、録画を始めない', async () => {
    await prepare()
    handlers.stop()
    await flush()
    handlers.start(START)
    await flush()
    expect(FakeRecorder.instances).toHaveLength(0)
  })

  it('画面キャプチャの立ち上げ中に止めたら、立ち上がった後で手放して中断を知らせる', async () => {
    let resolveStream: (s: FakeStream) => void = () => {}
    ;(navigator.mediaDevices.getDisplayMedia as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveStream = r })
    )
    void handlers.prepare({ sourceId: 'screen:0', fps: 60, sessionId: 1 })
    await flush()
    handlers.stop()
    resolveStream(screen)
    await flush()
    expect(screen.getTracks().every((t) => t.stopped)).toBe(true)
    expect(api.reportError).toHaveBeenCalledWith('aborted', 1)
    expect(api.reportReady).not.toHaveBeenCalled()
  })
})
