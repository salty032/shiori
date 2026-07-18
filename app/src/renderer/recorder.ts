import fixWebmDuration from 'fix-webm-duration'

export {}

type CropRect = { x: number; y: number; w: number; h: number }

interface RecorderApi {
  onStart: (cb: (data: { sourceId: string; fps: number; maxSeconds: number; sessionId: number }) => void) => void
  onStop: (cb: () => void) => void
  getCrop: (streamW: number, streamH: number) => Promise<CropRect | null>
  sendDone: (webm: ArrayBuffer, duration: number, sessionId: number) => void
  reportError: (msg: string, sessionId: number) => void
}

declare global {
  interface Window {
    recorderApi: RecorderApi
  }
}

let recorder: MediaRecorder | null = null
let rVfcRunning = false
let mediaStream: MediaStream | null = null
let canvasStream: MediaStream | null = null
let stopTimer: ReturnType<typeof setTimeout> | null = null
let frameTimer: ReturnType<typeof setInterval> | null = null
let recordingToken = 0
// main（recording.ts）が recorder:start ごとに発行する sessionId。renderer 内部の
// recordingToken とは別の値空間（main 側のセッション識別用）なので、reportError/sendDone に
// 載せて送り返す用に直近の値を保持しておく。
let currentSessionId = 0

// frameTimer/stopTimer/rVfcRunning はモジュール変数だが、常に「最新の recordingToken を
// 持つセッション」だけが所有する。呼び出し元セッションの token が現在の recordingToken と
// 一致しないとき（＝自分より新しいセッションが既に走り出しているとき）はこれらを
// 一切触らない。それをせずに一律クリアすると、旧セッションの中断処理が新セッションの
// 描画ループ・自動停止タイマーを巻き込んで止めてしまうレースになる。
function cleanup(stream: MediaStream | null, cs: MediaStream | null, token: number): void {
  if (token === recordingToken) {
    rVfcRunning = false
    if (frameTimer) {
      clearInterval(frameTimer)
      frameTimer = null
    }
    if (stopTimer) {
      clearTimeout(stopTimer)
      stopTimer = null
    }
  }
  cs?.getTracks().forEach((t) => t.stop())
  stream?.getTracks().forEach((t) => t.stop())
}

function resetState(): void {
  mediaStream = null
  canvasStream = null
  recorder = null
}

window.recorderApi.onStart(async ({ sourceId, fps, maxSeconds, sessionId }) => {
  if (recorder && recorder.state !== 'inactive') return
  const token = ++recordingToken
  currentSessionId = sessionId

  let stream: MediaStream
  let audioFailed = false
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      audio: { mandatory: { chromeMediaSource: 'desktop' } } as any,
      video: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId }
      } as any
    })
  } catch (err) {
    // V-5: Windows のループバック音声はオーディオデバイス構成によって失敗することがあり、
    // その場合 audio+video 同時要求だと映像すら録れない。video のみで一度リトライする。
    console.warn('[recorder] audio+video getUserMedia failed, retrying video only', err)
    audioFailed = true
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId }
        } as any
      })
    } catch (err2) {
      console.error('[recorder] video-only getUserMedia also failed', err2)
      window.recorderApi.reportError(
        err2 instanceof DOMException && err2.name === 'NotAllowedError'
          ? 'getUserMedia_not_allowed'
          : 'getUserMedia_failed',
        sessionId
      )
      return
    }
  }
  if (token !== recordingToken) {
    cleanup(stream, null, token)
    window.recorderApi.reportError('aborted', sessionId)
    return
  }
  if (audioFailed) window.recorderApi.reportError('audio_unavailable_fallback', sessionId)

  mediaStream = stream
  const track = stream.getVideoTracks()[0]
  const settings = track.getSettings()
  const streamW = settings.width ?? 1920
  const streamH = settings.height ?? 1080

  const crop = await window.recorderApi.getCrop(streamW, streamH)
  if (token !== recordingToken) {
    cleanup(stream, null, token)
    resetState()
    window.recorderApi.reportError('aborted', sessionId)
    return
  }
  if (!crop) {
    cleanup(stream, null, token)
    resetState()
    window.recorderApi.reportError('crop_unavailable', sessionId)
    return
  }

  const canvas = document.createElement('canvas')
  canvas.width = crop.w
  canvas.height = crop.h
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    cleanup(stream, null, token)
    resetState()
    window.recorderApi.reportError('canvas_unavailable', sessionId)
    return
  }

  const video = document.createElement('video')
  video.srcObject = stream
  video.muted = true
  try {
    await video.play()
  } catch (err) {
    console.error('[recorder] video play failed', err)
    cleanup(stream, null, token)
    resetState()
    window.recorderApi.reportError('video_play_failed', sessionId)
    return
  }
  if (token !== recordingToken) {
    cleanup(stream, null, token)
    resetState()
    window.recorderApi.reportError('aborted', sessionId)
    return
  }

  // captureStream(0) disables automatic sampling. We request frames manually so
  // the cropped output follows the captured source frame timing.
  const cs = canvas.captureStream(0)
  canvasStream = cs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const csTrack = cs.getVideoTracks()[0] as any

  rVfcRunning = true
  const drawFrame = (): void => {
    ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h)
    csTrack.requestFrame()
  }
  const scheduleFrame = (): void => {
    if (!rVfcRunning) return
    drawFrame()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(video as any).requestVideoFrameCallback(scheduleFrame)
  }
  if ('requestVideoFrameCallback' in video) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(video as any).requestVideoFrameCallback(scheduleFrame)
  } else {
    const intervalMs = Math.max(16, Math.round(1000 / Math.min(60, Math.max(1, fps || 30))))
    drawFrame()
    frameTimer = setInterval(() => { if (rVfcRunning) drawFrame() }, intervalMs)
  }

  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
    ? 'video/webm;codecs=vp8,opus'
    : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm'

  const audioTracks = stream.getAudioTracks()
  const recordStream = audioTracks.length > 0
    ? new MediaStream([...cs.getVideoTracks(), ...audioTracks])
    : cs

  let rec: MediaRecorder
  try {
    rec = new MediaRecorder(recordStream, { mimeType, videoBitsPerSecond: 8_000_000 })
  } catch (err) {
    console.error('[recorder] MediaRecorder create failed', err)
    cleanup(stream, cs, token)
    resetState()
    window.recorderApi.reportError('media_recorder_failed', sessionId)
    return
  }

  recorder = rec
  // このセッション専用のローカル資源。MediaRecorder のエラー後、onstop が発火する前に
  // 次の録画が滑り込むレースに備え、モジュール変数（次セッションの状態）を一切参照せず
  // クロージャで束縛したこのセッションの stream/cs/chunks/開始時刻だけを扱う。
  const localChunks: Blob[] = []
  const sessionStartedAt = Date.now()
  let recorderFailed = false

  rec.ondataavailable = (e) => {
    if (e.data.size > 0) localChunks.push(e.data)
  }

  rec.onerror = (event) => {
    recorderFailed = true
    console.error('[recorder] MediaRecorder error', event)
    window.recorderApi.reportError('media_recorder_error', sessionId)
    if (rec.state === 'recording') rec.stop()
  }

  rec.onstop = async () => {
    const duration = (Date.now() - sessionStartedAt) / 1000
    cleanup(stream, cs, token)
    // resetState はモジュール変数（recorder/mediaStream/canvasStream）を消す。
    // 既に次のセッションが始まっていて recorder が入れ替わっていたら、
    // 新セッションの状態を消してしまわないよう何もしない。
    if (recorder === rec) resetState()

    if (recorderFailed) return

    if (localChunks.length === 0) {
      window.recorderApi.reportError('no_data', sessionId)
      return
    }

    try {
      const rawBlob = new Blob(localChunks, { type: mimeType })

      // MediaRecorder WebM output may lack duration metadata, which breaks seeking.
      const blob = await fixWebmDuration(rawBlob, duration * 1000)

      const webmBuf = await blob.arrayBuffer()
      window.recorderApi.sendDone(webmBuf, duration, sessionId)
    } catch (err) {
      console.error('[recorder] finalize failed', err)
      window.recorderApi.reportError('finalize_failed', sessionId)
    }
  }

  try {
    rec.start(100)
  } catch (err) {
    console.error('[recorder] start failed', err)
    cleanup(stream, cs, token)
    resetState()
    window.recorderApi.reportError('recorder_start_failed', sessionId)
    return
  }

  if (maxSeconds > 0) {
    stopTimer = setTimeout(() => {
      stopTimer = null
      if (rec.state === 'recording') rec.stop()
    }, maxSeconds * 1000)
  }
})

window.recorderApi.onStop(() => {
  recordingToken++
  if (recorder?.state === 'recording') {
    recorder.stop()
  } else {
    // V-1: 録画開始処理中（MediaRecorder.start() 到達前）に停止が来たケース。recorder が
    // まだ無いため onstop も発火せず、ここで main へ aborted を送らないと main 側の
    // isRecording が固着したままになる。この時点で自分がまさに最新セッションなので、
    // 直前でインクリメントした recordingToken を渡してタイマー類も確実にクリアする。
    cleanup(mediaStream, canvasStream, recordingToken)
    resetState()
    window.recorderApi.reportError('aborted', currentSessionId)
  }
})
