import { useState, useEffect, useRef, useImperativeHandle, forwardRef, memo } from 'react'
import { mediaUrl } from '../utils'
import {
  useVcStyles, vcBtnStyle, vcTimeLabelStyle, PlayPauseIcon, VolumeControl,
  vcBarStyle, vcSeekTrackStyle, vcSeekBarStyle, vcSeekFillStyle, vcSeekThumbStyle
} from './videoControls'

export type VideoPlayerHandle = { togglePlay: () => void }

function fmtDur(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// セッション内で音量・ミュートを共有し、クリップを切り替えても引き継ぐ
// （ビューア⇔詳細パネルで VideoPlayer が remount されても維持される）。
let lastVolume = 1
let lastMuted = false

type Props = {
  id: number
  wrapperStyle?: React.CSSProperties
  videoStyle?: React.CSSProperties
  autoPlay?: boolean
  pauseWhen?: boolean
  onVideoClick?: (e: React.MouseEvent<HTMLVideoElement>) => boolean
}

const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer({ id, wrapperStyle, videoStyle, autoPlay, pauseWhen, onVideoClick }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useImperativeHandle(ref, () => ({
    togglePlay: () => {
      const v = videoRef.current
      if (!v) return
      if (v.paused) v.play(); else v.pause()
    },
  }), [])
  const seekFillRef = useRef<HTMLDivElement>(null)
  const seekThumbRef = useRef<HTMLDivElement>(null)
  const vcTimeLabelRef = useRef<HTMLSpanElement>(null)
  const vcTimeRef = useRef(0)

  const [playing, setPlaying] = useState(false)
  const [vcDuration, setVcDuration] = useState(0)
  const [vcVolume, setVcVolume] = useState(1)
  const [vcMuted, setVcMuted] = useState(false)

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
    // 直近の音量・ミュートを復元（onVolumeChange が state に反映する）
    const v = videoRef.current
    if (v) { v.volume = lastVolume; v.muted = lastMuted }
  }, [id])

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
    update(e.clientX)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent) => update(ev.clientX)
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div style={{ position: 'relative', ...wrapperStyle }}>
      <video
        ref={videoRef}
        key={id}
        src={mediaUrl(id)}
        style={{ display: 'block', cursor: 'pointer', ...videoStyle }}
        preload="auto"
        autoPlay={autoPlay}
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
      />
      <div style={vcBarStyle} onClick={(e) => e.stopPropagation()}>
        <button style={vcBtnStyle} onClick={() => { const v = videoRef.current; if (!v) return; playing ? v.pause() : v.play() }}>
          <PlayPauseIcon playing={playing} />
        </button>
        <div style={vcSeekTrackStyle} onPointerDown={handleSeekPointerDown}>
          <div style={vcSeekBarStyle} />
          <div ref={seekFillRef} style={{ ...vcSeekFillStyle, width: `${(vcTimeRef.current / (vcDuration || 1)) * 100}%` }} />
          <div ref={seekThumbRef} style={{ ...vcSeekThumbStyle, left: `calc(${(vcTimeRef.current / (vcDuration || 1)) * 100}% - 6px)` }} />
        </div>
        <span ref={vcTimeLabelRef} style={vcTimeLabelStyle}>{fmtDur(vcTimeRef.current)} / {fmtDur(vcDuration)}</span>
        <VolumeControl videoRef={videoRef} volume={vcVolume} muted={vcMuted} />
      </div>
    </div>
  )
})

export default memo(VideoPlayer)
