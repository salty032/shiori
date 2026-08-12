import { useState, useEffect, useRef, useImperativeHandle, forwardRef, memo } from 'react'
import { mediaUrl } from '../utils'
import { findFrameIdx, frameSeekTarget } from '../frameTable'
import { getClipFramesResolver } from '../features/registry'
import { useT, type Translate, type MessageKey } from '../i18n'
import { font } from '../styles'
import { FRAME_QUALITY, type ClipFrames } from '../../../shared/api.video'
import type { ImageSource } from '../../../shared/types'
import {
  useVcStyles, vcBtnStyle, vcTimeLabelStyle, PlayPauseIcon, VolumeControl, RateControl, LoopButton,
  vcBarStyle, vcBarOverlayStyle, VC_OVERLAY_HEIGHT, vcSeekTrackStyle, vcSeekBarStyle, vcSeekFillStyle, vcSeekThumbStyle
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

/**
 * コマ表示が今どの土台で動いているか。**コマ送りの結果をどう読んでよいかが変わる**ので、
 * 内部で分岐するだけでなく画面にも出す（docs/ANIME-FRAMES.md 4章「保証できないときは
 * 保証できないと出す」）。
 *
 *   off       … コマ表示をしない（詳細パネル。表を取りに行かないので何も言えない）
 *   loading   … 表を取得中。**推定に落とさず、押されたコマ送りは保留する**
 *   source    … 素材の実コマ単位。1 コマ送り＝素材の 1 コマ
 *   file      … ファイルに記録されたフレーム単位（表が無い／対応が取れなかった）
 *   estimated … フレーム位置すら取れず、fps 換算の刻みで動いている
 */
type ReadoutKind = 'off' | 'loading' | 'source' | 'file' | 'estimated'

// 表の取得が終わるまでに溜められるコマ送りの上限。
// 押した回数ぶんは動かしたいが、キーリピートを押しっぱなしにした場合まで積むと、
// 読み込み完了の瞬間に何十コマも飛んで「どこを見ているか分からない」状態になる。
const MAX_PENDING_STEPS = 30

// コマ表示の色。**映像に直接重なる層なので、テーマ変数ではなくオンビデオの固定色にする**
// （コントロールバーが半透明ホワイトに統一しているのと同じ判断。videoControls.tsx 参照）。
const FRAME_COLOR = {
  /** 素材のコマ単位で送れている・確からしさに問題が無い */
  ok: 'rgba(255,255,255,0.92)',
  /** 補足情報（読み込み中・実害なしと確認済みの流用） */
  muted: 'rgba(255,255,255,0.62)',
  /** 黙って誤読させうる状態（未検証の流用・素材のコマ単位でない） */
  warn: '#ffcf70',
  /** 検証の結果、絵が変わっていて特定不能と分かったコマ */
  alert: '#ff9aa2',
}

// コマごとの確からしさに添える注記。null（撮れているコマ）のときは番号だけを出す——
// **問題が無いときに何も足さない**のが要点で、常に何か表示していると注記が背景になる。
const FRAME_NOTE: Record<number, { label: MessageKey; hint: MessageKey; color: string } | null> = {
  [FRAME_QUALITY.captured]: null,
  [FRAME_QUALITY.reused]: { label: 'viewer.frameReused', hint: 'viewer.frameReusedHint', color: FRAME_COLOR.warn },
  [FRAME_QUALITY.reusedSame]: { label: 'viewer.frameReusedSame', hint: 'viewer.frameReusedSameHint', color: FRAME_COLOR.muted },
  [FRAME_QUALITY.reusedChanged]: { label: 'viewer.frameNeedsReview', hint: 'viewer.frameNeedsReviewHint', color: FRAME_COLOR.alert },
}

// コマ表示の置き場所。コントロールバー（ホバー時だけ出る）の上に重ねる。
// **バーの中に入れないのは、バーがホバー中しか出ないため** —— キーボードでコマ送りして
// いる間はポインタが映像の上に無いことが多く、肝心の番号が見えない。
const frameReadoutStyle: React.CSSProperties = {
  position: 'absolute', left: 10, bottom: VC_OVERLAY_HEIGHT + 2, zIndex: 3,
  pointerEvents: 'auto', cursor: 'help',
  padding: '2px 7px', borderRadius: 4, background: 'rgba(6,8,12,0.72)',
  fontSize: font.xs, fontWeight: 700, fontVariantNumeric: 'tabular-nums', letterSpacing: 0,
  whiteSpace: 'nowrap', textShadow: '0 1px 3px rgba(0,0,0,0.9)',
  transition: 'opacity 0.15s ease',
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
  /** 実フレーム表が使えないときのコマ送りの刻み幅（settings.frameFps）。省略時は 24。 */
  fps?: number
  /** コマ情報（実フレーム時刻とコマごとの確からしさ）を先読みし、コマ送りを素材の実コマへ
   *  吸着させる。あわせてコマ番号の表示も出す。
   *  解析は main 側でキャッシュされるとはいえ初回は ffmpeg が走るため、実際にコマを
   *  数えるビューアでだけ有効にする（サムネの隣で内容を確かめるだけの詳細パネルでは、
   *  クリップを選び替えるたびに解析が走る方が損になる）。 */
  preloadFrameTable?: boolean
  /** 録画クリップか取り込み動画か。**表が無いときの表示の意味が変わる**ため受け取る。
   *  取り込み動画はファイルのフレーム＝素材のコマだが、録画クリップのファイルのフレームは
   *  画面キャプチャの供給レートの産物で、素材のコマとは対応しない。 */
  clipSource?: ImageSource
  // 再生速度・ループをコントロールバーに出す。腰を据えて 1 本を見るビューア専用で、
  // 詳細パネル（サムネの隣で内容を確かめるだけの小さい枠）には出さない。
  // 狭いバーにボタンが増えるほど、そこでの用途である「どのクリップか確認する」が
  // やりにくくなるため。既定は出さない側に倒す。
  showRateLoop?: boolean
}

const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer({ id, wrapperStyle, videoStyle, autoPlay, pauseWhen, onVideoClick, fps, showRateLoop, preloadFrameTable, clipSource }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const stepSec = 1 / Math.max(1, fps || 24)
  // このクリップのコマ情報。取得できるまで（および capture 版）は null のまま。
  const framesRef = useRef<ClipFrames | null>(null)
  // コマ送りの現在位置は「時刻」ではなく PTS 表の添字で持つ。
  //
  // 時刻で持って毎回シーク結果を実測し直すと、連打したときに前のシークの実測（非同期で
  // 返る）が後から古い位置を書き戻し、複数のコールバックが順不同で効くため、送り先が
  // 前後に飛んでコマ順が崩れる。添字を自分で ±1 していけば何回連打しても単調に動く。
  // null = まだ確定していない（外部の再生位置から引き直す）。
  const frameIdxRef = useRef<number | null>(null)
  // 自分のコマ送りによるシークかどうか。自分で動かした直後に外部同期（onSeeked）が
  // 添字を引き直すと、上と同じ書き戻しが起きるため 1 回だけ読み飛ばす。
  const selfSeekRef = useRef(false)
  // コマ表の取得が終わるまでに押されたコマ送りの正味の量（MAX_PENDING_STEPS で頭打ち）。
  const pendingStepsRef = useRef(0)

  const { t } = useT()
  // コマ表示はフレームごとに書き換わるので、React の再描画ではなく DOM を直接触る
  // （時刻ラベルが updateVcTime で同じことをしているのと同じ理由。再生中は毎フレーム来る）。
  const frameLabelRef = useRef<HTMLSpanElement>(null)
  const [readout, setReadout] = useState<ReadoutKind>('off')
  // 描画外（コマ送り・rVFC）から読むため ref にも持つ。state だけだと useImperativeHandle が
  // 掴んだ古いクロージャが古い値を見る。
  const readoutRef = useRef<ReadoutKind>('off')
  const tRef = useRef<Translate['t']>(t)
  tRef.current = t

  function setReadoutKind(kind: ReadoutKind): void {
    readoutRef.current = kind
    setReadout(kind)
  }

  useEffect(() => {
    framesRef.current = null
    frameIdxRef.current = null
    selfSeekRef.current = false
    pendingStepsRef.current = 0
    if (!preloadFrameTable) { setReadoutKind('off'); return }
    const resolve = getClipFramesResolver()
    // capture 版（video 機能ごと落とした構成）。コマの位置は分からないので fps 換算になる。
    if (!resolve) { setReadoutKind('estimated'); return }
    setReadoutKind('loading')
    let canceled = false
    // 取得の成否どちらでも、保留していたコマ送りをそこで解放する。
    // **保留したまま握り潰すと「押したのに動かない」で終わる**ため、失敗しても必ず動かす。
    const settle = (frames: ClipFrames | null): void => {
      if (canceled) return
      framesRef.current = frames
      setReadoutKind(!frames || frames.pts.length === 0 ? 'estimated' : frames.sourceBased ? 'source' : 'file')
      const pending = pendingStepsRef.current
      pendingStepsRef.current = 0
      if (pending !== 0) moveFrames(pending)
      else refreshFrameReadout()
    }
    resolve(id)
      .then(settle)
      .catch((err) => { console.warn('[video] clip frames unavailable', err); settle(null) })
    return () => { canceled = true }
  }, [id, preloadFrameTable])

  // シークバー操作・再生・読み込み直後など、コマ送り以外の理由で位置が動いたときに
  // 添字を実際の再生位置から引き直す。
  function syncFrameIdx(): void {
    if (selfSeekRef.current) { selfSeekRef.current = false; return }
    const v = videoRef.current
    const pts = framesRef.current?.pts
    if (!v || !pts || pts.length === 0) return
    frameIdxRef.current = findFrameIdx(pts, v.currentTime)
    updateFrameReadout(frameIdxRef.current)
  }

  // 現在の再生位置からコマ表示を引き直す（添字がまだ確定していない場合も含む）。
  function refreshFrameReadout(): void {
    const v = videoRef.current
    const pts = framesRef.current?.pts
    const idx = frameIdxRef.current ?? (v && pts && pts.length > 0 ? findFrameIdx(pts, v.currentTime) : 0)
    updateFrameReadout(idx)
  }

  // コマ表示を書き換える。
  //
  // **番号だけでは足りない。** コマ送りで絵が変わらないこと自体が測定結果（コマ打ち）なので、
  // 変わらなかった理由が「素材がその絵を保持していた」のか「こちらが撮り逃して直前の絵を
  // 流用している」のかを、その場で区別できる必要がある。詳細パネルの合計枚数だけでは
  // 「どこかに N コマ嘘がある」としか言えない。
  function updateFrameReadout(idx: number): void {
    const el = frameLabelRef.current
    if (!el) return
    const tr = tRef.current
    const kind = readoutRef.current
    if (kind === 'loading') {
      el.textContent = tr('viewer.frameLoading')
      el.title = tr('viewer.frameLoadingHint')
      el.style.color = FRAME_COLOR.muted
      return
    }
    if (kind === 'estimated') {
      el.textContent = tr('viewer.frameEstimated', { fps: String(Math.round(1 / stepSec)) })
      el.title = tr('viewer.frameEstimatedHint')
      el.style.color = FRAME_COLOR.warn
      return
    }
    const frames = framesRef.current
    if (!frames || frames.pts.length === 0) return
    const total = frames.pts.length
    const cur = Math.max(0, Math.min(idx, total - 1))
    // 番号は 1 始まり。0 始まりだと先頭が「0 / 719」になり、何コマ目かを数える用途では
    // 毎回読み替えが要る（トリマーの f{N} 表示も同じ数え方に揃えてある）。
    const params = { cur: String(cur + 1), total: String(total) }

    if (kind === 'file') {
      // 表が無い＝ファイルに記録されたフレームをそのまま送っている。取り込み動画なら
      // それが素材のコマそのものだが、録画クリップのフレームは画面キャプチャの供給レートの
      // 産物で素材のコマとは対応しない。**後者は黙って通してはいけない。**
      const isImport = clipSource === 'import'
      el.textContent = tr(isImport ? 'viewer.frameIndex' : 'viewer.frameIndexFile', params)
      el.title = tr(isImport ? 'viewer.frameFileHint' : 'viewer.frameFileCaptureHint')
      el.style.color = isImport ? FRAME_COLOR.ok : FRAME_COLOR.warn
      return
    }

    const note = FRAME_NOTE[frames.quality[cur] ?? FRAME_QUALITY.captured]
    el.textContent = note ? `${tr('viewer.frameIndex', params)} · ${tr(note.label)}` : tr('viewer.frameIndex', params)
    el.title = tr(note ? note.hint : 'viewer.frameSourceHint')
    el.style.color = note ? note.color : FRAME_COLOR.ok
  }

  // delta コマ動かす（正で先へ、負で前へ）。
  // コマ表があるときは隣のコマへ直接移る。表がないとき（capture 版・解析失敗）だけ従来の
  // fps 換算に落ちる。その場合は境界を必ず跨ぐよう半コマ余分に送る（進む側 +1.5 / 戻る側 -0.5）。
  function moveFrames(delta: number): void {
    const v = videoRef.current
    if (!v || delta === 0) return
    v.pause()
    const limit = isFinite(v.duration) ? v.duration : Number.MAX_SAFE_INTEGER
    const pts = framesRef.current?.pts ?? []
    if (pts.length > 0) {
      const cur = frameIdxRef.current ?? findFrameIdx(pts, v.currentTime)
      const next = Math.max(0, Math.min(cur + delta, pts.length - 1))
      frameIdxRef.current = next
      // 端でも表示だけは更新する。「719 / 719」で止まっていれば、壊れているのではなく
      // 端まで来たのだと分かる（以前は無反応で、どちらか区別できなかった）。
      updateFrameReadout(next)
      if (next === cur) return
      selfSeekRef.current = true
      v.currentTime = Math.max(0, Math.min(frameSeekTarget(pts, next, stepSec), limit))
      return
    }
    v.currentTime = Math.max(0, Math.min(v.currentTime + stepSec * (delta + 0.5), limit))
    updateFrameReadout(0)
  }

  // 1 コマ進む / 戻る。
  //
  // **コマ表の取得中は推定の刻みへ落とさず保留する。** 実測（コマ表）が数百ms 後に必ず
  // 来るのに、その間だけ fps 換算で動かすと、開いた直後の 1〜2 手だけ素材のコマと無関係な
  // 位置へ飛ぶ。ビューアを開いてすぐ押すのは普通の操作なので、ここは待つ方が正しい。
  function stepFrame(dir: number): void {
    const v = videoRef.current
    if (!v) return
    if (readoutRef.current === 'loading') {
      v.pause()   // 保留中でも再生は止める（押した意図は「ここで止めて見る」なので）
      pendingStepsRef.current = Math.max(-MAX_PENDING_STEPS, Math.min(pendingStepsRef.current + dir, MAX_PENDING_STEPS))
      return
    }
    moveFrames(dir)
  }

  // 毎描画で最新に差し替える。useImperativeHandle の依存に props を並べると、足し忘れた
  // ものが黙って古いまま使われる（stepSec だけ並べていた頃の形）。
  const stepFrameRef = useRef(stepFrame)
  stepFrameRef.current = stepFrame

  useImperativeHandle(ref, () => ({
    togglePlay: () => {
      const v = videoRef.current
      if (!v) return
      if (v.paused) v.play(); else v.pause()
    },
    stepFrame: (dir: number) => stepFrameRef.current(dir),
  }), [])
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

  // 表示種別が変わったとき（読み込み完了・取得失敗）と言語切り替えで書き直す。
  // 中身は DOM を直接触っているので、React の再描画だけでは空のまま残る。
  //
  // playing も見る：再生中は書き換えを止めているので、止めた瞬間に最後のコマへ追いつかせる
  // 必要がある（これが無いと、再生して止めたときだけ古い番号が残る）。
  useEffect(() => { refreshFrameReadout() }, [readout, t, playing])

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
      // 再生を止めた位置からそのままコマ送りを続けられるよう、添字も追い続ける。
      // 再生中は自分のシークと競合しないので、ここは実測をそのまま反映してよい。
      // 添字は追い続けるが、**コマ表示は書き換えない**。再生中は毎フレーム値が変わるため、
      // 書き換えると番号も「流用 / 要確認」の注記も高速に明滅して読めたものではなくなる
      // （そもそも再生中は隠している。下の JSX を参照）。
      const pts = framesRef.current?.pts
      if (pts && pts.length > 0) frameIdxRef.current = findFrameIdx(pts, meta.mediaTime)
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
          // シークバー操作など、コマ送り以外で位置が動いたときに添字を引き直す。
          onSeeked={syncFrameIdx}
          onLoadedData={syncFrameIdx}
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
        {/* コマ表示は**止まっている間だけ**出す。
            コマ番号も「流用 / 要確認」も 1 コマを見定めるための情報で、再生中は毎フレーム
            変わるため出しても読めず、注記が明滅して映像の邪魔にしかならない。
            コマ送りは必ず一時停止させるので、送った瞬間から見える。 */}
        {readout !== 'off' && (
          <span
            ref={frameLabelRef}
            style={{
              ...frameReadoutStyle,
              opacity: playing ? 0 : 1,
              pointerEvents: playing ? 'none' : 'auto',
            }}
            onClick={(e) => e.stopPropagation()}
          />
        )}
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
