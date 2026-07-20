import { useState, useEffect, useRef, useImperativeHandle, forwardRef, memo } from 'react'
import { mediaUrl } from '../utils'
import {
  useVcStyles, vcBtnStyle, vcTimeLabelStyle, PlayPauseIcon, VolumeControl, RateControl, LoopButton,
  vcBarStyle, vcBarOverlayStyle, vcSeekTrackStyle, vcSeekBarStyle, vcSeekFillStyle, vcSeekThumbStyle
} from './videoControls'

export type VideoPlayerHandle = {
  togglePlay: () => void
  /** dir>0 で次のコマ、dir<0 で前のコマへ。再生中なら一時停止してから動く。 */
  stepFrame: (dir: number) => void
}

function fmtDur(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// セッション内で音量・ミュート・再生速度・ループを共有し、クリップを切り替えても引き継ぐ
// （ビューア⇔詳細パネルで VideoPlayer が remount されても維持される）。
// 速度とループを含めるのは、研究中に 0.25x + ループへ整えた作業環境がクリップを
// 送るたびに 1x へ戻ってしまうと、毎回設定し直す手間が本題を邪魔するため。
let lastVolume = 1
let lastMuted = false
let lastRate = 1
let lastLoop = false

type Props = {
  id: number
  wrapperStyle?: React.CSSProperties
  videoStyle?: React.CSSProperties
  autoPlay?: boolean
  pauseWhen?: boolean
  onVideoClick?: (e: React.MouseEvent<HTMLVideoElement>) => boolean
  /** コマ送りの刻み幅に使う素材の fps（settings.frameFps）。省略時は 24。 */
  fps?: number
  // 再生速度・ループをコントロールバーに出す。腰を据えて 1 本を見るビューア専用で、
  // 詳細パネル（サムネの隣で内容を確かめるだけの小さい枠）には出さない。
  // 狭いバーにボタンが増えるほど、そこでの用途である「どのクリップか確認する」が
  // やりにくくなるため。既定は出さない側に倒す。
  showRateLoop?: boolean
}

const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer({ id, wrapperStyle, videoStyle, autoPlay, pauseWhen, onVideoClick, fps, showRateLoop }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const stepSec = 1 / Math.max(1, fps || 24)

  // 1 コマ進む / 戻る。
  // 前後 1 コマちょうど（±stepSec）を足し引きすると、現在位置が既にフレーム境界の
  // 直後にある場合に同じフレーム内へ着地して「動かない」ことがある。境界を必ず跨ぐよう
  // 進む側は 1.5 コマ、戻る側は 0.5 コマ分ずらしてからシークする（ブラウザはシーク先の
  // 直前のフレームを表示するので、結果として実フレームに吸着する）。
  // VideoTrimmer の stepBoundaryRvfc と同じ考え方。
  function stepFrame(dir: number): void {
    const v = videoRef.current
    if (!v) return
    v.pause()
    const limit = isFinite(v.duration) ? v.duration : Number.MAX_SAFE_INTEGER
    const from = v.currentTime
    const target = dir > 0 ? from + stepSec * 1.5 : from - stepSec * 0.5
    v.currentTime = Math.max(0, Math.min(target, limit))
  }

  useImperativeHandle(ref, () => ({
    togglePlay: () => {
      const v = videoRef.current
      if (!v) return
      if (v.paused) v.play(); else v.pause()
    },
    stepFrame,
  }), [stepSec])
  const seekFillRef = useRef<HTMLDivElement>(null)
  const seekThumbRef = useRef<HTMLDivElement>(null)
  const vcTimeLabelRef = useRef<HTMLSpanElement>(null)
  const vcTimeRef = useRef(0)

  const [playing, setPlaying] = useState(false)
  // コントロールバーはホバー中だけ映像に重ねて出す。シーク操作中（scrubbing）も出したままに
  // する: つまみを掴んだまま映像の外へポインタが出ると mouseleave でバーが消え、掴んでいる
  // ものが視界から無くなってしまうため。
  const [hovered, setHovered] = useState(false)
  const [scrubbing, setScrubbing] = useState(false)
  const controlsVisible = hovered || scrubbing
  const [vcDuration, setVcDuration] = useState(0)
  const [vcVolume, setVcVolume] = useState(1)
  const [vcMuted, setVcMuted] = useState(false)
  const [vcRate, setVcRate] = useState(lastRate)
  const [vcLoop, setVcLoop] = useState(lastLoop)

  function updateVcTime(t: number): void {
    vcTimeRef.current = t
    const pct = `${(t / (vcDuration || 1)) * 100}%`
    if (seekFillRef.current) seekFillRef.current.style.width = pct
    if (seekThumbRef.current) seekThumbRef.current.style.left = `calc(${pct} - 6px)`
    if (vcTimeLabelRef.current) vcTimeLabelRef.current.textContent = `${fmtDur(t)} / ${fmtDur(vcDuration)}`
  }

  useEffect(() => {
    setPlaying(false)
    vcTimeRef.current = 0
    setVcDuration(0)
    // 直近の音量・ミュートを復元（onVolumeChange が state に反映する）。
    // 再生速度は速度 UI を出す側（ビューア）でのみ引き継ぐ。UI を出さない詳細パネルで
    // 0.25x のまま再生されると、戻す手段が画面に無いまま「なぜか遅い」状態になるため、
    // そちらは常に等速で始める。ループも同じ理由で loop 属性を当てない（下の JSX 参照）。
    const v = videoRef.current
    if (v) {
      v.volume = lastVolume
      v.muted = lastMuted
      v.playbackRate = showRateLoop ? lastRate : 1
    }
  }, [id, showRateLoop])

  useEffect(() => {
    if (pauseWhen) videoRef.current?.pause()
  }, [pauseWhen])

  // ウィンドウを閉じる（≒隠すだけでトレイに残る）・最小化すると renderer は
  // 動き続けるため、何もしないと動画が裏で再生され続ける。非表示化を検知して止める。
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') videoRef.current?.pause()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // 再生中はシークバー・時刻を実フレームに追従させる。timeupdate は仕様上 4Hz 程度でしか
  // 発火しないため、これだけだとヘッドが飛び飛びに動く。コマを追う用途では現在位置の
  // ズレがそのまま誤読につながるので、対応環境では rVFC でフレームごとに更新する
  // （timeupdate のハンドラは非対応環境の受け皿として残す）。
  useEffect(() => {
    const v = videoRef.current
    if (!v || !playing) return
    type RvfcVideo = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number
      cancelVideoFrameCallback?: (handle: number) => void
    }
    const rv = v as RvfcVideo
    if (typeof rv.requestVideoFrameCallback !== 'function') return
    let handle = 0
    let alive = true
    const tick = (_now: number, meta: { mediaTime: number }): void => {
      if (!alive) return
      updateVcTime(meta.mediaTime)
      handle = rv.requestVideoFrameCallback!(tick)
    }
    handle = rv.requestVideoFrameCallback(tick)
    return () => { alive = false; rv.cancelVideoFrameCallback?.(handle) }
    // vcDuration は updateVcTime が割合の計算に使うため、確定したら張り直す。
  }, [playing, vcDuration])

  useVcStyles()

  function handleSeekPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    const update = (clientX: number) => {
      const rect = el.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      const t = pct * (vcDuration || 0)
      updateVcTime(t)
      if (videoRef.current) videoRef.current.currentTime = t
    }
    setScrubbing(true)
    update(e.clientX)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent) => update(ev.clientX)
    // pointercancel でも必ず解除する。取りこぼすと scrubbing が立ちっぱなしになり、
    // バーがホバーしていなくても出たままになる。
    const onUp = () => {
      setScrubbing(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return (
    <div style={{ ...wrapperStyle, display: 'flex', flexDirection: 'column' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}>
      {/* flex-basis: auto にする。高さ固定のビューアでは grow で枠を埋め、高さが中身依存の
          詳細パネルでは映像自身の高さ(16/9)を取る。flex:1(basis 0%)だと後者で潰れて小さくなる。 */}
      <div style={{ flex: '1 1 auto', minHeight: 0, width: '100%', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <video
          ref={videoRef}
          key={id}
          src={mediaUrl(id)}
          style={{ display: 'block', cursor: 'pointer', ...videoStyle }}
          preload="auto"
          autoPlay={autoPlay}
          loop={showRateLoop ? vcLoop : false}
          onClick={(e) => {
            if (onVideoClick?.(e) === false) return
            e.stopPropagation()
            const v = videoRef.current
            if (!v) return
            playing ? v.pause() : v.play()
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); updateVcTime(0); if (videoRef.current) videoRef.current.currentTime = 0 }}
          onTimeUpdate={() => updateVcTime(videoRef.current?.currentTime ?? 0)}
          onDurationChange={() => setVcDuration(videoRef.current?.duration ?? 0)}
          onVolumeChange={() => {
            const vol = videoRef.current?.volume ?? 1
            const muted = videoRef.current?.muted ?? false
            lastVolume = vol; lastMuted = muted
            setVcVolume(vol); setVcMuted(muted)
          }}
          onRateChange={() => {
            const r = videoRef.current?.playbackRate ?? 1
            lastRate = r
            setVcRate(r)
          }}
        />
        {/* 映像の内側（下端）に重ねる。通常フローで下に積むと動画だけ VC_BAR_HEIGHT 分
            背が高くなり、画像との外形差を埋めるための余白が詳細パネル側に必要になっていた。 */}
        <div
          style={{
            ...vcBarStyle, ...vcBarOverlayStyle,
            opacity: controlsVisible ? 1 : 0,
            pointerEvents: controlsVisible ? 'auto' : 'none',
          }}
          onClick={(e) => e.stopPropagation()}>
          <button style={vcBtnStyle} onClick={() => { const v = videoRef.current; if (!v) return; playing ? v.pause() : v.play() }}>
            <PlayPauseIcon playing={playing} />
          </button>
          <div style={vcSeekTrackStyle} onPointerDown={handleSeekPointerDown}>
            <div style={vcSeekBarStyle} />
            <div ref={seekFillRef} style={{ ...vcSeekFillStyle, width: `${(vcTimeRef.current / (vcDuration || 1)) * 100}%` }} />
            <div ref={seekThumbRef} style={{ ...vcSeekThumbStyle, left: `calc(${(vcTimeRef.current / (vcDuration || 1)) * 100}% - 6px)` }} />
          </div>
          <span ref={vcTimeLabelRef} style={vcTimeLabelStyle}>{fmtDur(vcTimeRef.current)} / {fmtDur(vcDuration)}</span>
          {showRateLoop && <RateControl videoRef={videoRef} rate={vcRate} />}
          {showRateLoop && <LoopButton loop={vcLoop} onToggle={() => { const next = !vcLoop; lastLoop = next; setVcLoop(next) }} />}
          <VolumeControl videoRef={videoRef} volume={vcVolume} muted={vcMuted} />
        </div>
      </div>
    </div>
  )
})

export default memo(VideoPlayer)
