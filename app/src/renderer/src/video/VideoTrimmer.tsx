import { useState, useRef, useEffect } from 'react'
import type { ImageRow, Settings } from '../types'
import { font, color } from '../styles'
import { cleanTitle, mediaUrl } from '../utils'
import ConfirmDialog from '../components/ConfirmDialog'
import { videoApi } from './api'

type Props = {
  image: ImageRow
  settings: Settings
  onClose: () => void
  onTrimmed: () => void
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = (sec % 60).toFixed(2).padStart(5, '0')
  return `${m}:${s}`
}

function safeDur(d: number | null | undefined): number {
  if (d == null || !Number.isFinite(d) || d <= 0) return 0
  return d
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

const FRAME_EPS = 0.0005  // 0.5ms: mediaTime と framePts の浮動小数点誤差を吸収

// pts[i] <= t + EPS を満たす最大の i を返す（表示中フレームのインデックス）
function findFrameIdx(pts: number[], t: number): number {
  if (pts.length === 0) return 0
  if (t <= pts[0]) return 0
  const last = pts.length - 1
  if (t >= pts[last]) return last
  let lo = 0, hi = last
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (pts[mid] <= t + FRAME_EPS) lo = mid
    else hi = mid
  }
  return lo
}

export default function VideoTrimmer({ image, settings, onClose, onTrimmed }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const vcTimeLabelRef = useRef<HTMLSpanElement>(null)
  const ptsLoadedRef = useRef(false)
  const seekSeqRef = useRef(0)          // 古い rVFC callback を無効化するシーケンス番号
  const displayedSecRef = useRef(0)    // rVFC が確認した実表示フレーム時刻
  const mountedRef = useRef(true)      // アンマウント後の setState を防ぐ
  const posRef = useRef(0)
  const dragInSecRef = useRef(0)
  const dragOutSecRef = useRef(0)
  const inDimRef = useRef<HTMLDivElement>(null)
  const outDimRef = useRef<HTMLDivElement>(null)
  const inHandleRef = useRef<HTMLDivElement>(null)
  const outHandleRef = useRef<HTMLDivElement>(null)
  const inTimeRef = useRef<HTMLSpanElement>(null)
  const outTimeRef = useRef<HTMLSpanElement>(null)
  const inFrameRef = useRef<HTMLSpanElement>(null)
  const outFrameRef = useRef<HTMLSpanElement>(null)
  const selRangeRef = useRef<HTMLSpanElement>(null)
  const selBorderRef = useRef<HTMLDivElement>(null)
  const inTabRef = useRef<HTMLDivElement>(null)
  const outTabRef = useRef<HTMLDivElement>(null)

  const [dur, setDur] = useState(() => safeDur(image.duration))
  const [inSec, setInSec] = useState(0)
  const [outSec, setOutSec] = useState(() => safeDur(image.duration))
  const [trimming, setTrimming] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [framePts, setFramePts] = useState<number[]>([])
  const [ptsLoading, setPtsLoading] = useState(true)
  const [ptsError, setPtsError] = useState(false)
  const [stripUrl, setStripUrl] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [vcVolume, setVcVolume] = useState(1)
  const [vcMuted, setVcMuted] = useState(false)
  const [vcVolVisible, setVcVolVisible] = useState(false)
  const [vcVolClosing, setVcVolClosing] = useState(false)
  const volTrackRef = useRef<HTMLDivElement>(null)
  const vcVolTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (vcVolTimerRef.current) clearTimeout(vcVolTimerRef.current) }, [])

  // フレームテーブルが使えるか
  const hasTable = framePts.length > 0
  const inIdx = hasTable ? findFrameIdx(framePts, inSec) : -1
  const outIdx = hasTable ? findFrameIdx(framePts, outSec) : -1

  // ffmpeg に渡す終端時刻: OUT フレームの次フレーム開始時刻（OUT含む）
  const exportOutSec = hasTable
    ? (outIdx + 1 < framePts.length ? framePts[outIdx + 1] : dur)
    : outSec

  const fps = Math.max(1, settings.frameFps || 30)
  const step = 1 / fps  // rVFC フォールバック用

  const canTrim = !ptsLoading && exportOutSec - inSec >= 0.1 && dur > 0

  // トリム画面を開いたらフレーム時刻テーブルを生成
  useEffect(() => {
    setPtsLoading(true)
    setPtsError(false)
    ptsLoadedRef.current = false
    videoApi.getFramePts(image.id)
      .then((pts) => {
        ptsLoadedRef.current = true
        if (pts.length === 0) {
          setPtsError(true)
        } else {
          setFramePts(pts)
          setInSec(pts[0])
          setOutSec(pts[pts.length - 1])
        }
      })
      .catch(() => {
        ptsLoadedRef.current = true
        setPtsError(true)
      })
      .finally(() => setPtsLoading(false))
  }, [image.id])

  useEffect(() => {
    videoApi.getTimelineStrip(image.id, 15)
      .then((b64) => { if (b64 && mountedRef.current) setStripUrl(`data:image/jpeg;base64,${b64}`) })
      .catch(() => {})
  }, [image.id])

  // アンマウント時に進行中の rVFC / timeout callback の setState を無効化する
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (document.getElementById('shiori-vc-styles')) return
    const style = document.createElement('style')
    style.id = 'shiori-vc-styles'
    style.textContent = '@keyframes vcVolSlideUp { from { opacity:0; transform:translateX(-50%) translateY(6px); } to { opacity:1; transform:translateX(-50%) translateY(0); } } @keyframes vcVolSlideDown { from { opacity:1; transform:translateX(-50%) translateY(0); } to { opacity:0; transform:translateX(-50%) translateY(6px); } }'
    document.head.appendChild(style)
  }, [])

  function handleVolPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    e.preventDefault()
    e.stopPropagation()
    const el = volTrackRef.current
    if (!el) return
    const update = (clientY: number): void => {
      const rect = el.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height))
      const v = videoRef.current
      if (!v) return
      v.volume = pct
      v.muted = false
    }
    update(e.clientY)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent): void => update(ev.clientY)
    const onUp = (): void => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function updatePos(t: number): void {
    posRef.current = t
    if (playheadRef.current && dur > 0) playheadRef.current.style.left = `${(t / dur) * 100}%`
    if (vcTimeLabelRef.current) vcTimeLabelRef.current.textContent = `${fmtTime(t)} / ${fmtTime(dur)}`
  }

  function updateSelRangeUI(inS: number, outS: number): void {
    if (!selRangeRef.current) return
    const oIdx = hasTable ? findFrameIdx(framePts, outS) : -1
    const iIdx = hasTable ? findFrameIdx(framePts, inS) : -1
    const expOut = hasTable
      ? (oIdx + 1 < framePts.length ? framePts[oIdx + 1] : dur)
      : outS
    let text = `選択範囲: ${(expOut - inS).toFixed(2)}s`
    if (hasTable) text += ` (${oIdx - iIdx + 1}f)`
    selRangeRef.current.textContent = text
  }

  function updateSelBorder(inP: string, outP: string): void {
    if (selBorderRef.current) {
      selBorderRef.current.style.left = inP
      selBorderRef.current.style.width = `calc(${outP} - ${inP})`
    }
  }

  function updateInUI(sec: number): void {
    const p = dur > 0 ? `${(sec / dur) * 100}%` : '0%'
    const outP = dur > 0 ? `${(dragOutSecRef.current / dur) * 100}%` : '0%'
    if (inDimRef.current) inDimRef.current.style.width = p
    if (inHandleRef.current) inHandleRef.current.style.left = p
    if (inTabRef.current) inTabRef.current.style.left = p
    if (inTimeRef.current) inTimeRef.current.textContent = fmtTime(sec)
    if (hasTable && inFrameRef.current) inFrameRef.current.textContent = `f${findFrameIdx(framePts, sec)}`
    updateSelBorder(p, outP)
    updateSelRangeUI(sec, dragOutSecRef.current)
  }

  function updateOutUI(sec: number): void {
    const p = dur > 0 ? `${(sec / dur) * 100}%` : '0%'
    const inP = dur > 0 ? `${(dragInSecRef.current / dur) * 100}%` : '0%'
    if (outDimRef.current) outDimRef.current.style.left = p
    if (outHandleRef.current) outHandleRef.current.style.left = p
    if (outTabRef.current) outTabRef.current.style.left = p
    if (outTimeRef.current) outTimeRef.current.textContent = fmtTime(sec)
    if (hasTable && outFrameRef.current) outFrameRef.current.textContent = `f${findFrameIdx(framePts, sec)}`
    updateSelBorder(inP, p)
    updateSelRangeUI(dragInSecRef.current, sec)
  }

  // フレーム取得の共通処理。
  //  - targetSec を渡すと seek、null なら現在フレームを取得（現在位置をIN/OUT 用）
  //  - rVFC の生 mediaTime を onFrame に渡す（snap は呼び出し側の責務）
  //  - pause(): 再生中の追い越し防止 / seekSeqRef: 連打時の古い callback 無効化
  //  - 200ms fallback: rVFC が返らない環境（Chromium 以外）の保険
  //  - mountedRef: アンマウント後の setState を防ぐ
  function withFrame(targetSec: number | null, onFrame: (sec: number) => void): void {
    const v = videoRef.current
    if (!v) return
    v.pause()
    if (targetSec != null) v.currentTime = Math.max(0, Math.min(dur || 1e9, targetSec))
    seekSeqRef.current += 1
    const seq = seekSeqRef.current
    const deliver = (sec: number): void => {
      if (!mountedRef.current || seekSeqRef.current !== seq) return  // 追い越された/アンマウント済み
      displayedSecRef.current = sec
      onFrame(sec)
    }
    const rvfc = (v as unknown as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback
    if (typeof rvfc === 'function') {
      let fired = false
      const timer = setTimeout(() => {
        if (fired) return
        fired = true
        deliver(v.currentTime)
      }, 200)
      ;(rvfc as (cb: (now: number, meta: { mediaTime: number }) => void) => number)
        .call(v, (_now, meta) => {
          if (fired) return
          fired = true
          clearTimeout(timer)
          deliver(meta.mediaTime)
        })
    } else {
      deliver(v.currentTime)
    }
  }

  function stepIn(dir: number): void {
    if (hasTable) {
      const targetIdx = Math.max(0, Math.min(inIdx + dir, outIdx - 1))
      const targetSec = framePts[targetIdx]
      const v = videoRef.current
      if (v) { v.pause(); seekSeqRef.current += 1; v.currentTime = Math.max(0, Math.min(dur, targetSec)); displayedSecRef.current = targetSec }
      updatePos(targetSec)
      setInSec(targetSec)
    } else {
      stepBoundaryRvfc(dir, 'in')
    }
  }

  function stepOut(dir: number): void {
    if (hasTable) {
      const targetIdx = Math.max(inIdx + 1, Math.min(outIdx + dir, framePts.length - 1))
      const targetSec = framePts[targetIdx]
      const v = videoRef.current
      if (v) { v.pause(); seekSeqRef.current += 1; v.currentTime = Math.max(0, Math.min(dur, targetSec)); displayedSecRef.current = targetSec }
      updatePos(targetSec)
      setOutSec(targetSec)
    } else {
      stepBoundaryRvfc(dir, 'out')
    }
  }

  // rVFC 自己補正フォールバック（フレームテーブルなし時）
  function stepBoundaryRvfc(dir: number, kind: 'in' | 'out'): void {
    const v = videoRef.current
    if (!v) return
    v.pause()
    seekSeqRef.current += 1
    const seq = seekSeqRef.current
    const cur = kind === 'in' ? inSec : outSec
    const lo = kind === 'in' ? 0 : inSec + step
    const hi = kind === 'in' ? outSec - step : dur || cur
    const apply = (t: number): void => {
      const clamped = Math.max(lo, Math.min(t, hi))
      if (kind === 'in') setInSec(clamped)
      else setOutSec(clamped)
    }
    const rvfc = (v as unknown as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback
    if (typeof rvfc === 'function') {
      const target = Math.max(0, Math.min(dir > 0 ? cur + step * 1.5 : cur - step * 0.5, dur || 1e9))
      v.currentTime = target
      ;(rvfc as (cb: (now: number, meta: { mediaTime: number }) => void) => number)
        .call(v, (_now, meta) => {
          if (!mountedRef.current || seekSeqRef.current !== seq) return
          apply(meta.mediaTime)
        })
    } else {
      const t = Math.max(lo, Math.min(cur + dir * step, hi))
      apply(t)
      v.currentTime = Math.max(0, Math.min(dur || 1e9, t))
    }
  }

  function setCurrentAsIn(): void {
    withFrame(null, (t) => {
      if (hasTable) {
        const idx = Math.max(0, Math.min(findFrameIdx(framePts, t), outIdx - 1))
        setInSec(framePts[idx])
      } else {
        setInSec(Math.max(0, Math.min(t, outSec - step)))
      }
    })
  }

  function setCurrentAsOut(): void {
    withFrame(null, (t) => {
      if (hasTable) {
        const idx = Math.max(inIdx + 1, Math.min(findFrameIdx(framePts, t), framePts.length - 1))
        setOutSec(framePts[idx])
      } else {
        setOutSec(Math.max(t, inSec + step))
      }
    })
  }

  // IN/OUT がデフォルト（フレームテーブル先頭/末尾、テーブルなしなら 0/dur）から変わっているか。
  // 変わっている状態で Esc/✕ を押すと確認ダイアログを挟む（下の requestClose 参照）。
  const defaultInSec = hasTable ? framePts[0] : 0
  const defaultOutSec = hasTable ? framePts[framePts.length - 1] : dur
  const boundaryChanged = Math.abs(inSec - defaultInSec) > FRAME_EPS || Math.abs(outSec - defaultOutSec) > FRAME_EPS

  function requestClose(): void {
    if (boundaryChanged) setShowCloseConfirm(true)
    else onClose()
  }

  // キーボードショートカット — document で処理し window への伝搬を遮断する
  // ref-delegation: ハンドラ本体は毎レンダー更新、addEventListener は初回のみ
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyHandlerRef.current = (e: KeyboardEvent): void => {
    e.stopPropagation()
    if (e.key === 'Escape') { if (!trimming) requestClose(); return }
    if (trimming) return
    // Shift+←/→: コマ送り（拡張と統一）
    if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      const dir = e.key === 'ArrowRight' ? 1 : -1
      const v = videoRef.current
      if (!v) return
      v.pause()
      if (hasTable) {
        const curIdx = findFrameIdx(framePts, displayedSecRef.current)
        const targetIdx = Math.max(0, Math.min(curIdx + dir, framePts.length - 1))
        const targetSec = framePts[targetIdx]
        seekSeqRef.current += 1
        v.currentTime = Math.max(0, Math.min(dur, targetSec))
        displayedSecRef.current = targetSec
        updatePos(targetSec)
      } else {
        const target = Math.max(0, Math.min((v.currentTime || 0) + dir * step, dur))
        v.currentTime = target
        updatePos(target)
      }
      return
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement) return
    switch (e.key) {
      case 'i': case 'I': e.preventDefault(); setCurrentAsIn(); break
      case 'o': case 'O': e.preventDefault(); setCurrentAsOut(); break
      case ' ':
        e.preventDefault()
        if (videoRef.current) {
          if (videoRef.current.paused) videoRef.current.play()
          else videoRef.current.pause()
        }
        break
    }
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => keyHandlerRef.current(e)
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // ネイティブシーク（video controls や外部操作）後に displayedSecRef を更新する
  function handleSeeked(): void {
    const v = videoRef.current
    if (!v) return
    const rvfc = (v as unknown as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback
    if (typeof rvfc === 'function') {
      ;(rvfc as (cb: (now: number, meta: { mediaTime: number }) => void) => number)
        .call(v, (_now, meta) => { displayedSecRef.current = meta.mediaTime })
    }
  }

  // タイムライン上の秒数→PTS スナップ
  function snapToPts(sec: number): number {
    if (!hasTable) return sec
    const idx = findFrameIdx(framePts, sec)
    if (idx + 1 < framePts.length) {
      const prev = framePts[idx]
      const next = framePts[idx + 1]
      return (sec - prev <= next - sec) ? prev : next
    }
    return framePts[idx]
  }

  function handleTimelineClick(e: React.MouseEvent<HTMLDivElement>): void {
    if (!timelineRef.current || dur === 0) return
    const rect = timelineRef.current.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const sec = snapToPts(ratio * dur)
    seekSeqRef.current += 1
    updatePos(sec)
    if (videoRef.current) videoRef.current.currentTime = Math.max(0, Math.min(dur, sec))
  }

  // IN/OUT マーカードラッグ — mousedown 時に直接リスナー登録して mouseup 取りこぼしを防ぐ
  const draggingRef = useRef(false)

  function startDrag(kind: 'in' | 'out', e: React.MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    draggingRef.current = true
    document.body.style.userSelect = 'none'

    dragInSecRef.current = inSec
    dragOutSecRef.current = outSec
    const curOutIdx = outIdx
    const curInIdx = inIdx
    const curOutSec = outSec
    const curInSec = inSec

    function onMove(ev: MouseEvent): void {
      if (!timelineRef.current || dur === 0) return
      const rect = timelineRef.current.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
      const raw = ratio * dur
      if (kind === 'in') {
        const sec = hasTable
          ? framePts[Math.max(0, Math.min(findFrameIdx(framePts, snapToPts(raw)), curOutIdx - 1))]
          : Math.max(0, Math.min(raw, curOutSec - step))
        dragInSecRef.current = sec
        updateInUI(sec)
        updatePos(sec)
        if (videoRef.current) videoRef.current.currentTime = Math.max(0, Math.min(dur, sec))
      } else {
        const sec = hasTable
          ? framePts[Math.max(curInIdx + 1, Math.min(findFrameIdx(framePts, snapToPts(raw)), framePts.length - 1))]
          : Math.max(curInSec + step, Math.min(raw, dur))
        dragOutSecRef.current = sec
        updateOutUI(sec)
        updatePos(sec)
        if (videoRef.current) videoRef.current.currentTime = Math.max(0, Math.min(dur, sec))
      }
    }

    function onUp(): void {
      draggingRef.current = false
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (kind === 'in') setInSec(dragInSecRef.current)
      else setOutSec(dragOutSecRef.current)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  async function handleTrim(): Promise<void> {
    if (!canTrim || trimming) return
    setTrimming(true)
    setError(null)
    try {
      const result = await videoApi.trimVideo(image.id, inSec, exportOutSec)
      if (result.ok) {
        onTrimmed()
        onClose()
      } else {
        setError(result.error)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setTrimming(false)
    }
  }

  const pct = (sec: number): string => dur > 0 ? `${(sec / dur) * 100}%` : '0%'
  const selFrames = hasTable ? outIdx - inIdx + 1 : null
  const videoTitle = image.title ? cleanTitle(image.title, settings.titleStrip) : fileName(image.filepath)

  function handleOverlayClick(): void {
    if (!trimming && !boundaryChanged) onClose()
  }

  return (
    <div style={s.overlay} onClick={handleOverlayClick}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.header}>
          <span style={s.fileTitle} title={videoTitle}>{videoTitle}</span>
          <button style={s.closeBtn} onClick={requestClose} disabled={trimming}>✕</button>
        </div>

        <div style={s.videoWrap}>
          <video
            ref={videoRef}
            src={mediaUrl(image.id)}
            style={s.video}
            onClick={() => { const v = videoRef.current; if (v) v.paused ? v.play() : v.pause() }}
            onLoadedMetadata={(e) => {
              const d = safeDur(e.currentTarget.duration)
              setDur(d)
              if (!ptsLoadedRef.current) setOutSec(d)
            }}
            onTimeUpdate={(e) => {
              const t = e.currentTarget.currentTime
              updatePos(t)
            }}
            onSeeked={handleSeeked}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onVolumeChange={() => { setVcVolume(videoRef.current?.volume ?? 1); setVcMuted(videoRef.current?.muted ?? false) }}
          />
          <div style={s.vcBar}>
            <button style={s.vcBtn} onClick={() => { const v = videoRef.current; if (v) v.paused ? v.play() : v.pause() }}>
              {playing ? (
                <svg width="9" height="11" viewBox="0 0 9 11" fill="currentColor"><rect x="0" y="0" width="3" height="11" rx="1"/><rect x="6" y="0" width="3" height="11" rx="1"/></svg>
              ) : (
                <svg width="9" height="11" viewBox="0 0 9 11" fill="currentColor"><polygon points="0,0 9,5.5 0,11"/></svg>
              )}
            </button>
            <div style={{ flex: 1 }} />
            <div style={{ position: 'relative', flexShrink: 0 }}
              onMouseEnter={() => { if (vcVolTimerRef.current) clearTimeout(vcVolTimerRef.current); setVcVolVisible(true); setVcVolClosing(false) }}
              onMouseLeave={() => { setVcVolClosing(true); vcVolTimerRef.current = setTimeout(() => setVcVolVisible(false), 200) }}
            >
              <button style={s.vcBtn} onClick={() => { const v = videoRef.current; if (v) v.muted = !v.muted }}>
                {vcMuted ? (
                  <svg width="13" height="11" viewBox="0 0 13 11" fill="currentColor"><path d="M0 3.5v4h2.5L6 11V0L2.5 3.5H0z"/><line x1="8.5" y1="2.5" x2="12.5" y2="8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><line x1="12.5" y1="2.5" x2="8.5" y2="8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                ) : (
                  <svg width="14" height="11" viewBox="0 0 14 11" fill="currentColor"><path d="M0 3.5v4h2.5L6 11V0L2.5 3.5H0z"/><path d="M8 3 C9.5 4 9.5 7 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M10 1.5 C13 3 13 8 10 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                )}
              </button>
              {vcVolVisible && (
                <div style={{ ...s.vcVolPopup, animation: vcVolClosing ? 'vcVolSlideDown 0.2s ease-out forwards' : 'vcVolSlideUp 0.2s ease-out' }}>
                  <div ref={volTrackRef} style={s.vcVolTrack} onPointerDown={handleVolPointerDown}>
                    <div style={{ ...s.vcVolFill, height: `${(vcMuted ? 0 : vcVolume) * 100}%` }} />
                    <div style={{ ...s.vcVolThumb, bottom: `calc(${(vcMuted ? 0 : vcVolume) * 100}% - 5px)` }} />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div
          ref={timelineRef}
          style={s.timeline}
          onClick={handleTimelineClick}
          title="クリックでシーク"
        >
          <div style={{ ...s.timelineStrip, ...(stripUrl ? { backgroundImage: `url(${stripUrl})`, backgroundSize: '100% 100%' } : {}) }}>
            {dur > 0 && (
              <>
                <div ref={inDimRef} style={{ ...s.timelineDim, left: 0, width: pct(inSec) }} />
                <div ref={outDimRef} style={{ ...s.timelineDim, left: pct(outSec), right: 0 }} />
              </>
            )}
          </div>
          {dur > 0 && (
            <>
              <div ref={selBorderRef} style={{ ...s.selectionBorder, left: pct(inSec), width: `calc(${pct(outSec)} - ${pct(inSec)})` }} />
              <div ref={inTabRef} style={{ ...s.handleTab, background: '#4caf50', left: pct(inSec) }} />
              <div ref={outTabRef} style={{ ...s.handleTab, background: '#f44336', left: pct(outSec) }} />
              <div ref={inHandleRef} style={{ ...s.dragHandle, left: pct(inSec) }} onMouseDown={(e) => startDrag('in', e)} />
              <div ref={outHandleRef} style={{ ...s.dragHandle, left: pct(outSec) }} onMouseDown={(e) => startDrag('out', e)} />
              <div ref={playheadRef} style={{ ...s.playhead, left: pct(posRef.current) }} />
            </>
          )}
        </div>

        <div style={s.controls}>
          <div style={s.boundaryGrid}>
            <div style={s.row}>
              <div style={s.boundaryValue}>
                <span style={{ ...s.badge, background: '#4caf50' }}>IN</span>
                <span ref={inTimeRef} style={s.time}>{fmtTime(inSec)}</span>
                {hasTable && <span ref={inFrameRef} style={s.frameNum}>f{inIdx}</span>}
              </div>
              <div style={s.boundaryActions}>
                <button style={s.frameBtn} onClick={() => stepIn(-1)} disabled={ptsLoading}>◀ -1f</button>
                <button style={s.frameBtn} onClick={() => stepIn(+1)} disabled={ptsLoading}>+1f ▶</button>
              </div>
              <button style={s.setBtn} onClick={setCurrentAsIn}>ここをIN</button>
            </div>
            <div style={s.row}>
              <div style={s.boundaryValue}>
                <span style={{ ...s.badge, background: '#f44336' }}>OUT</span>
                <span ref={outTimeRef} style={s.time}>{fmtTime(outSec)}</span>
                {hasTable && <span ref={outFrameRef} style={s.frameNum}>f{outIdx}</span>}
              </div>
              <div style={s.boundaryActions}>
                <button style={s.frameBtn} onClick={() => stepOut(-1)} disabled={ptsLoading}>◀ -1f</button>
                <button style={s.frameBtn} onClick={() => stepOut(+1)} disabled={ptsLoading}>+1f ▶</button>
              </div>
              <button style={s.setBtn} onClick={setCurrentAsOut}>ここをOUT</button>
            </div>
          </div>
          <div style={s.infoRow}>
            <span ref={selRangeRef} style={s.duration}>
              {(exportOutSec - inSec).toFixed(2)}s
              {selFrames != null && ` (${selFrames}f)`}
            </span>
            {ptsLoading && <span style={s.ptsStatus}>フレーム解析中...</span>}
            {!ptsLoading && ptsError && <span style={s.ptsWarn}>フレーム解析失敗（フレーム精度低下）</span>}
            <span style={s.shortcutHint}>Shift+←→ コマ送り · I/O 設定 · Space 再生/停止</span>
          </div>
          {error && <div style={s.errorMsg}>エラー: {error}</div>}
        </div>

        <div style={s.footer}>
          <button style={s.cancelBtn} onClick={requestClose} disabled={trimming}>キャンセル</button>
          <button
            style={{ ...s.trimBtn, ...(!canTrim || trimming ? s.trimDisabled : {}) }}
            onClick={handleTrim}
            disabled={!canTrim || trimming}
          >
            {trimming ? 'トリミング中...' : 'トリミングして保存'}
          </button>
        </div>
      </div>
      {showCloseConfirm && (
        <ConfirmDialog
          title="トリミングを中止"
          message="IN/OUT の変更内容は保存されません。閉じますか？"
          confirmLabel="閉じる"
          danger
          onConfirm={onClose}
          onClose={() => setShowCloseConfirm(false)}
        />
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(3,5,10,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 6000 },
  modal: { background: '#0d0f14', border: '1px solid #20242f', borderRadius: 4, width: 'calc(100vw - clamp(48px, 6vw, 112px))', maxWidth: 1280, maxHeight: '96vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 70px rgba(0,0,0,0.64)' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '10px 16px', borderBottom: '1px solid #20242f', flexShrink: 0 },
  fileTitle: { minWidth: 0, color: '#dce3f2', fontSize: font.lg, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  closeBtn: { background: 'none', border: 'none', color: '#6f778b', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 },
  videoWrap: { position: 'relative', flexShrink: 1, minHeight: 0, display: 'flex', justifyContent: 'center', background: '#000' },
  video: { width: '100%', maxHeight: 'calc(96vh - 190px)', aspectRatio: '16/9', background: '#000', display: 'block', objectFit: 'contain' as const, cursor: 'pointer' },
  vcBar: { position: 'absolute', bottom: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: 'rgba(13,15,20,0.82)', backdropFilter: 'blur(4px)', height: 28, boxSizing: 'border-box' as const },
  vcBtn: { background: 'none', border: 'none', color: '#94a0b7', cursor: 'pointer', padding: '2px 3px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  vcTimeLabel: { fontSize: font.xs, color: '#7f899f', flexShrink: 0, fontVariantNumeric: 'tabular-nums' as const, letterSpacing: 0 },
  vcVolPopup: { position: 'absolute' as const, bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)', background: '#171a23', border: '1px solid #2b3243', borderRadius: 4, padding: '10px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, boxShadow: '0 18px 40px rgba(0,0,0,0.42)' },
  vcVolTrack: { position: 'relative' as const, width: 3, height: 52, background: '#272c3a', borderRadius: 2, cursor: 'pointer', flexShrink: 0 },
  vcVolFill: { position: 'absolute' as const, bottom: 0, left: 0, right: 0, background: '#7b7bf6', borderRadius: 2 },
  vcVolThumb: { position: 'absolute' as const, left: '50%', transform: 'translateX(-50%)', width: 10, height: 10, borderRadius: 999, background: '#9ea5ff', boxShadow: '0 0 0 3px rgba(123,123,246,0.18)', pointerEvents: 'none' as const },
  timeline: { position: 'relative', height: 44, background: '#171a23', border: '1px solid #272c3a', cursor: 'crosshair', margin: '10px 16px 0', borderRadius: 3, flexShrink: 0 },
  timelineStrip: { position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 2 },
  timelineDim: { position: 'absolute', top: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', pointerEvents: 'none' },
  selectionBorder: { position: 'absolute', top: 0, bottom: 0, borderTop: '2px solid rgba(123,123,246,0.7)', borderBottom: '2px solid rgba(123,123,246,0.7)', pointerEvents: 'none', zIndex: 1 },
  handleTab: { position: 'absolute', top: 0, bottom: 0, width: 7, borderRadius: 3, transform: 'translateX(-50%)', pointerEvents: 'none', zIndex: 2 },
  dragHandle: { position: 'absolute', top: 0, bottom: 0, width: 18, marginLeft: -9, cursor: 'ew-resize', zIndex: 3 },
  playhead: { position: 'absolute', top: 0, bottom: 0, width: 2, background: '#fff', transform: 'translateX(-50%)', pointerEvents: 'none', opacity: 0.8 },
  controls: { padding: '8px 16px 7px', display: 'flex', flexDirection: 'column', gap: 7, flexShrink: 0 },
  boundaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 8 },
  row: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  boundaryValue: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 146, flexShrink: 0 },
  boundaryActions: { display: 'inline-flex', alignItems: 'center', gap: 4, paddingLeft: 6, borderLeft: '1px solid #272c3a', flexShrink: 0 },
  badge: { color: '#fff', borderRadius: 3, padding: '1px 5px', fontSize: font.xs, fontWeight: 800, width: 30, textAlign: 'center', flexShrink: 0 },
  time: { fontFamily: 'monospace', fontSize: font.base, color: '#e3e8f6', width: 68, flexShrink: 0 },
  frameNum: { fontFamily: 'monospace', fontSize: font.xs, color: '#7f899f', width: 40, flexShrink: 0 },
  frameBtn: { padding: '2px 7px', background: '#171a23', border: '1px solid #272c3a', borderRadius: 3, color: '#b9c2d6', cursor: 'pointer', fontSize: font.sm, whiteSpace: 'nowrap' as const },
  setBtn: { padding: '2px 7px', background: '#1e2a3a', border: '1px solid #33445e', borderRadius: 3, color: '#9ea5ff', cursor: 'pointer', fontSize: font.sm, fontWeight: 700, whiteSpace: 'nowrap' as const },
  infoRow: { display: 'flex', alignItems: 'center', gap: 12, marginTop: -1, minHeight: 16 },
  duration: { color: '#9ea5ff', fontSize: font.xs, fontWeight: 800, fontVariantNumeric: 'tabular-nums' as const },
  ptsStatus: { color: '#6f778b', fontSize: font.xs, fontStyle: 'italic' },
  ptsWarn: { color: '#e67e22', fontSize: font.xs, fontStyle: 'italic' },
  errorMsg: { color: color.danger, fontSize: font.sm },
  shortcutHint: { color: '#58627f', fontSize: font.xs, letterSpacing: 0.2, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '9px 16px', borderTop: '1px solid #20242f', flexShrink: 0 },
  cancelBtn: { padding: '6px 16px', background: 'transparent', border: '1px solid #272c3a', borderRadius: 3, color: '#8a94aa', cursor: 'pointer', fontSize: font.base },
  trimBtn: { padding: '6px 20px', background: '#6f6ff2', border: '1px solid #8585ff', borderRadius: 3, color: '#fff', cursor: 'pointer', fontSize: font.base, fontWeight: 800, boxShadow: '0 6px 18px rgba(111,111,242,0.26)' },
  trimDisabled: { opacity: 0.4, cursor: 'not-allowed' },
}
