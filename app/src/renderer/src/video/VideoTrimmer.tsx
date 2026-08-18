import { useState, useRef, useEffect } from 'react'
import type { ImageRow, Settings } from '../types'
import { font, color, radius } from '../styles'
import { cleanTitle, mediaUrl } from '../utils'
import { FRAME_EPS, findFrameIdx } from '../frameTable'
import ConfirmDialog from '../components/ConfirmDialog'
import { useVcStyles, vcBtnStyle, vcTimeLabelStyle, PlayPauseIcon, VolumeControl, vcBarStyle } from '../components/videoControls'
import { videoApi } from './api'
import { useT } from '../i18n'

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

export default function VideoTrimmer({ image, settings, onClose, onTrimmed }: Props) {
  const { t } = useT()
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

  // フレームテーブルが使えるか
  const hasTable = framePts.length > 0
  const inIdx = hasTable ? findFrameIdx(framePts, inSec) : -1
  const outIdx = hasTable ? findFrameIdx(framePts, outSec) : -1

  // ffmpeg に渡す終端時刻: OUT フレームの次フレーム開始時刻（OUT含む）
  const exportOutSec = hasTable
    ? (outIdx + 1 < framePts.length ? framePts[outIdx + 1] : dur)
    : outSec

  // フレームテーブルが取れないときの刻み幅。クリップの実測 fps（image.fps）が
  // あればそれを優先する（settings.frameFps はクリップの実態と無関係なグローバル既定値
  // でしかない）。
  const fps = Math.max(1, image.fps ?? settings.frameFps ?? 30)
  const step = 1 / fps  // rVFC フォールバック用

  const canTrim = !ptsLoading && exportOutSec - inSec >= 0.1 && dur > 0

  // トリム画面を開いたらフレーム時刻テーブルを生成
  useEffect(() => {
    setPtsLoading(true)
    setPtsError(false)
    ptsLoadedRef.current = false
    videoApi.getClipFrames(image.id)
      .then(({ pts }) => {
        ptsLoadedRef.current = true
        if (pts.length === 0) {
          setPtsError(true)
        } else {
          setFramePts(pts)
          setInSec(pts[0])
          setOutSec(pts[pts.length - 1])
          // タイムラインの全長を「最後のフレーム + 1 コマ」に詰める。
          // コンテナの尺（video.duration）は録画停止までのラグを含んでおり、最後のフレーム
          // より後ろに映像の無い区間が残る。それをタイムラインに含めると、OUT を末尾まで
          // 動かしても right 端に届かず、掴めない余白がぶら下がって見える。
          setDur(pts[pts.length - 1] + 1 / fps)
        }
      })
      .catch(() => {
        ptsLoadedRef.current = true
        setPtsError(true)
      })
      .finally(() => setPtsLoading(false))
  }, [image.id, fps])

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

  // 再生は IN/OUT 区間に閉じ込め、末尾まで来たら IN へ戻して繰り返す。
  // トリム画面の再生は「切り出す範囲を確かめる」ためのものなので、範囲外まで流れていく
  // 全尺再生では用をなさない。区間を繰り返し見られると、境界を 1 コマ動かした結果が
  // そのまま次の周回で確認できる。
  //
  // 監視は rVFC で行う（timeupdate は約 4Hz でしか発火せず、OUT を最大 250ms 分
  // 超えてから戻ることになり、切り出さないはずのコマが見えてしまう）。
  // 停止中の移動は制限しない（コマ送りやタイムラインクリックで範囲外を確認することは
  // あるため、閉じ込めるのは再生中だけにする）。
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
      if (meta.mediaTime >= exportOutSec - FRAME_EPS) {
        v.currentTime = inSec
        updatePos(inSec)
      } else {
        updatePos(meta.mediaTime)
      }
      handle = rv.requestVideoFrameCallback!(tick)
    }
    handle = rv.requestVideoFrameCallback(tick)
    return () => { alive = false; rv.cancelVideoFrameCallback?.(handle) }
  }, [playing, inSec, exportOutSec, dur])

  useVcStyles()

  function updatePos(t: number): void {
    posRef.current = t
    if (playheadRef.current && dur > 0) playheadRef.current.style.left = `${(t / dur) * 100}%`
    if (vcTimeLabelRef.current) vcTimeLabelRef.current.textContent = `${fmtTime(t)} / ${fmtTime(dur)}`
  }

  // OUT に選んだフレームの「終わり」の時刻。OUT はそのフレームを含むので、帯やマーカーは
  // ここまで塗る必要がある。開始時刻で描くと、末尾のフレームを選んでも 1 コマ分だけ
  // 右端に届かない。
  function exportOutOf(outS: number): number {
    if (!hasTable) return outS
    const idx = findFrameIdx(framePts, outS)
    return idx + 1 < framePts.length ? framePts[idx + 1] : dur
  }

  function updateSelRangeUI(inS: number, outS: number): void {
    if (!selRangeRef.current) return
    const oIdx = hasTable ? findFrameIdx(framePts, outS) : -1
    const iIdx = hasTable ? findFrameIdx(framePts, inS) : -1
    const expOut = exportOutOf(outS)
    let text = t('trim.selection', { seconds: (expOut - inS).toFixed(2) })
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
    const outP = dur > 0 ? `${(exportOutOf(dragOutSecRef.current) / dur) * 100}%` : '0%'
    if (inDimRef.current) inDimRef.current.style.width = p
    if (inHandleRef.current) inHandleRef.current.style.left = p
    if (inTabRef.current) inTabRef.current.style.left = p
    if (inTimeRef.current) inTimeRef.current.textContent = fmtTime(sec)
    // 番号は 1 始まり（ビューアのコマ表示と同じ数え方に揃える）。
    if (hasTable && inFrameRef.current) inFrameRef.current.textContent = `f${findFrameIdx(framePts, sec) + 1}`
    updateSelBorder(p, outP)
    updateSelRangeUI(sec, dragOutSecRef.current)
  }

  function updateOutUI(sec: number): void {
    const p = dur > 0 ? `${(exportOutOf(sec) / dur) * 100}%` : '0%'
    const inP = dur > 0 ? `${(dragInSecRef.current / dur) * 100}%` : '0%'
    if (outDimRef.current) outDimRef.current.style.left = p
    if (outHandleRef.current) outHandleRef.current.style.left = p
    if (outTabRef.current) outTabRef.current.style.left = p
    if (outTimeRef.current) outTimeRef.current.textContent = fmtTime(sec)
    if (hasTable && outFrameRef.current) outFrameRef.current.textContent = `f${findFrameIdx(framePts, sec) + 1}`
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

  // 再生位置のコマ送り。フレームテーブルがあれば実 PTS を辿り、無ければ fps 換算で動かす。
  function stepPlayhead(dir: number): void {
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
  }

  // キーボードショートカット — document で処理し window への伝搬を遮断する
  // ref-delegation: ハンドラ本体は毎レンダー更新、addEventListener は初回のみ
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyHandlerRef.current = (e: KeyboardEvent): void => {
    e.stopPropagation()
    if (e.key === 'Escape') { if (!trimming) requestClose(); return }
    if (trimming) return
    // コマ送りは , / . のみ。ビューア（Viewer）・ブラウザ拡張・動画編集ソフトの慣習と同じで、
    // 画面ごとに違うキーを覚えずに済む。以前ここだけ Shift+←/→ も受けていたが、拡張側を
    // , / . へ移したので役目が終わった。
    // , / . は文字入力なので入力欄では通さない。ボタンは除外しない
    // （−1f 等を押した直後にフォーカスが残っていてもコマ送りが死なないようにする）。
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      || (e.target instanceof HTMLElement && e.target.isContentEditable)
    if (!typing && (e.key === ',' || e.key === '.')) {
      e.preventDefault()
      stepPlayhead(e.key === '.' ? 1 : -1)
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
            onPlay={() => {
              setPlaying(true)
              // 停止中に範囲外へ動かしてから再生した場合は IN から始める
              // （そのまま流すと、切り出さない区間の再生から始まってしまう）。
              const v = videoRef.current
              if (!v) return
              if (v.currentTime < inSec - FRAME_EPS || v.currentTime >= exportOutSec - FRAME_EPS) {
                v.currentTime = inSec
                updatePos(inSec)
              }
            }}
            onPause={() => setPlaying(false)}
            onVolumeChange={() => { setVcVolume(videoRef.current?.volume ?? 1); setVcMuted(videoRef.current?.muted ?? false) }}
          />
          <div style={{ ...vcBarStyle, position: 'absolute', bottom: 0, left: 0, right: 0 }}>
            <button style={vcBtnStyle} onClick={() => { const v = videoRef.current; if (v) v.paused ? v.play() : v.pause() }}>
              <PlayPauseIcon playing={playing} />
            </button>
            <div style={{ flex: 1 }} />
            {/* updatePos() が毎フレーム textContent を書き換える先。ref だけ作られて
                JSX に出ておらず、現在時刻がどこにも表示されていなかった。 */}
            <span ref={vcTimeLabelRef} style={vcTimeLabelStyle}>{fmtTime(posRef.current)} / {fmtTime(dur)}</span>
            <VolumeControl videoRef={videoRef} volume={vcVolume} muted={vcMuted} />
          </div>
        </div>

        <div style={s.timelineWrap}>
          <div
            ref={timelineRef}
            style={s.timeline}
            onClick={handleTimelineClick}
            title={t('trim.seekHint')}
          >
            <div style={{ ...s.timelineStrip, ...(stripUrl ? { backgroundImage: `url(${stripUrl})`, backgroundSize: '100% 100%' } : {}) }}>
              {dur > 0 && (
                <>
                  <div ref={inDimRef} style={{ ...s.timelineDim, left: 0, width: pct(inSec) }} />
                  <div ref={outDimRef} style={{ ...s.timelineDim, left: pct(exportOutSec), right: 0 }} />
                </>
              )}
            </div>
            {dur > 0 && (
              <>
                <div ref={selBorderRef} style={{ ...s.selectionBorder, left: pct(inSec), width: `calc(${pct(exportOutSec)} - ${pct(inSec)})` }} />
                <div ref={inTabRef} style={{ ...s.handleTab, ...s.handleTabIn, left: pct(inSec) }}>
                  <span style={{ ...s.handleFlag, ...s.handleFlagIn }}>IN</span>
                </div>
                <div ref={outTabRef} style={{ ...s.handleTab, ...s.handleTabOut, left: pct(exportOutSec) }}>
                  <span style={{ ...s.handleFlag, ...s.handleFlagOut }}>OUT</span>
                </div>
                <div ref={inHandleRef} style={{ ...s.dragHandle, left: pct(inSec) }} onMouseDown={(e) => startDrag('in', e)} />
                <div ref={outHandleRef} style={{ ...s.dragHandle, left: pct(exportOutSec) }} onMouseDown={(e) => startDrag('out', e)} />
                <div ref={playheadRef} style={{ ...s.playhead, left: pct(posRef.current) }} />
              </>
            )}
          </div>
        </div>

        <div style={s.controls}>
          <div style={s.boundaryGrid}>
            {/* IN/OUT の 2 枚は同じグリッドテンプレート（boundaryCard）を共有する。
                左右カードで各列の幅が一致するので、バッジ・時刻・コマ送り・設定ボタンが
                横一列に揃う（列幅がボタン文言の長さで動かないよう setBtn は固定幅）。 */}
            <div style={{ ...s.boundaryCard, ...s.boundaryCardIn }}>
              <span style={{ ...s.badge, ...s.badgeIn }}>IN</span>
              <span ref={inTimeRef} style={s.time}>{fmtTime(inSec)}</span>
              <span ref={inFrameRef} style={s.frameNum}>{hasTable ? `f${inIdx + 1}` : ''}</span>
              <div style={s.stepper}>
                <button style={s.stepBtn} onClick={() => stepIn(-1)} disabled={ptsLoading}>−1f</button>
                <button style={{ ...s.stepBtn, ...s.stepBtnRight }} onClick={() => stepIn(+1)} disabled={ptsLoading}>+1f</button>
              </div>
              <button style={{ ...s.setBtn, ...s.setBtnIn }} onClick={setCurrentAsIn}>{t('trim.setIn')}</button>
            </div>
            <div style={{ ...s.boundaryCard, ...s.boundaryCardOut }}>
              <span style={{ ...s.badge, ...s.badgeOut }}>OUT</span>
              <span ref={outTimeRef} style={s.time}>{fmtTime(outSec)}</span>
              <span ref={outFrameRef} style={s.frameNum}>{hasTable ? `f${outIdx + 1}` : ''}</span>
              <div style={s.stepper}>
                <button style={s.stepBtn} onClick={() => stepOut(-1)} disabled={ptsLoading}>−1f</button>
                <button style={{ ...s.stepBtn, ...s.stepBtnRight }} onClick={() => stepOut(+1)} disabled={ptsLoading}>+1f</button>
              </div>
              <button style={{ ...s.setBtn, ...s.setBtnOut }} onClick={setCurrentAsOut}>{t('trim.setOut')}</button>
            </div>
          </div>
          <div style={s.infoRow}>
            <span ref={selRangeRef} style={s.duration}>
              {t('trim.selection', { seconds: (exportOutSec - inSec).toFixed(2) })}
              {selFrames != null && ` (${selFrames}f)`}
            </span>
            {ptsLoading && <span style={s.ptsStatus}>{t('trim.analyzing')}</span>}
            {!ptsLoading && ptsError && <span style={s.ptsWarn}>{t('trim.analyzeFailed')}</span>}
            <span style={s.shortcutHint}>{t('trim.shortcutHint')}</span>
          </div>
          {error && <div style={s.errorMsg}>{t('trim.error', { message: error })}</div>}
        </div>

        <div style={s.footer}>
          <button style={s.cancelBtn} onClick={requestClose} disabled={trimming}>{t('action.cancel')}</button>
          <button
            style={{ ...s.trimBtn, ...(!canTrim || trimming ? s.trimDisabled : {}) }}
            onClick={handleTrim}
            disabled={!canTrim || trimming}
          >
            {trimming ? t('trim.working') : t('trim.save')}
          </button>
        </div>
      </div>
      {showCloseConfirm && (
        <ConfirmDialog
          title={t('trim.discardTitle')}
          message={t('trim.discardMessage')}
          confirmLabel={t('action.close')}
          danger
          onConfirm={onClose}
          onClose={() => setShowCloseConfirm(false)}
        />
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(var(--scrim-rgb), 0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 6000 },
  modal: { background: 'var(--bg-page)', border: '1px solid var(--border-default)', borderRadius: radius.md, width: 'calc(100vw - clamp(48px, 6vw, 112px))', maxWidth: 1280, maxHeight: '96vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 70px rgba(0,0,0,0.64)' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '10px 16px', borderBottom: '1px solid var(--border-default)', flexShrink: 0 },
  fileTitle: { minWidth: 0, color: 'var(--text-primary)', fontSize: font.lg, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  closeBtn: { background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0, minWidth: 28, minHeight: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  videoWrap: { position: 'relative', flexShrink: 1, minHeight: 0, display: 'flex', justifyContent: 'center', background: '#000' },
  // 190 → 260: タイムライン上の IN/OUT フラグ用の余白と、カード化した IN/OUT 行の
  // 分だけ映像以外の高さが増えたぶんを反映する（ここがズレると縦スクロールが出る）。
  video: { width: '100%', maxHeight: 'calc(96vh - 260px)', aspectRatio: '16/9', background: '#000', display: 'block', objectFit: 'contain' as const, cursor: 'pointer' },
  // タイムラインの上に IN/OUT のフラグを出す余白。フラグはハンドル(handleTab)の
  // 子なので、ドラッグで left% が動けば一緒に動く（追加の ref を持たなくてよい）。
  timelineWrap: { padding: '26px 16px 0', flexShrink: 0 },
  timeline: { position: 'relative', height: 52, background: 'var(--bg-inset-strong)', border: '1px solid var(--border-default)', cursor: 'crosshair', borderRadius: radius.md },
  timelineStrip: { position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 4 },
  // 範囲外は「暗くする」だけでなく彩度も落とす。選択範囲だけが色を保つので、
  // どこを切り出すのかがサムネイルの色の有無で一目で分かる。
  timelineDim: { position: 'absolute', top: 0, bottom: 0, background: 'rgba(var(--scrim-rgb), 0.62)', backdropFilter: 'grayscale(1) brightness(0.72)', WebkitBackdropFilter: 'grayscale(1) brightness(0.72)', pointerEvents: 'none' } as React.CSSProperties,
  // 選択範囲は塗りを載せない（サムネイルの色をそのまま見せる）。上下のレールだけで
  // 帯を示す。IN=緑 / OUT=赤 に色を割り当てているので、ここに 3 色目の色相を
  // 足さないようレールは無彩色にする。
  selectionBorder: { position: 'absolute', top: 0, bottom: 0, borderTop: '2px solid rgba(255,255,255,0.92)', borderBottom: '2px solid rgba(255,255,255,0.92)', pointerEvents: 'none', zIndex: 1 },
  handleTab: { position: 'absolute', top: -1, bottom: -1, width: 4, transform: 'translateX(-50%)', pointerEvents: 'none', zIndex: 2, boxShadow: '0 0 0 1px rgba(var(--scrim-rgb), 0.55)' },
  handleTabIn: { background: 'var(--success)', borderRadius: '2px 0 0 2px' },
  handleTabOut: { background: 'var(--danger)', borderRadius: '0 2px 2px 0' },
  handleFlag: { position: 'absolute', bottom: 'calc(100% + 5px)', left: '50%', transform: 'translateX(-50%)', padding: '1px 6px', borderRadius: radius.md, fontSize: 10, fontWeight: 900, letterSpacing: 0.6, lineHeight: '15px', whiteSpace: 'nowrap' as const },
  handleFlagIn: { background: 'var(--success)', color: 'var(--bg-page)' },
  handleFlagOut: { background: 'var(--danger)', color: 'var(--bg-page)' },
  dragHandle: { position: 'absolute', top: 0, bottom: 0, width: 22, marginLeft: -11, cursor: 'ew-resize', zIndex: 3 },
  playhead: { position: 'absolute', top: -3, bottom: -3, width: 2, background: '#fff', transform: 'translateX(-50%)', pointerEvents: 'none', boxShadow: '0 0 0 1px rgba(0,0,0,0.55)' },
  controls: { padding: '12px 16px 8px', display: 'flex', flexDirection: 'column', gap: 9, flexShrink: 0 },
  boundaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 10 },
  // 列: バッジ / 時刻 / コマ番号 / コマ送り(右寄せ) / 設定ボタン(固定幅)。
  // 2 枚のカードで同一なので左右で必ず揃う。
  boundaryCard: { display: 'grid', gridTemplateColumns: '38px 74px 40px 1fr auto', alignItems: 'center', gap: 8, minWidth: 0, padding: '8px 10px', background: 'var(--bg-inset)', border: '1px solid var(--border-default)', borderRadius: radius.md },
  boundaryCardIn: { borderLeft: '3px solid rgba(var(--success-rgb), 0.75)' },
  boundaryCardOut: { borderLeft: '3px solid rgba(var(--danger-rgb), 0.75)' },
  badge: { boxSizing: 'border-box' as const, height: 20, lineHeight: '18px', borderRadius: radius.md, fontSize: 10, fontWeight: 900, letterSpacing: 0.6, textAlign: 'center' as const },
  badgeIn: { background: 'rgba(var(--success-rgb), 0.16)', border: '1px solid rgba(var(--success-rgb), 0.5)', color: 'var(--success)' },
  badgeOut: { background: 'rgba(var(--danger-rgb), 0.16)', border: '1px solid rgba(var(--danger-rgb), 0.5)', color: 'var(--danger)' },
  time: { fontSize: font.base, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' as const, letterSpacing: 0.2 },
  frameNum: { fontSize: font.xs, fontWeight: 700, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' as const },
  // コマ送りは 2 つの独立したボタンではなく、枠を共有するセグメントにする
  // （個別のピルが並ぶと右端が揃わずガタついて見えた）。
  stepper: { justifySelf: 'end', display: 'inline-flex', alignItems: 'stretch', height: 28, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, overflow: 'hidden' },
  stepBtn: { width: 46, padding: 0, background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: font.sm, fontWeight: 700, fontVariantNumeric: 'tabular-nums' as const, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  stepBtnRight: { borderLeft: '1px solid var(--border-strong)' },
  setBtn: { boxSizing: 'border-box' as const, width: 108, height: 28, padding: 0, borderRadius: radius.md, cursor: 'pointer', fontSize: font.sm, fontWeight: 800, whiteSpace: 'nowrap' as const },
  setBtnIn: { background: 'rgba(var(--success-rgb), 0.14)', border: '1px solid rgba(var(--success-rgb), 0.45)', color: 'var(--success)' },
  setBtnOut: { background: 'rgba(var(--danger-rgb), 0.14)', border: '1px solid rgba(var(--danger-rgb), 0.45)', color: 'var(--danger)' },
  infoRow: { display: 'flex', alignItems: 'center', gap: 12, minHeight: 18 },
  duration: { color: 'var(--text-primary)', fontSize: font.xs, fontWeight: 800, fontVariantNumeric: 'tabular-nums' as const, whiteSpace: 'nowrap' as const },
  ptsStatus: { color: 'var(--text-secondary)', fontSize: font.xs, fontStyle: 'italic' },
  ptsWarn: { color: 'var(--warning)', fontSize: font.xs, fontStyle: 'italic' },
  errorMsg: { color: color.danger, fontSize: font.sm },
  shortcutHint: { color: 'var(--text-muted)', fontSize: font.xs, letterSpacing: 0.2, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' },
  footer: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, padding: '10px 16px', borderTop: '1px solid var(--border-default)', flexShrink: 0 },
  // フッターの 2 ボタンは ConfirmDialog と同じ組み合わせにする。以前この保存ボタンだけが
  // var(--accent) のベタ塗り＋白文字で、明るい藤色に白を載せるためコントラストが約 2:1 しか
  // 出ず濁って見えていた（かつアプリ内で唯一の見た目でもあった）。ティント地＋アクセント文字なら
  // 地に対して文字が十分明るく、ライト/ダークどちらでも成立する。
  cancelBtn: { boxSizing: 'border-box' as const, height: 34, padding: '0 16px', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, color: 'var(--text-primary)', cursor: 'pointer', fontSize: font.sm, fontWeight: 800 },
  trimBtn: { boxSizing: 'border-box' as const, height: 34, padding: '0 20px', background: 'rgba(var(--accent-rgb), 0.2)', border: '1px solid rgba(var(--accent-rgb), 0.55)', borderRadius: radius.md, color: 'var(--accent-text)', cursor: 'pointer', fontSize: font.sm, fontWeight: 800 },
  trimDisabled: { opacity: 0.4, cursor: 'not-allowed' },
}
