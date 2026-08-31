import { useState, useEffect, useRef, useImperativeHandle, forwardRef, memo, Fragment } from 'react'
import { mediaUrl } from '../utils'
import { findFrameIdx, frameSeekTarget, isClipUnreliable, SEVERE_FRAME_RATIO } from '../frameTable'
import { getClipFramesResolver } from '../features/registry'
import { useT, type Translate, type MessageKey } from '../i18n'
import { font, radius, weight } from '../styles'
import { FRAME_QUALITY, type ClipFrames } from '../../../shared/api.video'
import type { ImageSource } from '../../../shared/types'
import {
  useVcStyles, vcBtnStyle, vcTimeLabelStyle, PlayPauseIcon, VolumeControl, SpeedControl, LoopButton, type PlaybackSpeed,
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

/**
 * コマ表示が今どの土台で動いているか。**コマ送りの結果をどう読んでよいかが変わる**ので、
 * 内部で分岐するだけでなく画面にも出す（docs/ANIME-FRAMES.md 3章「保証できないときは
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

// 再生中、ポインタが止まってからコントロールバーを引くまでの時間（ビューアのみ）。
// 短いと映像を見ている間に何度も出入りしてちらつき、長いと映像の下端が隠れ続ける。
const CONTROLS_IDLE_MS = 2500

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
  [FRAME_QUALITY.reused]: { label: 'viewer.frameNeedsReview', hint: 'viewer.frameReusedHint', color: FRAME_COLOR.warn },
  // misaligned はここに入れない。**箇所を指さずクリップ全体を赤で通す**（updateFrameReadout）。
  [FRAME_QUALITY.misaligned]: null,
}

// コマ表示の置き場所。コントロールバー（ホバー時だけ出る）の上に重ねる。
// **バーの中に入れないのは、バーがホバー中しか出ないため** —— キーボードでコマ送りして
// いる間はポインタが映像の上に無いことが多く、肝心の番号が見えない。
// 注記の意味の一覧（コマ番号を押すと開く）。コマ表示のすぐ上に、同じ調子で重ねる。
const frameLegendStyle: React.CSSProperties = {
  position: 'absolute', left: 10, bottom: VC_OVERLAY_HEIGHT + 30, zIndex: 4,
  pointerEvents: 'auto', cursor: 'pointer',
  // 2 列の格子。**説明文の左端を揃える**ため（横並びだと語の長さで開始位置がずれる）。
  display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 6, alignItems: 'baseline',
  padding: '10px 13px', borderRadius: radius.md, background: 'rgba(6,8,12,0.86)',
  fontSize: font.xs, lineHeight: 1.5, color: 'rgba(255,255,255,0.92)',
  maxWidth: 'min(420px, calc(100% - 20px))',
  textShadow: '0 1px 3px rgba(0,0,0,0.9)',
}

const frameReadoutStyle: React.CSSProperties = {
  position: 'absolute', left: 10, bottom: VC_OVERLAY_HEIGHT + 2, zIndex: 3,
  pointerEvents: 'auto', cursor: 'help',
  padding: '2px 7px', borderRadius: radius.md, background: 'rgba(6,8,12,0.72)',
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
  // コマ再生・ループをコントロールバーに出す。腰を据えて 1 本を見るビューア専用で、
  // 詳細パネル（サムネの隣で内容を確かめるだけの小さい枠）には出さない。
  // 狭いバーにボタンが増えるほど、そこでの用途である「どのクリップか確認する」が
  // やりにくくなるため。既定は出さない側に倒す。
  showRateLoop?: boolean
  /** コマ表の取得が終わったら 1 度だけ知らせる（null は表が無い＝コマ単位で数えられない）。 */
  onFramesReady?: (frames: ClipFrames | null) => void
  /** 現在コマが変わったら知らせる。**再生中は呼ばない**——コマ表示と同じ理由で、
   *  毎フレーム変わる値を出しても読めないうえ、受け手（タイムシート）が高速に再描画される。
   *
   *  gap は「その行の後ろ何コマ目の抜けに居るか」（0 = 表にある行そのもの）。
   *  **抜けには表の行が無いので、idx だけでは区別できない**——受け手はここが 0 かどうかで
   *  打てる場所かを決める。 */
  onFrameIndex?: (idx: number, gap: number) => void
}

const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer({ id, wrapperStyle, videoStyle, autoPlay, pauseWhen, onVideoClick, fps, showRateLoop, preloadFrameTable, clipSource, onFramesReady, onFrameIndex }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const stepSec = 1 / Math.max(1, fps || 24)
  // このクリップのコマ情報。取得できるまで（および動画機能を落とした構成）は null のまま。
  const framesRef = useRef<ClipFrames | null>(null)
  // 抜けは枚数だけでなく「その枚数に裏が取れているか」も持つ。**枚数が 1 違うと、そこから
  // 下のコマ番号が全部ずれる**ので、推定を確定と同じ顔で出さない（ClipGap.measured）。
  const gapsRef = useRef<Map<number, { missing: number; measured: boolean }>>(new Map())
  // このクリップのコマ送りが、どこを見ても当てにならないか。
  //
  // **抜けが 1 つでもあれば赤、にはしない。** 実測（手元 82 本・2026-08-26）では抜けのある
  // 録画 33 本の中身が両極端で、「1500 コマに 194 か所」の穴だらけと「899 コマに 1 コマ」が
  // 同居していた。後者を全体不可にすると、無傷な 898 か所の境目まで捨てることになる
  // （docs/ANIME-FRAMES.md 0 章）。欠落コマの割合で並べると 5.4% と 4.1% の間で分布が
  // 切れていたので、そこを境にする。大きい方 24 本は全体を赤、小さい方 9 本は場所を指す。
  const unreliableRef = useRef(false)
  // 未取得が多いクリップか。**コマ単位ではなくクリップ単位で決める**——1 コマずつ見ても
  // 「多いのか少ないのか」は分からず、詳細パネルは割合で赤くしている。同じ割合をここでも使う。
  const uncapturedSevereRef = useRef(false)
  // コマ送りの現在位置は「時刻」ではなく PTS 表の添字で持つ。
  //
  // 時刻で持って毎回シーク結果を実測し直すと、連打したときに前のシークの実測（非同期で
  // 返る）が後から古い位置を書き戻し、複数のコールバックが順不同で効くため、送り先が
  // 前後に飛んでコマ順が崩れる。添字を自分で ±1 していけば何回連打しても単調に動く。
  // null = まだ確定していない（外部の再生位置から引き直す）。
  const frameIdxRef = useRef<number | null>(null)
  // 表の行 i より前に、抜けが何コマあるか（積み上げ）。**画面に出すコマ番号はこれを足す。**
  //
  // 表の行をそのまま 1・2・3… と数えると、抜けたぶんだけ番号が詰まり、**番号 ÷ fps が
  // 秒にならない**。タイムシートも書き出し（buildToeiClipboard）も元から抜けを数えた
  // 番号で並んでいるので、ビューアだけが別の数を出していた——同じコマがビューアで 324、
  // タイムシートで 327 になる（2026-08-31 の指摘）。
  const gapBeforeRef = useRef<number[]>([])
  // 抜けを含めたコマの総数（＝元の動画のコマ数）。番号の母数。
  const totalWithGapsRef = useRef(0)
  // 抜けの中に居るとき、その行の後ろ何コマ目か（0 = 表にある行そのもの）。
  //
  // **添字を増やす形にはしない。** この添字はタイムシートが打鍵の保存に使っているものと
  // 同じで（timesheet.ts の expandMarks）、抜けのぶんを詰めて番号を振り直すと、既に打って
  // あるものが別のコマを指す。「実測行の添字＋その後ろの何番目か」で持てば、表の行の
  // 番号は 1 つも動かない。
  const gapOffsetRef = useRef(0)
  // 自分のコマ送りによるシークかどうか。自分で動かした直後に外部同期（onSeeked）が
  // 添字を引き直すと、上と同じ書き戻しが起きるため 1 回だけ読み飛ばす。
  const selfSeekRef = useRef(false)
  // 最後にタイムシートへ知らせた位置（同じ位置を二度知らせないため）。抜けの中を動いても
  // 番号は変わらないので、`添字:抜けの何コマ目` で持つ。
  const lastNotifiedFrameRef = useRef<string | null>(null)
  // コマ表の取得が終わるまでに押されたコマ送りの正味の量（MAX_PENDING_STEPS で頭打ち）。
  const pendingStepsRef = useRef(0)

  const { t } = useT()
  // コマ表示はフレームごとに書き換わるので、React の再描画ではなく DOM を直接触る
  // （時刻ラベルが updateVcTime で同じことをしているのと同じ理由。再生中は毎フレーム来る）。
  const frameLabelRef = useRef<HTMLSpanElement>(null)
  const [legendOpen, setLegendOpen] = useState(false)
  const [readout, setReadout] = useState<ReadoutKind>('off')
  // 描画外（コマ送り・rVFC）から読むため ref にも持つ。state だけだと useImperativeHandle が
  // 掴んだ古いクロージャが古い値を見る。
  const readoutRef = useRef<ReadoutKind>('off')
  const tRef = useRef<Translate['t']>(t)
  tRef.current = t
  // 描画外（コマ送り・表の取得完了）から呼ぶので ref 経由にする。props を直に掴むと、
  // effect が作られた時点の古い関数が呼ばれる（readoutRef と同じ理由）。
  const onFramesReadyRef = useRef(onFramesReady)
  onFramesReadyRef.current = onFramesReady
  const onFrameIndexRef = useRef(onFrameIndex)
  onFrameIndexRef.current = onFrameIndex

  function setReadoutKind(kind: ReadoutKind): void {
    readoutRef.current = kind
    setReadout(kind)
  }

  useEffect(() => {
    framesRef.current = null
    frameIdxRef.current = null
    gapBeforeRef.current = []
    totalWithGapsRef.current = 0
    gapOffsetRef.current = 0
    lastNotifiedFrameRef.current = null
    selfSeekRef.current = false
    pendingStepsRef.current = 0
    setFrameEnd(null)
    if (!preloadFrameTable) { setReadoutKind('off'); return }
    const resolve = getClipFramesResolver()
    // 解決役が未登録（video 機能ごと落とした構成）。コマの位置は分からないので fps 換算になる。
    if (!resolve) { setReadoutKind('estimated'); return }
    setReadoutKind('loading')
    let canceled = false
    // 取得の成否どちらでも、保留していたコマ送りをそこで解放する。
    // **保留したまま握り潰すと「押したのに動かない」で終わる**ため、失敗しても必ず動かす。
    const settle = (frames: ClipFrames | null): void => {
      if (canceled) return
      framesRef.current = frames
      // 「このコマの次に何コマ抜けているか」を添字で引けるようにしておく（コマ送りのたびに
      // 配列を走査すると、押しっぱなしのときに効いてくる）。
      gapsRef.current = new Map((frames?.gaps ?? []).map((g) => [g.afterIndex, { missing: g.missing, measured: g.measured }]))
      // 番号を出すたびに前から数え直すと、押しっぱなしのときに効いてくる。一度で積む。
      const ptsLen = frames?.pts.length ?? 0
      const before = new Array<number>(ptsLen)
      let acc = 0
      for (let i = 0; i < ptsLen; i++) { before[i] = acc; acc += gapsRef.current.get(i)?.missing ?? 0 }
      gapBeforeRef.current = before
      totalWithGapsRef.current = ptsLen + acc
      // 判定は frameTable の isClipUnreliable が持つ（トリマーも同じものを読む）。
      const rows = frames?.pts.length ?? 0
      unreliableRef.current = isClipUnreliable(frames)
      const uncaptured = (frames?.quality ?? []).filter((q) => q === FRAME_QUALITY.reused).length
      uncapturedSevereRef.current = rows > 0 && uncaptured / rows > SEVERE_FRAME_RATIO
      setFrameEnd(frames && frames.pts.length > 0 ? frames.pts[frames.pts.length - 1] : null)
      setReadoutKind(!frames || frames.pts.length === 0 ? 'estimated' : frames.sourceBased ? 'source' : 'file')
      onFramesReadyRef.current?.(frames && frames.pts.length > 0 ? frames : null)
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

  // このコマの次に何コマ抜けているか（無ければ 0）。
  function missingAfter(idx: number): number {
    return gapsRef.current.get(idx)?.missing ?? 0
  }

  // **いま居るコマの添字を答える唯一の口。** 送っている最中なら持っている添字、
  // そうでなければ実際の再生位置から引く。
  //
  // 分けて書くと片方だけ直す食い違いが出る（以前は 4 か所に散らばり、コマ再生の 2 か所だけ
  // 「分からなければ 0 コマ目」になっていた——再生し終えた位置から押しても先頭に居ることに
  // されるので、端の判定が 1 周ぶん遅れていた）。
  function currentFrameIdx(): number {
    if (frameIdxRef.current !== null) return frameIdxRef.current
    const v = videoRef.current
    const pts = framesRef.current?.pts
    if (!v || !pts || pts.length === 0) return 0
    return findFrameIdx(pts, v.currentTime)
  }

  // シークバー操作・読み込み直後など、コマ送り以外の理由で位置が動いたときに
  // 添字を実際の再生位置から引き直す。
  function syncFrameIdx(): void {
    if (selfSeekRef.current) { selfSeekRef.current = false; return }
    const v = videoRef.current
    const pts = framesRef.current?.pts
    if (!v || !pts || pts.length === 0) return
    const idx = findFrameIdx(pts, v.currentTime)
    // **流れている間の添字は残さない。** 着いた先からすぐ動き出すので、残せばその瞬間に
    // 古くなる。null にしておけば、次に押したときの位置から引き直される（onPlay と同じ理由）。
    frameIdxRef.current = v.paused ? idx : null
    // 外から動かされたら抜けの中には居ない。**時刻からは抜けの何コマ目かを引けない**
    // ——抜けたコマは表にも録画にも位置を持たないので、実測行へ戻す。
    gapOffsetRef.current = 0
    updateFrameReadout(idx, 0)
  }

  // 現在の再生位置からコマ表示を引き直す（添字がまだ確定していない場合も含む）。
  function refreshFrameReadout(): void {
    updateFrameReadout(currentFrameIdx(), gapOffsetRef.current)
  }

  // コマ表示を書き換える。
  //
  // **番号だけでは足りない。** コマ送りで絵が変わらないこと自体が測定結果（コマ打ち）なので、
  // 変わらなかった理由が「素材がその絵を保持していた」のか「こちらが撮り逃して直前の絵を
  // 流用している」のかを、その場で区別できる必要がある。詳細パネルの合計枚数だけでは
  // 「どこかに N コマ嘘がある」としか言えない。
  function updateFrameReadout(idx: number, gap = 0): void {
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
    // **番号が変わったときだけ知らせる。** 受け取る側（タイムシート）は state を書くので、
    // 毎回呼ぶと同じ番号でも画面全体の描き直しが走る。掴んで動かしている間やコマ再生中は
    // これが 1 秒に何度も乗り、シークの待ちに上積みされていた。
    const posKey = `${cur}:${gap}`
    if (posKey !== lastNotifiedFrameRef.current) {
      lastNotifiedFrameRef.current = posKey
      onFrameIndexRef.current?.(cur, gap)
    }
    // 番号は 1 始まり。0 始まりだと先頭が「0 / 719」になり、何コマ目かを数える用途では
    // 毎回読み替えが要る。
    //
    // **数えるのは元の動画のコマで、表の行ではない。** 抜けたコマも 1 コマとして数える
    // ので、番号 ÷ fps がそのまま秒になり、タイムシート・書き出しの番号とも一致する。
    // トリマーの f{N} は**別の数え方のまま**——あちらが指しているのは録画ファイルを
    // どこで切るかで、抜けたコマはそもそも切る対象に無い。
    const srcNo = cur + (gapBeforeRef.current[cur] ?? 0) + gap + 1
    const srcTotal = totalWithGapsRef.current || total
    const params = { cur: String(srcNo), total: String(srcTotal) }

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

    // このコマの次に抜けている枚数（小さい抜けのときだけ使う）。
    const gapNext = gapsRef.current.get(cur)

    // 抜けの中に居る。**番号は続けて出す**——ここも元の動画の 1 コマなので、飛ばすと
    // 番号が詰まる。他のコマと違うのは「絵が無い」ことなので、それを注記で言う。
    if (gap > 0) {
      const hint = { cur: String(cur + (gapBeforeRef.current[cur] ?? 0) + 1), count: String(gapNext?.missing ?? gap) }
      el.textContent = `${tr('viewer.frameIndex', params)} · ${tr(gapNext?.measured ? 'viewer.frameInGap' : 'viewer.frameInGapEstimated')}`
      el.title = tr(gapNext?.measured ? 'viewer.frameInGapHint' : 'viewer.frameInGapEstimatedHint', hint)
      el.style.color = FRAME_COLOR.warn
      return
    }

    const note = FRAME_NOTE[frames.quality[cur] ?? FRAME_QUALITY.captured]
    const missingNext = gapNext?.missing ?? 0
    // 枚数に裏が取れていない抜けは、そう分かる言い方で出す。**推定が 1 枚違うと、そこから
    // 下のコマ番号が全部ずれる**——確定と同じ文言だと、その危うさが画面から消える。
    const gapKey = <T extends string>(measured: T, estimated: T): T => gapNext?.measured ? measured : estimated
    // 注記は 3 段（詳細パネルの注記と同じ切り方）。
    //
    //   赤「要注意」   … ずれがある、または穴だらけ。どこを見ても数えられないので全体に出す。
    //                    **押さないと出ない場所ではなく番号の横**に置く（いちばん重いので）。
    //   黄「この先 N コマ抜け」… 抜けが少ないクリップ。壊れているのは**その穴をまたぐ境目
    //                    だけ**で、残りの境目は無傷。だから全体を赤くせず、その場所で出す。
    //   黄「未取得」   … 絵が無いコマ。コマ数は数えられる。従来どおりコマ単位。
    //
    // 重なったら重い方を採る。**並べない**——要注意が出ている時点で他を足しても判断は変わらず、
    // 抜けの手前では「またげない」ことが未取得より先に知りたい。
    const label = unreliableRef.current
      ? tr('viewer.frameUnreliable')
      : missingNext > 0
        ? tr(gapKey('viewer.frameGapAfter', 'viewer.frameGapAfterEstimated'), { count: String(missingNext) })
        : note ? tr(note.label) : null
    el.textContent = label
      ? `${tr('viewer.frameIndex', params)} · ${label}`
      : tr('viewer.frameIndex', params)
    el.title = unreliableRef.current
      ? tr('viewer.frameUnreliableHint')
      : missingNext > 0
        ? tr(gapKey('viewer.frameGapAfterHint', 'viewer.frameGapAfterEstimatedHint'), { count: String(missingNext) })
        : tr(note ? note.hint : 'viewer.frameSourceHint')
    // 未取得は、そのクリップで多いときだけ赤へ上げる（詳細パネルと同じ 5%）。
    el.style.color = unreliableRef.current
      ? FRAME_COLOR.alert
      : missingNext > 0
        ? FRAME_COLOR.warn
        : note ? (uncapturedSevereRef.current ? FRAME_COLOR.alert : note.color) : FRAME_COLOR.ok
  }

  // 抜けを 1 コマとして数えながら delta コマ歩く。
  //
  // **添字の ±1 では足りない。** 表の行と行の間に、行を持たないコマが挟まっている
  // （抜け）。ここを飛ばすと、拡張のコマ送り（1 手＝素材 1 コマ）と同じ操作が同じ意味に
  // ならない。1 スロットずつ進めるのは delta が小さいから（連打の保留は MAX_PENDING_STEPS
  // で頭打ち、コマ再生は毎回 1）。
  function walkFrames(idx: number, gap: number, delta: number, total: number): { idx: number; gap: number } {
    let i = idx
    let g = gap
    for (let k = 0; k < Math.abs(delta); k++) {
      if (delta > 0) {
        if (g < missingAfter(i)) { g++; continue }
        if (i >= total - 1) { g = 0; break }
        i++
        g = 0
      } else {
        if (g > 0) { g--; continue }
        if (i <= 0) break
        i--
        g = missingAfter(i)
      }
    }
    return { idx: i, gap: g }
  }

  // delta コマ動かす（正で先へ、負で前へ）。
  // コマ表があるときは隣のコマへ直接移る。表がないとき（解決役が未登録・解析失敗）だけ従来の
  // fps 換算に落ちる。その場合は境界を必ず跨ぐよう半コマ余分に送る（進む側 +1.5 / 戻る側 -0.5）。
  function moveFrames(delta: number): void {
    const v = videoRef.current
    if (!v || delta === 0) return
    v.pause()
    const limit = isFinite(v.duration) ? v.duration : Number.MAX_SAFE_INTEGER
    const pts = framesRef.current?.pts ?? []
    if (pts.length > 0) {
      const cur = currentFrameIdx()
      const curGap = gapOffsetRef.current
      const { idx: next, gap: nextGap } = walkFrames(cur, curGap, delta, pts.length)
      frameIdxRef.current = next
      gapOffsetRef.current = nextGap
      // 端でも表示だけは更新する。「719 / 719」で止まっていれば、壊れているのではなく
      // 端まで来たのだと分かる（以前は無反応で、どちらか区別できなかった）。
      updateFrameReadout(next, nextGap)
      if (next === cur) return
      selfSeekRef.current = true
      // **抜けの中でも、シーク先は手前の実測行のまま。** 抜けたコマの絵はどこにも無い
      // （録画ファイルの該当時刻の絵を出すのは、コマ打ちを絵から決めることになるので禁止
      // ——docs/FRAME-GAPS.md 6-2）。手前のコマに固定しておけば、前から入っても後ろから
      // 戻っても同じ絵になる。何が出ているかはコマ表示が言う。
      v.currentTime = Math.max(0, Math.min(frameSeekTarget(pts, next, stepSec, framesRef.current?.dur), limit))
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
    // 手で送ったらコマ再生は止める。自動送りと手送りが混ざると、どちらの結果として
    // 今のコマに居るのかが分からなくなる。
    setFramePlay(false)
    if (readoutRef.current === 'loading') {
      v.pause()   // 保留中でも再生は止める（押した意図は「ここで止めて見る」なので）
      pendingStepsRef.current = Math.max(-MAX_PENDING_STEPS, Math.min(pendingStepsRef.current + dir, MAX_PENDING_STEPS))
      return
    }
    moveFrames(dir)
  }

  // 指定コマへ直接移る。**移動そのものは moveFrames に任せる**——端の丸め・自分のシークの
  // 目印・表示の更新が 1 か所にあるからで、ここで currentTime を直に触ると同じ処理が 2 系統になる。
  function goToFrame(idx: number): void {
    const v = videoRef.current
    const pts = framesRef.current?.pts ?? []
    if (!v || pts.length === 0) return
    // **差分で渡さない。** 抜けが挟まっていると添字の引き算は歩数と一致しない
    // （walkFrames）。行を指して飛ぶ操作なので、位置を直に置く。
    const next = Math.max(0, Math.min(idx, pts.length - 1))
    const moved = next !== currentFrameIdx() || gapOffsetRef.current !== 0
    frameIdxRef.current = next
    gapOffsetRef.current = 0
    updateFrameReadout(next, 0)
    if (!moved) return
    v.pause()
    selfSeekRef.current = true
    const limit = isFinite(v.duration) ? v.duration : Number.MAX_SAFE_INTEGER
    v.currentTime = Math.max(0, Math.min(frameSeekTarget(pts, next, stepSec, framesRef.current?.dur), limit))
  }

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
    element: () => videoRef.current,
  }), [])
  // 掴んで動かしている間の、まだ出していない行き先（handleSeekPointerDown の注記）。
  const pendingScrubRef = useRef<number | null>(null)

  function drainScrubSeek(): void {
    const v = videoRef.current
    const next = pendingScrubRef.current
    if (!v || next === null) return
    pendingScrubRef.current = null
    v.currentTime = next
  }

  // シークが終わったとき。添字を引き直してから、待っている行き先があればそこへ進む。
  // **引き直しを先にする**——いま映ったコマの番号を出したいので、次の行き先を入れてしまうと
  // まだ映っていないコマの番号を出すことになる。
  function handleSeeked(): void {
    syncFrameIdx()
    drainScrubSeek()
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
  // 最後のコマの時刻（コマ表が取れているときだけ）。シークバーの右端に使う。
  const [frameEnd, setFrameEnd] = useState<number | null>(null)
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
  }, [id])

  // 表示種別が変わったとき（読み込み完了・取得失敗）と言語切り替えで書き直す。
  // 中身は DOM を直接触っているので、React の再描画だけでは空のまま残る。
  //
  // playing も見る：再生中は書き換えを止めているので、止めた瞬間に最後のコマへ追いつかせる
  // 必要がある（これが無いと、再生して止めたときだけ古い番号が残る）。
  useEffect(() => { refreshFrameReadout() }, [readout, t, playing])

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

  // コマ再生。**素材のコマを 1 つずつ、一定の時間だけ見せて自動で送る。**
  //
  // 倍率を下げた再生（playbackRate）との違いは、送るのがファイルのフレームではなく
  // 素材の実コマだということ。録画クリップのファイルのフレームは画面キャプチャの供給レートの
  // 産物なので、遅くして眺めてもそこで数えたコマ数は素材のコマ数ではない。
  //
  // 素材のコマは等間隔に並ぶので、これは**時間軸を一様に伸ばした減速**であり、コマ打ちの
  // 溜め（3 コマ続く絵は 3 倍の時間そこに留まる）はそのまま残る。
  // 映像要素は止めたまま動かすので、コマ番号と「流用 / 要確認」も出たままになる。
  useEffect(() => {
    if (!framePlay || speed === null) return
    const holdSec = speed
    const v = videoRef.current
    if (!v) return
    v.pause()
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null

    // シークの完了を待ってから次のコマを数える。**間隔で撃ちっぱなしにしない**——
    // 1 コマごとにシークが走るため、速い設定ではシークの方が長引くことがある。撃ちっぱなしだと
    // 遅れが溜まってコマが飛ぶ。待てば実効速度が落ちるだけで、送る順番は 1 コマも欠けない。
    // seeked が来ない場合に止まらないよう保険の上限を置く。
    const afterSeek = (done: () => void): void => {
      let fired = false
      const fire = (): void => {
        if (fired) return
        fired = true
        v.removeEventListener('seeked', fire)
        clearTimeout(guard)
        done()
      }
      const guard = setTimeout(fire, 1000)
      v.addEventListener('seeked', fire)
    }

    const advance = (): void => {
      if (!alive) return
      // 表の読み込み中は動かさずに待つ。手のコマ送りが保留するのと同じ理由で、
      // ここで推定の刻みへ落とすと最初の数コマだけ素材のコマと無関係な位置へ飛ぶ。
      if (readoutRef.current === 'loading') { timer = setTimeout(advance, 100); return }
      const pts = framesRef.current?.pts ?? []
      const cur = currentFrameIdx()
      // 端に着いたら、ループが入っていれば先頭へ戻し、そうでなければ止める。
      // **止まったことは画面に出る**（ボタンの色が戻り、コマ表示は最後の番号のまま残る）。
      if (pts.length > 0 && cur >= pts.length - 1) {
        if (!vcLoopRef.current) { setFramePlay(false); return }
        goToFrame(0)
      } else if (pts.length === 0 && isFinite(v.duration) && v.currentTime >= v.duration - stepSec) {
        if (!vcLoopRef.current) { setFramePlay(false); return }
        v.currentTime = 0
      } else {
        moveFrames(1)
      }
      const started = performance.now()
      afterSeek(() => {
        if (!alive) return
        timer = setTimeout(advance, Math.max(0, holdSec * 1000 - (performance.now() - started)))
      })
    }

    // 端に着いた状態で押したら先頭へ戻してから始める。**再生し終えた直後に押すのが
    // いちばん普通の流れ**で、そこで何も起きないとボタンが壊れているようにしか見えない。
    const pts = framesRef.current?.pts ?? []
    const cur = currentFrameIdx()
    const atEnd = pts.length > 0
      ? cur >= pts.length - 1
      : isFinite(v.duration) && v.currentTime >= v.duration - stepSec
    if (atEnd) {
      if (pts.length > 0) goToFrame(0)
      else v.currentTime = 0
      timer = setTimeout(advance, holdSec * 1000)
    } else {
      // 押したらすぐ 1 コマ動く。**待たせない**——最初の 1 コマを待たせると、
      // 遅い設定（1 コマ 1 秒）では押しても動かないのと区別が付かない。
      advance()
    }
    return () => { alive = false; if (timer) clearTimeout(timer) }
    // moveFrames / goToFrame は ref しか読まないので、依存に並べる必要はない。
  }, [framePlay, speed, id])

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
      updateVcTime(v.currentTime)
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
    // vcDuration は updateVcTime が割合と時刻ラベルに使うため、確定したら張り直す。
  }, [playing, vcDuration])

  // 再生中のコマ番号（実フレーム）の追従。timeupdate は仕様上 4Hz 程度でしか発火せず、
  // コマを追う用途では現在位置のズレがそのまま誤読につながるので、対応環境では
  // rVFC でフレームごとに引き直す（timeupdate のハンドラは非対応環境の受け皿として残す）。
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
      if (pts && pts.length > 0) { frameIdxRef.current = findFrameIdx(pts, meta.mediaTime); gapOffsetRef.current = 0 }
      handle = rv.requestVideoFrameCallback!(tick)
    }
    handle = rv.requestVideoFrameCallback(tick)
    return () => { alive = false; rv.cancelVideoFrameCallback?.(handle) }
  }, [playing])

  useVcStyles()

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
      <div style={{ flex: '1 1 auto', minHeight: 0, width: '100%', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <video
          ref={videoRef}
          key={id}
          src={mediaUrl(id)}
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
          onPlay={() => { setPlaying(true); setFramePlay(false); frameIdxRef.current = null; gapOffsetRef.current = 0 }}
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
            onClick={(e) => { e.stopPropagation(); setLegendOpen((v) => !v) }}
          />
        )}
        {/* 注記の意味の一覧。**普段は出さず、コマ番号を押したときだけ開く。**
            常設すると映像の邪魔になり、マウスを載せたときだけの説明では気づけない。
            押せば出る／押せば消える、の 1 か所に置く。 */}
        {readout !== 'off' && legendOpen && !playing && (
          <div
            style={frameLegendStyle}
            onClick={(e) => { e.stopPropagation(); setLegendOpen(false) }}>
            {([
              ['viewer.legendUnreliable', FRAME_COLOR.alert],
              ['viewer.legendGap', FRAME_COLOR.warn],
              ['viewer.legendMissing', FRAME_COLOR.warn],
            ] as const).map(([key, color]) => (
              <Fragment key={key}>
                <span style={{ color, fontWeight: weight.medium, whiteSpace: 'nowrap' }}>{t(`${key}.label` as MessageKey)}</span>
                <span style={{ opacity: 0.85 }}>{t(`${key}.desc` as MessageKey)}</span>
              </Fragment>
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
