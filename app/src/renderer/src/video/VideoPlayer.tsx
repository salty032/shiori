import { useState, useEffect, useRef, useImperativeHandle, forwardRef, memo, Fragment } from 'react'
import { mediaUrl } from '../utils'
import { clipStatus } from './frameReadout'
import { isPrecisionGuaranteed } from '../../../shared/frame-severity'
import { useT } from '../i18n'
import { useLatestRef } from '../hooks/useLatestRef'
import { useFramePosition } from './useFramePosition'
import { useFramePlay } from './useFramePlay'
import { watchVideoFrames } from './videoFrameCallback'
import { font, radius, weight } from '../styles'
import type { ClipFrames } from '../../../shared/api.video'
import type { ImageSource } from '../../../shared/types'
import {
  vcBtnStyle, vcTimeLabelStyle, PlayPauseIcon, VolumeControl, SpeedControl, LoopButton, type PlaybackSpeed,
  vcBarStyle, vcBarOverlayStyle, VC_OVERLAY_HEIGHT, vcSeekTrackStyle, vcSeekBarStyle, vcSeekFillStyle, vcSeekThumbStyle, VC_SEEK_THUMB
} from './videoControls'

export type VideoPlayerHandle = {
  togglePlay: () => void
  /** dir>0 で次のコマ、dir<0 で前のコマへ。再生中なら一時停止してから動く。 */
  stepFrame: (dir: number) => void
  /** 指定の素材コマへ直接移る（タイムシートの行をクリックしたとき）。表が無ければ何もしない。 */
  goToFrame: (idx: number) => void
  /** 音を消す / 戻す。バーのミュートボタンと同じ状態を触る（直近の値はクリップをまたいで残る）。 */
  toggleMute: () => void
  adjustVolume: (delta: number) => void
  /**
   * 映像要素そのもの。**ズーム/パンの計算にだけ使う**（表示枠の矩形と映像の実寸が要る）。
   * 再生制御をここから触らないこと——それは上の 2 つの役目で、両方から触ると
   * 状態の持ち主が曖昧になる。
   */
  element: () => HTMLVideoElement | null
}

function fmtDur(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// ReadoutKind / FRAME_COLOR / FRAME_NOTE は frameReadout.ts が原本（判定と一緒に置く）。

// 再生中、ポインタが止まってからコントロールバーを引くまでの時間（ビューアのみ）。
// 短いと映像を見ている間に何度も出入りしてちらつき、長いと映像の下端が隠れ続ける。
const CONTROLS_IDLE_MS = 2500

// コマ表示の置き場所。コントロールバー（ホバー時だけ出る）の上に重ねる。
// **バーの中に入れないのは、バーがホバー中しか出ないため** —— キーボードでコマ送りして
// いる間はポインタが映像の上に無いことが多く、肝心の番号が見えない。
// この録画の状態の一覧（コマ番号を押すと開く）。コマ表示のすぐ上に、同じ調子で重ねる。
const frameLegendStyle: React.CSSProperties = {
  position: 'absolute', left: 10, bottom: VC_OVERLAY_HEIGHT + 30, zIndex: 4,
  pointerEvents: 'auto', cursor: 'pointer',
  // 2 列の格子。**説明文の左端を揃える**ため（横並びだと語の長さで開始位置がずれる）。
  display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 6, alignItems: 'baseline',
  padding: '10px 13px', borderRadius: radius.md, background: 'rgba(26,26,26,0.86)',
  fontSize: font.xs, lineHeight: 1.5, color: 'rgba(255,255,255,0.92)',
  maxWidth: 'min(420px, calc(100% - 20px))',
  textShadow: '0 1px 3px rgba(0,0,0,0.9)',
}

const frameReadoutStyle: React.CSSProperties = {
  position: 'absolute', left: 10, bottom: VC_OVERLAY_HEIGHT + 2, zIndex: 3,
  pointerEvents: 'auto', cursor: 'help',
  padding: '2px 7px', borderRadius: radius.md, background: 'rgba(26,26,26,0.72)',
  fontSize: font.xs, fontWeight: weight.medium, fontVariantNumeric: 'tabular-nums', letterSpacing: 0,
  whiteSpace: 'nowrap', textShadow: '0 1px 3px rgba(0,0,0,0.9)',
  transition: 'opacity 0.15s ease',
}

// セッション内で音量・ミュート・コマ再生の速さ・ループを共有し、クリップを切り替えても
// 引き継ぐ（ビューア⇔詳細パネルで VideoPlayer が remount されても維持される）。
// 速さとループを含めるのは、研究中に「1 コマ 0.25 秒 + ループ」へ整えた作業環境がクリップを
// 送るたびに既定へ戻ってしまうと、毎回設定し直す手間が本題を邪魔するため。
let lastVolume = 1
let lastMuted = false
let lastSpeed: PlaybackSpeed = null
let lastLoop = false

type Props = {
  id: number
  wrapperStyle?: React.CSSProperties
  videoStyle?: React.CSSProperties
  /** 映像を枠の中で切り取る（ビューアで拡大している間）。操作バーは枠の下端に重なるので、
   *  映像だけ枠の外へはみ出すと、バーの暗い帯が映像の途中に浮く。ほかの動画アプリと同じく
   *  拡大した映像は枠の中に収める。常に切らないのは、詳細欄の小さな枠でコマ番号の説明が切れるため。 */
  clipMedia?: boolean
  autoPlay?: boolean
  pauseWhen?: boolean
  onVideoClick?: (e: React.MouseEvent<HTMLVideoElement>) => boolean
  /** 実フレーム表が使えないときのコマ送りの刻み幅（録画・動画の fps）。分からなければ 24。 */
  fps?: number
  /** 録画そのものの素材 fps（images.fps）。30fps を超えるとコマの判定を出さず「精度保証外」と出す */
  clipFps?: number | null
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
  // コマ再生・ループをコントロールバーに出す。腰を据えて 1 本を見るビューア専用で、
  // 詳細パネル（サムネの隣で内容を確かめるだけの小さい枠）には出さない。
  // 狭いバーにボタンが増えるほど、そこでの用途である「どのクリップか確認する」が
  // やりにくくなるため。既定は出さない側に倒す。
  showRateLoop?: boolean
  /** コマ表の取得が終わったら 1 度だけ知らせる（null は表が無い＝コマ単位で数えられない）。 */
  onFramesReady?: (frames: ClipFrames | null) => void
  /** 現在コマが変わったら知らせる。**再生中は呼ばない**——コマ表示と同じ理由で、
   *  毎フレーム変わる値を出しても読めないうえ、受け手（タイムシート）が高速に再描画される。
   *  gap は、この実測行の後ろにある推定抜けの何コマ目か（実測行そのものは 0）。 */
  onFrameIndex?: (idx: number, gap: number) => void
}

const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer({ id, wrapperStyle, videoStyle, clipMedia, autoPlay, pauseWhen, onVideoClick, fps, clipFps, showRateLoop, preloadFrameTable, clipSource, onFramesReady, onFrameIndex }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null)
  // コマ再生で、先に作った絵を映像の真上に重ねる先（useFramePlay）。
  const frameOverlayRef = useRef<HTMLCanvasElement>(null)
  const stepSec = 1 / Math.max(1, fps || 24)
  const { t } = useT()
  const [legendOpen, setLegendOpen] = useState(false)
  // いま素材の何コマ目に居るか（コマ表の取得・±1 コマ・コマ番号の表示）は useFramePosition が持つ。
  // ここは再生・シークバー・音量・コマ再生と、画面の組み立て。
  const position = useFramePosition({
    videoRef, id, preloadFrameTable, stepSec, clipSource, clipFps, onFramesReady, onFrameIndex,
    onManualStep: () => setFramePlay(false),
  })
  const {
    readout, readoutRef, frameLabelRef, framesRef, gapIndexRef, frameEnd,
    currentFrameIdx, syncFrameIdx, stepFrame, goToFrame
  } = position

  // 下の effect から呼ぶコマ送りの関数と刻み幅は、描画ごとに作り直される（言語・表の読み込み）。
  // 付け直さずに、呼ぶ時点の最新を使う。
  const frameActionsRef = useLatestRef({
    moveFrames: position.moveFrames, refreshFrameReadout: position.refreshFrameReadout, goToFrame, currentFrameIdx,
    peekNextRow: position.peekNextRow, updateVcTime, stepSec
  })
  const followPlaybackRef = useLatestRef(position.followPlayback)

  // 毎描画で最新に差し替える。useImperativeHandle の依存に props を並べると、足し忘れた
  // ものが黙って古いまま使われる（stepSec だけ並べていた頃の形）。
  const stepFrameRef = useRef(stepFrame)
  stepFrameRef.current = stepFrame
  const goToFrameRef = useRef(goToFrame)
  goToFrameRef.current = goToFrame
  const togglePlaybackRef = useRef<() => void>(() => {})

  useImperativeHandle(ref, () => ({
    togglePlay: () => togglePlaybackRef.current(),
    stepFrame: (dir: number) => stepFrameRef.current(dir),
    goToFrame: (idx: number) => goToFrameRef.current(idx),
    // muted を変えると onVolumeChange が state と lastMuted へ反映するので、
    // バーのミュートボタンと表示が食い違うことはない。
    toggleMute: () => { const v = videoRef.current; if (v) v.muted = !v.muted },
    adjustVolume: (delta: number) => {
      const v = videoRef.current
      if (!v) return
      // 消音中は消音を解き、消す前の音量から上げ下げする（0 から数えると 50% が 5% に落ちる）。
      v.muted = false
      v.volume = Math.max(0, Math.min(1, v.volume + delta))
    },
    element: () => videoRef.current,
  }), [])
  // 掴んで動かしている間の、まだ出していない行き先（handleSeekPointerDown の注記）。
  const pendingScrubRef = useRef<number | null>(null)
  // シークバーから指を離した。着いたら、そのコマが使っている絵へ寄せる（snapToFrameShown）。
  const snapAfterScrubRef = useRef(false)

  function drainScrubSeek(): void {
    const v = videoRef.current
    const next = pendingScrubRef.current
    if (!v || next === null) return
    pendingScrubRef.current = null
    v.currentTime = next
  }

  // シークバーで止めた位置を、番号のコマが使っている絵へ寄せる（理由は useFramePosition の snapToShownFrame）。
  function snapToFrameShown(): void {
    snapAfterScrubRef.current = false
    position.snapToShownFrame()
  }

  // シークが終わったとき。添字を引き直してから、待っている行き先があればそこへ進む。
  // **引き直しを先にする**——いま映ったコマの番号を出したいので、次の行き先を入れてしまうと
  // まだ映っていないコマの番号を出すことになる。
  function handleSeeked(): void {
    syncFrameIdx()
    drainScrubSeek()
    const v = videoRef.current
    if (snapAfterScrubRef.current && v && !v.seeking) snapToFrameShown()
  }

  const seekFillRef = useRef<HTMLDivElement>(null)
  const seekThumbRef = useRef<HTMLDivElement>(null)
  const vcTimeLabelRef = useRef<HTMLSpanElement>(null)
  const vcTimeRef = useRef(0)

  const [playing, setPlaying] = useState(false)
  // コントロールバーの出し入れ。シーク操作中（scrubbing）は必ず出したままにする:
  // つまみを掴んだまま映像の外へポインタが出ると mouseleave でバーが消え、掴んでいる
  // ものが視界から無くなってしまうため。
  const [hovered, setHovered] = useState(false)
  const [scrubbing, setScrubbing] = useState(false)
  // ポインタが直近 CONTROLS_IDLE_MS 以内に動いたか（ビューアでのみ使う）。
  const [pointerRecent, setPointerRecent] = useState(false)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (idleTimerRef.current) clearTimeout(idleTimerRef.current) }, [])

  function bumpPointer(): void {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    idleTimerRef.current = setTimeout(() => setPointerRecent(false), CONTROLS_IDLE_MS)
    setPointerRecent(true)
  }

  const [vcDuration, setVcDuration] = useState(0)
  const [vcVolume, setVcVolume] = useState(1)
  const [vcMuted, setVcMuted] = useState(false)
  const [vcLoop, setVcLoop] = useState(lastLoop)
  // コマ再生（自動でコマを送り続ける）が走っているか、と 1 コマの表示時間。
  const [framePlay, setFramePlay] = useState(false)
  // 再生の速さ。null は等速、数値はコマ再生で 1 コマを何秒見せるか。
  const [speed, setSpeed] = useState<PlaybackSpeed>(lastSpeed)
  // ループの現在値をコマ再生のループ（描画外で回る）から読むため ref にも持つ。
  const vcLoopRef = useRef(vcLoop)
  vcLoopRef.current = vcLoop

  // 再生中か（等速の再生でも、コマ再生でも）。**再生/停止ボタンは 1 つ**なので、
  // どちらで動いていても同じ「止める」に見える必要がある。
  const running = playing || framePlay

  // バーを出すかどうか。**ビューアと詳細パネルで勝手が違う。**
  //
  // 詳細パネルはサムネの隣で内容を確かめるだけの小さい枠で、バーは映像を隠す邪魔ものに
  // 近い。ホバーを外したら即座に引く（従来どおり）。
  //
  // ビューアは腰を据えて 1 本を見る場所で、バーはその作業の道具そのもの（速さを選ぶ・
  // 位置を置く）。**止まっている間は消さない**——コマを見定めている最中に道具が消えると、
  // 次の操作のたびにホバーからやり直しになる。再生中だけは映像の邪魔になるので、
  // ポインタが止まって CONTROLS_IDLE_MS 経ったら引く。
  const controlsVisible = scrubbing || (showRateLoop ? !running || pointerRecent : hovered)

  // 再生/停止。**どう再生するかは速さの選択が決め、ここは入り切りだけ**にする。
  // 再生ボタンをコマ再生と等速で分けていた頃は、バーに再生ボタンが 2 つ並び、
  // どちらを押すのかが画面から読めなかった。
  function togglePlayback(): void {
    const v = videoRef.current
    if (!v) return
    if (framePlay) { setFramePlay(false); return }
    if (!v.paused) { v.pause(); return }
    if (speed === null) {
      // 終端で止まっているところで押すのがいちばん普通の流れ（コマ再生側も同じ扱い）。
      // play() だけでもブラウザが先頭へ戻すが、それだとシークバーとコマ表示は
      // 戻ったことを知らないまま一瞬右端に残る。
      if (v.ended) { v.currentTime = 0; updateVcTime(0) }
      v.play()
      return
    }
    setFramePlay(true)
  }
  togglePlaybackRef.current = togglePlayback

  // 速さを選び直す。**再生中なら、選んだ速さのまま再生を続ける**（倍速メニューと同じ感覚）。
  function pickSpeed(next: PlaybackSpeed): void {
    lastSpeed = next
    setSpeed(next)
    const v = videoRef.current
    if (!running || !v) return
    if (next === null) { setFramePlay(false); v.play() }
    else { v.pause(); setFramePlay(true) }
  }

  // シークバーの右端に当たる時刻。**コマ表があるうちは最後のコマの時刻**にする。
  //
  // duration を右端にすると、最後のコマ（例：109/109）に居ても右端との間に 1 コマ分の
  // 隙間が残り、「コマは最後まで来ているのにバーは終わっていない」状態になる。
  // その隙間は最後のコマが映り続けている時間で、そこへ飛んでも絵は変わらない——
  // つまりバーの上で意味のある範囲は最初のコマから最後のコマまでしかない。
  // 表が無いとき（詳細パネル・解析失敗）だけ従来どおり duration を右端にする。
  //
  // 代償：右端を掴んだときの飛び先が duration ではなく最後のコマになる。見える絵は同じだが、
  // 時刻ラベル（本物の currentTime / duration を出す）とはコンマ以下がズレる。
  const seekEndRef = useRef(0)
  seekEndRef.current = frameEnd ?? vcDuration

  function seekRatio(t: number): number {
    const end = seekEndRef.current
    if (!(end > 0)) return 0
    return Math.max(0, Math.min(1, t / end))
  }

  // つまみは溝の内側（左端から 100% - つまみ幅 まで）を動く。フィルの右端はつまみの
  // 中心に合わせるので、同じだけ内側に詰めてから半径を足す。こうすると両端でも
  // つまみが溝からはみ出さず、右隣の時刻ラベルにも重ならない。
  const thumbLeft = (ratio: number): string => `calc(${ratio} * (100% - ${VC_SEEK_THUMB}px))`
  const fillWidth = (ratio: number): string => `calc(${ratio} * (100% - ${VC_SEEK_THUMB}px) + ${VC_SEEK_THUMB / 2}px)`

  function updateVcTime(t: number): void {
    vcTimeRef.current = t
    const ratio = seekRatio(t)
    if (seekFillRef.current) seekFillRef.current.style.width = fillWidth(ratio)
    if (seekThumbRef.current) seekThumbRef.current.style.left = thumbLeft(ratio)
    // 秒が変わったときだけ書く。毎フレーム textContent に代入すると、変化していなくても
    // ラベルの再レイアウトが走る（滑らかにするため下の効果で毎描画呼ぶようになった）。
    const label = `${fmtDur(t)} / ${fmtDur(vcDuration)}`
    if (vcTimeLabelRef.current && vcTimeLabelRef.current.textContent !== label) vcTimeLabelRef.current.textContent = label
  }

  useEffect(() => {
    setPlaying(false)
    vcTimeRef.current = 0
    setVcDuration(0)
    // 選んだ速さで開き直す。コマ再生を選んでいるなら、自動再生もコマ再生で始める
    // （等速で流れ始めると、選んだ速さが無視されたようにしか見えない。video 要素側の
    // autoPlay は下の JSX で等速のときだけ効かせている）。
    setFramePlay(Boolean(autoPlay) && speed !== null)
    // 直近の音量・ミュートを復元（onVolumeChange が state に反映する）。
    // ループは UI を出す側（ビューア）でのみ引き継ぐ。UI を出さない詳細パネルで
    // ループしたままになると、止める手段が画面に無い（下の JSX の loop 属性を参照）。
    const v = videoRef.current
    if (v) {
      v.volume = lastVolume
      v.muted = lastMuted
    }
    // 開いたとき（id が変わったとき）の速さ・自動再生で始めるだけ。速さを変えるたびに
    // ここが走ると、再生位置や音量の復元まで巻き戻る。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // 表示種別が変わったとき（読み込み完了・取得失敗）と言語切り替えで書き直す。
  // 中身は DOM を直接触っているので、React の再描画だけでは空のまま残る。
  //
  // playing も見る：再生中は書き換えを止めているので、止めた瞬間に最後のコマへ追いつかせる
  // 必要がある（これが無いと、再生して止めたときだけ古い番号が残る）。
  useEffect(() => { frameActionsRef.current.refreshFrameReadout() }, [readout, t, playing, frameActionsRef])

  useEffect(() => {
    if (pauseWhen) { videoRef.current?.pause(); setFramePlay(false) }
  }, [pauseWhen])

  // ウィンドウを閉じる（≒隠すだけでトレイに残る）・最小化すると renderer は
  // 動き続けるため、何もしないと動画が裏で再生され続ける。非表示化を検知して止める。
  // **コマ再生も止める**——タイマーで回っているので pause() では止まらず、裏で
  // 送り続けたまま戻ってくることになる。
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') { videoRef.current?.pause(); setFramePlay(false) }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // コマ再生（素材のコマを 1 つずつ、一定の時間だけ見せて自動で送る）。中身は useFramePlay。
  useFramePlay({
    videoRef, id, framePlay, setFramePlay, speed, loopRef: vcLoopRef, readoutRef, framesRef, overlayRef: frameOverlayRef, actionsRef: frameActionsRef
  })

  // 再生中のシークバーは**コマの届く間隔ではなく再生の時計に追従させる**。
  //
  // 以前は下の rVFC（コマが 1 枚描かれるたびに呼ばれる）で位置を書いていた。録画クリップの
  // ファイルのコマ数は画面キャプチャの供給レートの産物で、10〜20 コマ/秒まで落ちることが
  // ある。その回数しか動かないので、バーが目に見えてカタカタ進んでいた。
  // currentTime は描画のたびに連続して進むので、rAF で読めば画面の更新間隔で滑らかに動く。
  // **コマ番号の追従は滑らかさの問題ではない**ので、実フレームの時刻を持つ rVFC に残す。
  useEffect(() => {
    const v = videoRef.current
    if (!v || !playing) return
    let handle = 0
    const tick = (): void => {
      frameActionsRef.current.updateVcTime(v.currentTime)
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
    // updateVcTime は vcDuration を読むが、frameActionsRef から最新を呼ぶので張り直さなくてよい。
  }, [playing, frameActionsRef])

  // 再生中のコマ番号（実フレーム）の追従。timeupdate は仕様上 4Hz 程度でしか発火せず、
  // コマを追う用途では現在位置のズレがそのまま誤読につながるので、対応環境では
  // rVFC でフレームごとに引き直す（timeupdate のハンドラは非対応環境の受け皿として残す）。
  useEffect(() => {
    const v = videoRef.current
    if (!v || !playing) return
    // 止めた位置からそのままコマ送りを続けられるよう、添字だけ追い続ける（コマ表示は書き換えない。
    // 再生中は隠している。下の JSX を参照）。
    const stop = watchVideoFrames(v, (meta) => followPlaybackRef.current(meta.mediaTime))
    return stop ?? undefined
  }, [playing, followPlaybackRef])

  function handleSeekPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    const update = (clientX: number) => {
      const rect = el.getBoundingClientRect()
      // つまみの可動域（両端をつまみの半径だけ詰めた範囲）で割合を出す。溝の幅で割ると、
      // 端に近いほどつまみが指から半径ぶんずれていく。
      const span = Math.max(1, rect.width - VC_SEEK_THUMB)
      const pct = Math.max(0, Math.min(1, (clientX - rect.left - VC_SEEK_THUMB / 2) / span))
      const t = pct * (seekEndRef.current || 0)
      updateVcTime(t)
      // **掴んで動かしている間は、行き先を 1 つだけ持って追い越させる。**
      // 指を動かすたびにシークを出すと、1 回ごとに直前のキーフレームからデコードし直すため
      // 前のぶんが終わるまで絵が止まり、こまこま引っかかる。前のシークが終わるまでは
      // 最新の行き先を上書きして覚えておき、終わった時点でそこへ飛ぶ（drainScrubSeek）。
      // **捨てるのは途中の行き先だけで、指を離した位置には必ず着く。**
      pendingScrubRef.current = t
      if (!videoRef.current?.seeking) drainScrubSeek()
    }
    setScrubbing(true)
    setFramePlay(false)   // 掴んで動かした先から自動で送り始めると、置いた位置を確かめられない
    update(e.clientX)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent) => update(ev.clientX)
    // pointercancel でも必ず解除する。取りこぼすと scrubbing が立ちっぱなしになり、
    // バーがホバーしていなくても出たままになる。
    const onUp = () => {
      setScrubbing(false)
      // まだシーク中なら着いたとき（handleSeeked）に寄せる。もう着いていればここで寄せる。
      snapAfterScrubRef.current = true
      if (!videoRef.current?.seeking && pendingScrubRef.current === null) snapToFrameShown()
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
      onMouseEnter={() => { setHovered(true); bumpPointer() }}
      onMouseMove={bumpPointer}
      onMouseLeave={() => setHovered(false)}>
      {/* flex-basis: auto にする。高さ固定のビューアでは grow で枠を埋め、高さが中身依存の
          詳細パネルでは映像自身の高さ(16/9)を取る。flex:1(basis 0%)だと後者で潰れて小さくなる。 */}
      <div style={{ flex: '1 1 auto', minHeight: 0, width: '100%', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: clipMedia ? 'hidden' : undefined }}>
        <video
          ref={videoRef}
          key={id}
          src={mediaUrl(id)}
          poster={mediaUrl(id, 'thumb')}
          style={{ display: 'block', cursor: 'pointer', ...videoStyle }}
          preload="auto"
          autoPlay={autoPlay && speed === null}
          loop={showRateLoop ? vcLoop : false}
          onClick={(e) => {
            if (onVideoClick?.(e) === false) return
            e.stopPropagation()
            togglePlayback()
          }}
          // **流れ始めたらコマ送りの添字を捨てる。** 位置は seeked を出さずに進むので、
          // 持ったままだと止めたときにはもう別のコマに居る。以前はここが残っていたため、
          // 少し流してからコマ送りを押すと、最後に送った場所へ戻ってから 1 コマ動いていた
          // （コマ表示も、止めた瞬間に古い番号が出ていた）。
          onPlay={() => { setPlaying(true); setFramePlay(false); position.forgetPosition() }}
          onPause={() => setPlaying(false)}
          // シークバー操作など、コマ送り以外で位置が動いたときに添字を引き直す。
          onSeeked={handleSeeked}
          onLoadedData={syncFrameIdx}
          // 再生し終えたら**終端に残す**。以前はここで頭出しに戻していたため、
          // 最後まで見た瞬間にバーが左端へ飛び、コマ表示も 1 コマ目に戻っていた
          // （コマ再生で終わったときは最後のコマに留まるので、同じ「終わった」でも
          // 見え方が食い違っていた）。もう一度押したときの頭出しは togglePlayback が行う。
          onEnded={() => { setPlaying(false); updateVcTime(videoRef.current?.currentTime ?? seekEndRef.current) }}
          onTimeUpdate={() => updateVcTime(videoRef.current?.currentTime ?? 0)}
          onDurationChange={() => setVcDuration(videoRef.current?.duration ?? 0)}
          onVolumeChange={() => {
            const vol = videoRef.current?.volume ?? 1
            const muted = videoRef.current?.muted ?? false
            lastVolume = vol; lastMuted = muted
            setVcVolume(vol); setVcMuted(muted)
          }}
        />
        {/* コマ再生で先に作った絵を重ねる（useFramePlay）。クリックは下の映像へ通す。 */}
        <canvas
          ref={frameOverlayRef}
          style={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none', objectFit: 'contain' }}
        />
        {/* コマ表示は**止まっている間だけ**出す。
            コマ番号も「撮り逃し / 要注意」も 1 コマを見定めるための情報で、再生中は毎フレーム
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
            onClick={(e) => { e.stopPropagation(); setLegendOpen((v) => !v) }}
          />
        )}
        {/* この録画の状態（clipStatus）。**普段は出さず、コマ番号を押したときだけ開く。**
            常設すると映像の邪魔になる。押せば出る／押せば消える、の 1 か所に置く。 */}
        {readout !== 'off' && legendOpen && !playing && (
          <div
            style={frameLegendStyle}
            onClick={(e) => { e.stopPropagation(); setLegendOpen(false) }}>
            {clipStatus(framesRef.current, gapIndexRef.current, t, isPrecisionGuaranteed(clipFps)).map((line, i) => (
              line.label === null
                ? <span key={i} style={{ gridColumn: '1 / -1' }}>{line.text}</span>
                : (
                  <Fragment key={i}>
                    <span style={{ color: line.color, fontWeight: weight.medium, whiteSpace: 'nowrap' }}>{line.label}</span>
                    <span>{line.text}</span>
                  </Fragment>
                )
            ))}
          </div>
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
          <button style={vcBtnStyle} onClick={togglePlayback}>
            <PlayPauseIcon playing={running} />
          </button>
          <div style={vcSeekTrackStyle} onPointerDown={handleSeekPointerDown}>
            <div style={vcSeekBarStyle} />
            <div ref={seekFillRef} style={{ ...vcSeekFillStyle, width: fillWidth(seekRatio(vcTimeRef.current)) }} />
            <div ref={seekThumbRef} style={{ ...vcSeekThumbStyle, left: thumbLeft(seekRatio(vcTimeRef.current)) }} />
          </div>
          <span ref={vcTimeLabelRef} style={vcTimeLabelStyle}>{fmtDur(vcTimeRef.current)} / {fmtDur(vcDuration)}</span>
          {showRateLoop && <SpeedControl speed={speed} onPick={pickSpeed} />}
          {showRateLoop && <LoopButton loop={vcLoop} onToggle={() => { const next = !vcLoop; lastLoop = next; setVcLoop(next) }} />}
          <VolumeControl videoRef={videoRef} volume={vcVolume} muted={vcMuted} />
        </div>
      </div>
    </div>
  )
})

export default memo(VideoPlayer)
