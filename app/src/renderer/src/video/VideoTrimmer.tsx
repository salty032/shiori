import { useState, useRef, useEffect } from 'react'
import type { ImageRow } from '../types'
import { trimmerStyles as s } from './trimmerStyles'
import { isEditingTarget, mediaUrl } from '../utils'
import { FRAME_EPS, addPendingStep, findFrameIdx, frameSeekTarget } from './frameTable'
import ConfirmDialog from '../components/ConfirmDialog'
import { XIcon } from '../components/Icon'
import { vcBtnStyle, vcTimeLabelStyle, PlayPauseIcon, VolumeControl, vcBarStyle, MuteIcon } from './videoControls'
import type { TrimErrorCode, TrimProgress } from '../../../shared/api.video'
import { useT, type MessageKey } from '../i18n'
import { useLatestRef } from '../hooks/useLatestRef'
import { onNextVideoFrame, supportsVideoFrameCallback, watchVideoFrames } from './videoFrameCallback'
import { MIN_TRIM_SECONDS } from '../../../shared/constants'

type Props = {
  image: ImageRow
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

// main が返す符丁を画面の言葉にする。**ここに無いものはそのまま出す**——ffmpeg の
// 生のメッセージが入るので、潰すと失敗の手掛かりが画面から消える。
const TRIM_ERROR_KEY: Record<TrimErrorCode, MessageKey> = {
  invalid_id: 'trim.errNotFound',
  not_found: 'trim.errNotFound',
  invalid_in: 'trim.errRange',
  invalid_out: 'trim.errRange',
  already_trimming: 'trim.errBusy',
  path_error: 'trim.errPath',
}

// 符丁なら文言に、そうでなければ（ffmpeg の生のメッセージ）そのまま。
function trimErrorText(error: string, t: (key: MessageKey) => string): string {
  const key = (TRIM_ERROR_KEY as Partial<Record<string, MessageKey>>)[error]
  return key ? t(key) : error
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

export default function VideoTrimmer({ image, onClose, onTrimmed }: Props) {
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
  // コマ表の取得が終わるまでに押されたコマ送りの正味の量（ビューアの pendingSteps と同じ）。
  const pendingStepsRef = useRef(0)
  const dragInSecRef = useRef(0)
  const dragOutSecRef = useRef(0)
  const inDimRef = useRef<HTMLDivElement>(null)
  const outDimRef = useRef<HTMLDivElement>(null)
  const inHandleRef = useRef<HTMLDivElement>(null)
  const outHandleRef = useRef<HTMLDivElement>(null)
  const inTimeRef = useRef<HTMLSpanElement>(null)
  const outTimeRef = useRef<HTMLSpanElement>(null)
  const selRangeRef = useRef<HTMLSpanElement>(null)
  const selBorderRef = useRef<HTMLDivElement>(null)
  const inTabRef = useRef<HTMLDivElement>(null)
  const outTabRef = useRef<HTMLDivElement>(null)

  const [dur, setDur] = useState(() => safeDur(image.duration))
  const [inSec, setInSec] = useState(0)
  const [outSec, setOutSec] = useState(() => safeDur(image.duration))
  const [trimming, setTrimming] = useState(false)
  // 保存するクリップに音声を入れるか。通話の声などが入った録画から音だけ外すため。
  const [removeAudio, setRemoveAudio] = useState(false)
  // トリミングの進み具合。null は走っていない状態。
  const [trimProgress, setTrimProgress] = useState<TrimProgress | null>(null)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [framePts, setFramePts] = useState<number[]>([])
  // 1 コマずつの長さ（録画ファイル側の実測）。**シーク先を出すためだけに持つ。**
  // pts だけで中央を狙うと、抜けをまたぐ場所で別の絵に着く（frameSeekTarget を参照）。
  const [frameDurs, setFrameDurs] = useState<number[] | undefined>(undefined)
  const [ptsLoading, setPtsLoading] = useState(true)
  const [ptsError, setPtsError] = useState(false)
  const [stripUrl, setStripUrl] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [vcVolume, setVcVolume] = useState(1)
  const [vcMuted, setVcMuted] = useState(false)

  // フレームテーブルが使えるか
  const hasTable = framePts.length > 0
  // IN/OUT が表の何行目か。**時刻だけでは決まらない**——撮り逃したコマは直前のコマと
  // 同じ時刻で並ぶ（ipc-video.ts の buildClipFrames）ので、時刻から引くと必ずその並びの
  // 最後の行になり、−1f が撮り逃しの所で止まって戻れなかった。
  const [inRow, setInRow] = useState(-1)
  const [outRow, setOutRow] = useState(-1)
  const playRowRef = useRef(-1)  // 再生位置の行（同じ理由）
  // 覚えている行が今の時刻と食い違っていれば（ドラッグ・クリック等で時刻だけ動いた）時刻から引く。
  function rowAt(row: number, sec: number): number {
    if (row >= 0 && row < framePts.length && Math.abs(framePts[row] - sec) <= FRAME_EPS) return row
    return findFrameIdx(framePts, sec)
  }
  const inIdx = hasTable ? rowAt(inRow, inSec) : -1
  const outIdx = hasTable ? rowAt(outRow, outSec) : -1

  // ffmpeg に渡す終端時刻: OUT フレームの次フレーム開始時刻（OUT含む）
  const exportOutSec = exportOutOf(outSec)

  // フレームテーブルが無いときの刻み幅。クリップの実際の fps（image.fps）、分からなければ 24。
  const fps = Math.max(1, image.fps ?? 24)
  const step = 1 / fps  // rVFC フォールバック用

  const canTrim = !ptsLoading && exportOutSec - inSec >= MIN_TRIM_SECONDS && dur > 0

  // トリム画面を開いたらフレーム時刻テーブルを生成
  useEffect(() => {
    setPtsLoading(true)
    setPtsError(false)
    ptsLoadedRef.current = false
    window.api.getClipFrames(image.id)
      .then(({ pts, dur: frameDur }) => {
        ptsLoadedRef.current = true
        if (pts.length === 0) {
          setPtsError(true)
        } else {
          setFramePts(pts)
          setFrameDurs(frameDur)
          setInSec(pts[0])
          setOutSec(pts[pts.length - 1])
          setInRow(0)
          setOutRow(pts.length - 1)
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
    window.api.getTimelineStrip(image.id, 15)
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
  // コマごとの位置の書き込みは、呼ぶ時点の最新を使う（updatePos は下で宣言）。
  const updatePosRef = useLatestRef(updatePos)
  useEffect(() => {
    const v = videoRef.current
    if (!v || !playing) return
    const stop = watchVideoFrames(v, (meta) => {
      if (meta.mediaTime >= exportOutSec - FRAME_EPS) {
        v.currentTime = inSec
        updatePosRef.current(inSec)
      } else {
        updatePosRef.current(meta.mediaTime)
      }
    })
    return stop ?? undefined
  }, [playing, inSec, exportOutSec, dur, updatePosRef])

  function updatePos(t: number): void {
    posRef.current = t
    if (playheadRef.current && dur > 0) playheadRef.current.style.left = `${(t / dur) * 100}%`
    if (vcTimeLabelRef.current) vcTimeLabelRef.current.textContent = `${fmtTime(t)} / ${fmtTime(dur)}`
  }

  // OUT に選んだフレームの「終わり」の時刻。OUT はそのフレームを含むので、帯やマーカーは
  // ここまで塗る必要がある。開始時刻で描くと、末尾のフレームを選んでも 1 コマ分だけ
  // 右端に届かない。
  // 次の行ではなく「次に時刻が進む行」を取る（findFrameIdx は同じ時刻の並びの最後を返す）。
  // 撮り逃しの行を OUT にしたとき次の行を取ると、映っている絵の手前で切れてしまう。
  function exportOutOf(outS: number): number {
    if (!hasTable) return outS
    const idx = findFrameIdx(framePts, outS)
    return idx + 1 < framePts.length ? framePts[idx + 1] : dur
  }

  function updateSelRangeUI(inS: number, outS: number): void {
    if (!selRangeRef.current) return
    const expOut = exportOutOf(outS)
    selRangeRef.current.textContent = t('trim.selection', { seconds: (expOut - inS).toFixed(2) })
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
    if (supportsVideoFrameCallback(v)) {
      let fired = false
      const timer = setTimeout(() => {
        if (fired) return
        fired = true
        deliver(v.currentTime)
      }, 200)
      onNextVideoFrame(v, (meta) => {
        if (fired) return
        fired = true
        clearTimeout(timer)
        deliver(meta.mediaTime)
      })
    } else {
      deliver(v.currentTime)
    }
  }

  // 再生 / 一時停止。**入口を 1 つにする**——以前は Space・映像クリック・バーのボタンの
  // 3 か所が同じことを書いていて、片方だけ直す食い違いが出る形だった。
  //
  // **範囲の外から流し始めない。** 再生は「切り出す範囲を確かめる」ためのものなので、
  // IN より手前や OUT より後ろで押したときは IN へ着けてから流す。以前は OUT 側しか
  // 見ていなかったため、最初の一周だけ切り捨てる区間が混ざって見えていた。
  function togglePlayback(): void {
    const v = videoRef.current
    if (!v) return
    if (!v.paused) { v.pause(); return }
    if (v.currentTime < inSec - FRAME_EPS || v.currentTime >= exportOutSec - FRAME_EPS) {
      seekSeqRef.current += 1
      v.currentTime = Math.max(0, Math.min(dur, inSec))
      displayedSecRef.current = inSec
      updatePos(inSec)
    }
    void v.play()
  }

  function stepIn(dir: number): void {
    if (hasTable) {
      const targetIdx = Math.max(0, Math.min(inIdx + dir, outIdx - 1))
      const targetSec = framePts[targetIdx]
      const v = videoRef.current
      if (v) { v.pause(); seekSeqRef.current += 1; v.currentTime = frameSeekSec(targetIdx); displayedSecRef.current = targetSec }
      playRowRef.current = targetIdx
      updatePos(targetSec)
      setInSec(targetSec)
      setInRow(targetIdx)
    } else {
      stepBoundaryRvfc(dir, 'in')
    }
  }

  function stepOut(dir: number): void {
    if (hasTable) {
      const targetIdx = Math.max(inIdx + 1, Math.min(outIdx + dir, framePts.length - 1))
      const targetSec = framePts[targetIdx]
      const v = videoRef.current
      if (v) { v.pause(); seekSeqRef.current += 1; v.currentTime = frameSeekSec(targetIdx); displayedSecRef.current = targetSec }
      playRowRef.current = targetIdx
      updatePos(targetSec)
      setOutSec(targetSec)
      setOutRow(targetIdx)
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
    if (supportsVideoFrameCallback(v)) {
      const target = Math.max(0, Math.min(dir > 0 ? cur + step * 1.5 : cur - step * 0.5, dur || 1e9))
      v.currentTime = target
      onNextVideoFrame(v, (meta) => {
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
        const idx = Math.max(0, Math.min(rowAt(playRowRef.current, t), outIdx - 1))
        setInSec(framePts[idx])
        setInRow(idx)
      } else {
        setInSec(Math.max(0, Math.min(t, outSec - step)))
      }
    })
  }

  function setCurrentAsOut(): void {
    withFrame(null, (t) => {
      if (hasTable) {
        const idx = Math.max(inIdx + 1, Math.min(rowAt(playRowRef.current, t), framePts.length - 1))
        setOutSec(framePts[idx])
        setOutRow(idx)
      } else {
        setOutSec(Math.max(t, inSec + step))
      }
    })
  }

  // IN/OUT がデフォルト（フレームテーブル先頭/末尾、テーブルなしなら 0/dur）から変わっているか。
  // 変わっている状態で Esc/✕ を押すと確認ダイアログを挟む（下の requestClose 参照）。
  const defaultInSec = hasTable ? framePts[0] : 0
  const defaultOutSec = hasTable ? framePts[framePts.length - 1] : dur
  // 行も見る。撮り逃しの並びの中で動かしただけだと時刻は変わらない。
  const boundaryChanged = Math.abs(inSec - defaultInSec) > FRAME_EPS || Math.abs(outSec - defaultOutSec) > FRAME_EPS
    || (hasTable && (inIdx !== 0 || outIdx !== framePts.length - 1))

  function requestClose(): void {
    if (boundaryChanged || removeAudio) setShowCloseConfirm(true)
    else onClose()
  }

  // 再生位置のコマ送り。フレームテーブルがあれば実 PTS を辿り、無ければ fps 換算で動かす。
  function stepPlayhead(dir: number): void {
    const v = videoRef.current
    if (!v) return
    v.pause()
    // **コマ表の取得中は推定の刻みへ落とさず保留する**（ビューアのコマ送りと同じ）。
    // 実測は数百ms 後に必ず来るのに、その間だけ fps 換算で動かすと、開いた直後の 1〜2 手
    // だけ素材のコマと無関係な位置へ飛ぶ。開いてすぐ押すのは普通の操作なので待つ方が正しい。
    // **押した手は捨てずに溜める**——握り潰すと「押したのに動かない」で終わる。
    if (ptsLoading) {
      pendingStepsRef.current = addPendingStep(pendingStepsRef.current, dir)
      return
    }
    if (hasTable) {
      const curIdx = rowAt(playRowRef.current, displayedSecRef.current)
      const targetIdx = Math.max(0, Math.min(curIdx + dir, framePts.length - 1))
      const targetSec = framePts[targetIdx]
      seekSeqRef.current += 1
      v.currentTime = frameSeekSec(targetIdx)
      displayedSecRef.current = targetSec
      playRowRef.current = targetIdx
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
    // 入力欄でだけ譲る。**ボタンは除外しない**——−1f や「ここを開始位置に設定」を押すと
    // フォーカスがそのボタンに残るので、除外すると「一度ボタンを押したあとだけキーが死ぬ」
    // ことになる。押した本人にはフォーカスの場所が見えないため、原因の分からない不発になる。
    // 以前はここが , / . だけ除外なしで、Space と I / O だけがボタンで死んでいた
    // （同じ画面でキーごとに挙動が違う状態）。
    //
    // Space はフォーカスの残ったボタンをブラウザが押し直すが、下の preventDefault が
    // それも同時に止めるので、二重に効くことはない（ビューアが元からこの形）。
    if (isEditingTarget(e.target)) return
    if (e.key === ',' || e.key === '.') {
      e.preventDefault()
      stepPlayhead(e.key === '.' ? 1 : -1)
      return
    }
    switch (e.key) {
      case 'i': case 'I': e.preventDefault(); setCurrentAsIn(); break
      case 'o': case 'O': e.preventDefault(); setCurrentAsOut(); break
      case ' ':
        e.preventDefault()
        togglePlayback()
        break
      // ビューアと同じ M。**画面ごとに違うキーを覚えさせない**（, / . を揃えたのと同じ理由）。
      case 'm': case 'M': {
        e.preventDefault()
        const v = videoRef.current
        if (v) v.muted = !v.muted
        break
      }
    }
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => keyHandlerRef.current(e)
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // 表の取得が終わったら、保留していたコマ送りをまとめて動かす。
  // **取得に失敗したときも動かす**——そこでは推定の刻みしか無いが、押した手を握り潰さない
  // 方を採る（ビューアの settle と同じ判断）。
  // 走らせるのは ptsLoading が変わったときだけ。stepPlayhead は取得後の framePts を掴んだ最新の版を呼ぶ。
  const stepPlayheadRef = useLatestRef(stepPlayhead)
  useEffect(() => {
    if (ptsLoading) return
    const pending = pendingStepsRef.current
    pendingStepsRef.current = 0
    if (pending !== 0) stepPlayheadRef.current(pending)
  }, [ptsLoading, stepPlayheadRef])

  // ネイティブシーク（video controls や外部操作）後に displayedSecRef を更新する
  function handleSeeked(): void {
    const v = videoRef.current
    if (!v) return
    onNextVideoFrame(v, (meta) => { displayedSecRef.current = meta.mediaTime })
  }

  // idx 番目のコマを**確実に映す**ためのシーク先。
  //
  // **コマの開始時刻ちょうどは狙わない。** 丸めやデコーダの解釈差で 1 つ手前のコマに
  // 着地することがあり、そうなると f{N} と出ている番号と映っている絵が食い違う。
  // ここは切る場所を絵で決める画面なので、番号だけ合っていても意味が無い。
  // 表示区間の中央を狙えば必ずそのコマに入る（frameTable.ts の frameSeekTarget の注記。
  // ビューアのコマ送りも同じ狙い方をしている）。
  //
  // **再生ヘッドや IN/OUT の値には使わない**——あちらはコマの開始時刻そのものが正しい。
  // ここで返すのは「そのコマを映すために video へ渡す時刻」だけ。
  function frameSeekSec(idx: number): number {
    return Math.max(0, Math.min(dur, frameSeekTarget(framePts, idx, step, frameDurs)))
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
    if (videoRef.current) {
      videoRef.current.currentTime = hasTable
        ? frameSeekSec(findFrameIdx(framePts, sec))
        : Math.max(0, Math.min(dur, sec))
    }
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
    let dragRow = kind === 'in' ? curInIdx : curOutIdx

    function onMove(ev: MouseEvent): void {
      if (!timelineRef.current || dur === 0) return
      const rect = timelineRef.current.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
      const raw = ratio * dur
      // 掴んでいる間も、映すのは「そのコマの表示区間の中央」にする（frameSeekSec の注記）。
      // ドラッグ中こそ絵を見ながら境目を決めているので、1 つ手前が映ると見誤る。
      const idx = hasTable
        ? (kind === 'in'
            ? Math.max(0, Math.min(findFrameIdx(framePts, snapToPts(raw)), curOutIdx - 1))
            : Math.max(curInIdx + 1, Math.min(findFrameIdx(framePts, snapToPts(raw)), framePts.length - 1)))
        : -1
      if (hasTable) { dragRow = idx; playRowRef.current = idx }
      if (kind === 'in') {
        const sec = hasTable ? framePts[idx] : Math.max(0, Math.min(raw, curOutSec - step))
        dragInSecRef.current = sec
        updateInUI(sec)
        updatePos(sec)
        if (videoRef.current) {
          videoRef.current.currentTime = hasTable ? frameSeekSec(idx) : Math.max(0, Math.min(dur, sec))
        }
      } else {
        const sec = hasTable ? framePts[idx] : Math.max(curInSec + step, Math.min(raw, dur))
        dragOutSecRef.current = sec
        updateOutUI(sec)
        updatePos(sec)
        if (videoRef.current) {
          videoRef.current.currentTime = hasTable ? frameSeekSec(idx) : Math.max(0, Math.min(dur, sec))
        }
      }
    }

    function onUp(): void {
      draggingRef.current = false
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (kind === 'in') { setInSec(dragInSecRef.current); setInRow(dragRow) }
      else { setOutSec(dragOutSecRef.current); setOutRow(dragRow) }
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  async function handleTrim(): Promise<void> {
    if (!canTrim || trimming) return
    // 焼き直しの間ずっと区間ループが回り続けて音も鳴っていた。押した意図は「これで切る」
    // なので、確かめる再生はそこで終わっている。
    videoRef.current?.pause()
    setTrimming(true)
    setTrimProgress({ ratio: 0, phase: 'encode' })
    setError(null)
    // 進み具合の購読は、走っている間だけ張る（閉じたあとに届いても捨てる）。
    const offProgress = window.api.onTrimProgress((p) => { if (mountedRef.current) setTrimProgress(p) })
    try {
      const result = await window.api.trimVideo(image.id, inSec, exportOutSec, removeAudio)
      if (result.ok) {
        onTrimmed()
        onClose()
      } else {
        setError(result.error)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      offProgress()
      setTrimming(false)
      setTrimProgress(null)
    }
  }

  const pct = (sec: number): string => dur > 0 ? `${(sec / dur) * 100}%` : '0%'
  const videoTitle = image.title ? image.title : fileName(image.filepath)

  // 外側クリックも Escape / ✕ と同じ道を通す。以前はここだけ「変更があれば何もしない」
  // だったため、IN/OUT を動かしたあとに枠外を押すと閉じも確認も出ず、黙って無反応になっていた。
  function handleOverlayClick(): void {
    if (!trimming) requestClose()
  }

  return (
    <div style={s.overlay} onClick={handleOverlayClick}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.header}>
          <span style={s.fileTitle} title={videoTitle}>{videoTitle}</span>
          <button style={s.closeBtn} onClick={requestClose} disabled={trimming} title={t('action.close')}><XIcon size={16} /></button>
        </div>

        <div style={s.videoWrap}>
          <video
            ref={videoRef}
            src={mediaUrl(image.id)}
            style={s.video}
            onClick={togglePlayback}
            onLoadedMetadata={(e) => {
              const d = safeDur(e.currentTarget.duration)
              setDur(d)
              if (!ptsLoadedRef.current) setOutSec(d)
            }}
            onTimeUpdate={(e) => {
              // 白い線は「映っているコマの左の境目」に置く（IN/OUT の線と同じく境目を指す）。
              // **video の時刻をそのまま描かない**——コマ送りは絵を確実に映すためにコマの
              // 真ん中へシークする（frameSeekSec）ので、ここで生の時刻を描くと、±1f で境目に
              // 置いた白い線がすぐ真ん中へ動き、IN/OUT の線と半コマずれて見えていた。
              const t = e.currentTarget.currentTime
              updatePos(hasTable ? framePts[findFrameIdx(framePts, t)] : t)
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
            <button style={vcBtnStyle} onClick={togglePlayback}>
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
          {/* 保存する動画に音声を入れるか。PC の編集ソフトでトラックの消音がタイムラインの
              左端（トラックの頭）にあるのに倣う。外すと斜線入りの灰色になる。 */}
          <button
            style={{ ...s.audioTrackBtn, ...(removeAudio ? s.audioTrackBtnOff : {}) }}
            onClick={() => setRemoveAudio((v) => !v)}
            disabled={trimming}
            title={removeAudio ? t('trim.audioOffTitle') : t('trim.audioOnTitle')}
          >
            <span style={s.audioTrackIcon}><MuteIcon muted={removeAudio} /></span>
          </button>
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
            <div style={s.boundaryCard}>
              <span style={{ ...s.badge, ...s.badgeIn }}>IN</span>
              <span ref={inTimeRef} style={s.time}>{fmtTime(inSec)}</span>
              <div style={s.stepper}>
                <button style={s.stepBtn} onClick={() => stepIn(-1)} disabled={ptsLoading}>−1f</button>
                <button style={{ ...s.stepBtn, ...s.stepBtnRight }} onClick={() => stepIn(+1)} disabled={ptsLoading}>+1f</button>
              </div>
              <button style={s.setBtn} onClick={setCurrentAsIn}>{t('trim.setIn')}</button>
            </div>
            <div style={s.boundaryCard}>
              <span style={{ ...s.badge, ...s.badgeOut }}>OUT</span>
              <span ref={outTimeRef} style={s.time}>{fmtTime(outSec)}</span>
              <div style={s.stepper}>
                <button style={s.stepBtn} onClick={() => stepOut(-1)} disabled={ptsLoading}>−1f</button>
                <button style={{ ...s.stepBtn, ...s.stepBtnRight }} onClick={() => stepOut(+1)} disabled={ptsLoading}>+1f</button>
              </div>
              <button style={s.setBtn} onClick={setCurrentAsOut}>{t('trim.setOut')}</button>
            </div>
          </div>
          <div style={s.infoRow}>
            <span ref={selRangeRef} style={s.duration}>
              {t('trim.selection', { seconds: (exportOutSec - inSec).toFixed(2) })}
            </span>
            {ptsLoading && <span style={s.ptsStatus}>{t('trim.analyzing')}</span>}
            {!ptsLoading && ptsError && <span style={s.ptsWarn}>{t('trim.analyzeFailed')}</span>}
            {/* 保存ボタンが灰色になる理由。**押せない状態を黙って出さない**——
                以前は範囲を詰めすぎると理由も出ずにボタンだけ死んでいた。 */}
            {!ptsLoading && dur > 0 && exportOutSec - inSec < MIN_TRIM_SECONDS && (
              <span style={s.ptsWarn}>{t('trim.tooShort', { seconds: MIN_TRIM_SECONDS })}</span>
            )}
            <span style={s.shortcutHint}>{t('trim.shortcutHint')}</span>
          </div>
          {error && <div style={s.errorMsg}>{t('trim.error', { message: trimErrorText(error, t) })}</div>}
        </div>

        <div style={s.footer}>
          <button style={s.cancelBtn} onClick={requestClose} disabled={trimming}>{t('action.cancel')}</button>
          <button
            style={{ ...s.trimBtn, ...(!canTrim || trimming ? s.trimDisabled : {}) }}
            onClick={handleTrim}
            disabled={!canTrim || trimming}
          >
            {!trimming
              ? t('trim.save')
              : trimProgress == null
                ? t('trim.working')
                : trimProgress.phase === 'finish'
                  ? t('trim.finishing')
                  : t('trim.workingPercent', { percent: String(Math.floor(trimProgress.ratio * 100)) })}
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
