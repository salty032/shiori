import { useState, useEffect, useRef, useImperativeHandle, forwardRef, memo } from 'react'
import { font } from '../styles'
import { mediaUrl } from '../utils'

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
  const volTrackRef = useRef<HTMLDivElement>(null)
  const seekFillRef = useRef<HTMLDivElement>(null)
  const seekThumbRef = useRef<HTMLDivElement>(null)
  const vcTimeLabelRef = useRef<HTMLSpanElement>(null)
  const vcVolTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const vcTimeRef = useRef(0)

  const [playing, setPlaying] = useState(false)
  const [vcDuration, setVcDuration] = useState(0)
  const [vcVolume, setVcVolume] = useState(1)
  const [vcMuted, setVcMuted] = useState(false)
  const [vcVolVisible, setVcVolVisible] = useState(false)
  const [vcVolClosing, setVcVolClosing] = useState(false)

  useEffect(() => () => { if (vcVolTimerRef.current) clearTimeout(vcVolTimerRef.current) }, [])

  function updateVcTime(t: number): void {
    vcTimeRef.current = t
    const pct = `${(t / (vcDuration || 1)) * 100}%`
    if (seekFillRef.current) seekFillRef.current.style.width = pct
    if (seekThumbRef.current) seekThumbRef.current.style.left = `calc(${pct} - 4px)`
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

  useEffect(() => {
    if (document.getElementById('shiori-vc-styles')) return
    const style = document.createElement('style')
    style.id = 'shiori-vc-styles'
    style.textContent = `@keyframes vcVolSlideUp { from { opacity:0; transform:translateX(-50%) translateY(6px); } to { opacity:1; transform:translateX(-50%) translateY(0); } } @keyframes vcVolSlideDown { from { opacity:1; transform:translateX(-50%) translateY(0); } to { opacity:0; transform:translateX(-50%) translateY(6px); } }`
    document.head.appendChild(style)
  }, [])

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

  function handleVolPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    e.preventDefault()
    e.stopPropagation()
    const el = volTrackRef.current
    if (!el) return
    const update = (clientY: number) => {
      const rect = el.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height))
      const v = videoRef.current
      if (!v) return
      v.volume = pct
      v.muted = false
    }
    update(e.clientY)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent) => update(ev.clientY)
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const volPct = vcMuted ? 0 : vcVolume

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
      <div style={s.vcBar} onClick={(e) => e.stopPropagation()}>
        <button style={s.vcBtn} onClick={() => { const v = videoRef.current; if (!v) return; playing ? v.pause() : v.play() }}>
          {playing ? (
            <svg width="9" height="11" viewBox="0 0 9 11" fill="currentColor">
              <rect x="0" y="0" width="3" height="11" rx="1"/>
              <rect x="6" y="0" width="3" height="11" rx="1"/>
            </svg>
          ) : (
            <svg width="9" height="11" viewBox="0 0 9 11" fill="currentColor">
              <polygon points="0,0 9,5.5 0,11"/>
            </svg>
          )}
        </button>
        <div style={s.vcSeekTrack} onPointerDown={handleSeekPointerDown}>
          <div ref={seekFillRef} style={{ ...s.vcSeekFill, width: `${(vcTimeRef.current / (vcDuration || 1)) * 100}%` }} />
          <div ref={seekThumbRef} style={{ ...s.vcSeekThumb, left: `calc(${(vcTimeRef.current / (vcDuration || 1)) * 100}% - 4px)` }} />
        </div>
        <span ref={vcTimeLabelRef} style={s.vcTimeLabel}>{fmtDur(vcTimeRef.current)} / {fmtDur(vcDuration)}</span>
        <div style={{ position: 'relative', flexShrink: 0 }}
          onMouseEnter={() => { if (vcVolTimerRef.current) clearTimeout(vcVolTimerRef.current); setVcVolVisible(true); setVcVolClosing(false) }}
          onMouseLeave={() => { setVcVolClosing(true); vcVolTimerRef.current = setTimeout(() => setVcVolVisible(false), 200) }}
        >
          <button style={s.vcBtn} onClick={() => { const v = videoRef.current; if (!v) return; v.muted = !v.muted }}>
            {vcMuted ? (
              <svg width="13" height="11" viewBox="0 0 13 11" fill="currentColor">
                <path d="M0 3.5v4h2.5L6 11V0L2.5 3.5H0z"/>
                <line x1="8.5" y1="2.5" x2="12.5" y2="8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                <line x1="12.5" y1="2.5" x2="8.5" y2="8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            ) : (
              <svg width="14" height="11" viewBox="0 0 14 11" fill="currentColor">
                <path d="M0 3.5v4h2.5L6 11V0L2.5 3.5H0z"/>
                <path d="M8 3 C9.5 4 9.5 7 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                <path d="M10 1.5 C13 3 13 8 10 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            )}
          </button>
          {vcVolVisible && (
            <div style={{ ...s.vcVolPopup, animation: vcVolClosing ? 'vcVolSlideDown 0.2s ease-out forwards' : 'vcVolSlideUp 0.2s ease-out' }}>
              <div ref={volTrackRef} style={s.vcVolTrack} onPointerDown={handleVolPointerDown}>
                <div style={{ ...s.vcVolFill, height: `${volPct * 100}%` }} />
                <div style={{ ...s.vcVolThumb, bottom: `calc(${volPct * 100}% - 5px)` }} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

export default memo(VideoPlayer)

const s: Record<string, React.CSSProperties> = {
  vcBar: { position: 'absolute', bottom: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: 'rgba(13,15,20,0.82)', backdropFilter: 'blur(4px)', height: 28, boxSizing: 'border-box' },
  vcBtn: { background: 'none', border: 'none', color: '#94a0b7', cursor: 'pointer', padding: '2px 3px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  vcSeekTrack: { position: 'relative', flex: 1, height: 3, background: '#272c3a', borderRadius: 2, cursor: 'pointer' },
  vcSeekFill: { position: 'absolute', left: 0, top: 0, bottom: 0, background: '#7b7bf6', borderRadius: 2, pointerEvents: 'none' },
  vcSeekThumb: { position: 'absolute', top: '50%', marginTop: -4, width: 8, height: 8, borderRadius: 999, background: '#9ea5ff', boxShadow: '0 0 0 3px rgba(123,123,246,0.18)', pointerEvents: 'none' },
  vcTimeLabel: { fontSize: font.xs, color: '#7f899f', flexShrink: 0, fontVariantNumeric: 'tabular-nums', letterSpacing: 0 },
  vcVolPopup: { position: 'absolute', bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)', background: '#171a23', border: '1px solid #2b3243', borderRadius: 4, padding: '10px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, boxShadow: '0 18px 40px rgba(0,0,0,0.42)' },
  vcVolTrack: { position: 'relative', width: 3, height: 52, background: '#272c3a', borderRadius: 2, cursor: 'pointer', flexShrink: 0 },
  vcVolFill: { position: 'absolute', bottom: 0, left: 0, right: 0, background: '#7b7bf6', borderRadius: 2 },
  vcVolThumb: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', width: 10, height: 10, borderRadius: 999, background: '#9ea5ff', boxShadow: '0 0 0 3px rgba(123,123,246,0.18)', pointerEvents: 'none' },
}
