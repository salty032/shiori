// ビューアの動画で「いま素材の何コマ目に居るか」を持つ部分。VideoPlayer.tsx から切り出した。
//
// 持っているのは、コマ表の取得・現在のコマの添字・±1 コマ／指定コマへの移動・コマ番号の表示の書き換え。
// 再生・シークバー・音量・コマ再生は VideoPlayer 側に残してある（そちらはこのフックの口を呼ぶだけ）。
//
// 決まりは .claude/rules/frames.md「ビューアのコマ送り」。**位置は時刻ではなく表の行で持つ。**
import { useEffect, useRef, useState } from 'react'
import { FRAME_EPS, addPendingStep, estimatedStepTarget, findFrameIdx, frameSeekTarget, isClipUnreliable } from './frameTable'
import { buildGapIndex, frameReadout, walkFrames, type GapIndex, type ReadoutKind } from './frameReadout'
import { useT, type Translate } from '../i18n'
import { useLatestRef } from '../hooks/useLatestRef'
import type { ClipFrames } from '../../../shared/api.video'
import { isPrecisionGuaranteed } from '../../../shared/frame-severity'
import type { ImageSource } from '../../../shared/types'

interface Options {
  videoRef: React.RefObject<HTMLVideoElement | null>
  id: number
  /** コマ表を取りに行くか（ビューアだけ。VideoPlayer の preloadFrameTable） */
  preloadFrameTable: boolean | undefined
  /** コマ表が使えないときの刻み幅（秒） */
  stepSec: number
  clipSource: ImageSource | undefined
  /** 録画そのものの素材 fps（設定の fps で埋めない）。精度を保証するかを決める */
  clipFps: number | null | undefined
  onFramesReady: ((frames: ClipFrames | null) => void) | undefined
  onFrameIndex: ((idx: number, gap: number) => void) | undefined
  /** 手でコマを送ったとき（コマ再生を止めるため。自動送りと手送りが混ざると、どちらの結果か分からなくなる） */
  onManualStep: () => void
}

export function useFramePosition({
  videoRef, id, preloadFrameTable, stepSec, clipSource, clipFps, onFramesReady, onFrameIndex, onManualStep
}: Options) {
  // このクリップのコマ情報。取得できるまでは null のまま。
  const framesRef = useRef<ClipFrames | null>(null)
  // 通知欠落数と、録画画像から推定したアニメの抜けコマ数を混ぜない。コマ送りと番号に使う
  // missing は後者だけ。推定できなければ 0 のままにし、境界で「未確認」と表示する。
  const gapIndexRef = useRef<GapIndex>(buildGapIndex(null))
  // このクリップのコマ送りが、どこを見ても当てにならないか。
  //
  // **抜けが 1 つでもあれば赤、にはしない。** 実測（手元 82 本・2026-08-26）では抜けのある
  // 録画 33 本の中身が両極端で、「1500 コマに 194 か所」の穴だらけと「899 コマに 1 コマ」が
  // 同居していた。後者を全体不可にすると、無傷な 898 か所の境目まで捨てることになる
  // （docs/ANIME-FRAMES.md「コマ送りの精度は命」）。欠落コマの割合で並べると 5.4% と 4.1% の間で分布が
  // 切れていたので、そこを境にする。大きい方 24 本は全体を赤、小さい方 9 本は場所を指す。
  const unreliableRef = useRef(false)
  // 表示を作り直す関数は描画ごとに作り直さないので、fps は ref 越しに最新を読む。
  const clipFpsRef = useRef(clipFps)
  clipFpsRef.current = clipFps
  // コマ送りの現在位置は「時刻」ではなく PTS 表の添字で持つ。
  //
  // 時刻で持って毎回シーク結果を実測し直すと、連打したときに前のシークの実測（非同期で
  // 返る）が後から古い位置を書き戻し、複数のコールバックが順不同で効くため、送り先が
  // 前後に飛んでコマ順が崩れる。添字を自分で ±1 していけば何回連打しても単調に動く。
  // null = まだ確定していない（外部の再生位置から引き直す）。
  const frameIdxRef = useRef<number | null>(null)
  // 実測行の後ろに推定した抜けがあるとき、その何コマ目に居るか。0 は実測行そのもの。
  // video_frames に偽の行は足さず、ビューア内の一時的な位置としてだけ持つ。
  const gapOffsetRef = useRef(0)
  // 自分のコマ送りによるシークかどうか。自分で動かした直後に外部同期（onSeeked）が
  // 添字を引き直すと、上と同じ書き戻しが起きるため 1 回だけ読み飛ばす。
  const selfSeekRef = useRef(false)
  // 最後にタイムシートへ知らせた位置（同じ位置を二度知らせないため）。
  const lastNotifiedFrameRef = useRef<string | null>(null)
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
  // 描画外（コマ送り・表の取得完了）から呼ぶので ref 経由にする。props を直に掴むと、
  // effect が作られた時点の古い関数が呼ばれる（readoutRef と同じ理由）。
  const onFramesReadyRef = useRef(onFramesReady)
  onFramesReadyRef.current = onFramesReady
  const onFrameIndexRef = useRef(onFrameIndex)
  onFrameIndexRef.current = onFrameIndex
  // 最後のコマの時刻（コマ表が取れているときだけ）。シークバーの右端に使う。
  const [frameEnd, setFrameEnd] = useState<number | null>(null)

  function setReadoutKind(kind: ReadoutKind): void {
    readoutRef.current = kind
    setReadout(kind)
  }

  // 下の effect から呼ぶコマ送りの関数は、描画ごとに作り直される（言語・表の読み込み）。
  // 付け直さずに、呼ぶ時点の最新を使う。
  const actionsRef = useLatestRef({ moveFrames, refreshFrameReadout })
  useEffect(() => {
    framesRef.current = null
    frameIdxRef.current = null
    gapIndexRef.current = buildGapIndex(null)
    gapOffsetRef.current = 0
    lastNotifiedFrameRef.current = null
    selfSeekRef.current = false
    pendingStepsRef.current = 0
    setFrameEnd(null)
    if (!preloadFrameTable) { setReadoutKind('off'); return }
    setReadoutKind('loading')
    let canceled = false
    // 取得の成否どちらでも、保留していたコマ送りをそこで解放する。
    // **保留したまま握り潰すと「押したのに動かない」で終わる**ため、失敗しても必ず動かす。
    const settle = (frames: ClipFrames | null): void => {
      if (canceled) return
      framesRef.current = frames
      // 抜けの索引（次の抜け・前までの積み上げ・母数）は frameReadout がまとめて作る。
      gapIndexRef.current = buildGapIndex(frames)
      // 判定は frameTable の isClipUnreliable が持つ（トリマーも同じものを読む）。
      unreliableRef.current = isClipUnreliable(frames)
      setFrameEnd(frames && frames.pts.length > 0 ? frames.pts[frames.pts.length - 1] : null)
      setReadoutKind(!frames || frames.pts.length === 0 ? 'estimated' : frames.sourceBased ? 'source' : 'file')
      onFramesReadyRef.current?.(frames && frames.pts.length > 0 ? frames : null)
      const pending = pendingStepsRef.current
      pendingStepsRef.current = 0
      if (pending !== 0) actionsRef.current.moveFrames(pending)
      else actionsRef.current.refreshFrameReadout()
    }
    window.api.getClipFrames(id)
      .then(settle)
      .catch((err) => { console.warn('[video] clip frames unavailable', err); settle(null) })
    return () => { canceled = true }
  }, [id, preloadFrameTable, actionsRef])

  // この実測行の次に、推定したアニメの抜けが何コマあるか。
  function missingAfter(idx: number): number {
    return gapIndexRef.current.gaps.get(idx)?.missing ?? 0
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
    // シークバーや再生で動いた位置からは、録画に無い仮想位置を復元できない。
    gapOffsetRef.current = 0
    updateFrameReadout(idx, 0)
  }

  // 現在の再生位置からコマ表示を引き直す（添字がまだ確定していない場合も含む）。
  function refreshFrameReadout(): void {
    updateFrameReadout(currentFrameIdx(), gapOffsetRef.current)
  }

  // コマ表示を書き換える。**何を出すかは frameReadout.ts が決める**（そちらでテストする）。
  // ここに残すのは DOM への書き込みと、タイムシートへの通知だけ。
  function updateFrameReadout(idx: number, gap = 0): void {
    const el = frameLabelRef.current
    if (!el) return
    const out = frameReadout({
      kind: readoutRef.current,
      idx,
      gap,
      frames: framesRef.current,
      index: gapIndexRef.current,
      unreliable: unreliableRef.current,
      guaranteed: isPrecisionGuaranteed(clipFpsRef.current),
      clipSource,
      estimatedFps: Math.round(1 / stepSec),
    }, tRef.current)
    // null は「コマ表が無い」＝表示を書き換えない（従来どおり前の表示のまま）。
    if (!out) return
    // **番号が変わったときだけ知らせる。** 受け取る側（タイムシート）は state を書くので、
    // 毎回呼ぶと同じ番号でも画面全体の描き直しが走る。掴んで動かしている間やコマ再生中は
    // これが 1 秒に何度も乗り、シークの待ちに上積みされていた。
    if (out.cur !== null) {
      const posKey = `${out.cur}:${gap}`
      if (posKey !== lastNotifiedFrameRef.current) {
        lastNotifiedFrameRef.current = posKey
        onFrameIndexRef.current?.(out.cur, gap)
      }
    }
    el.textContent = out.text
    el.style.color = out.color
  }

  // 実測行と、その間に推定した仮想コマを合わせて delta コマ歩く。
  // 実体は frameReadout.ts（歩き方だけをテストできるように出してある）。
  function walkFramesHere(idx: number, gap: number, delta: number, total: number): { idx: number; gap: number } {
    return walkFrames(idx, gap, delta, total, missingAfter)
  }

  // delta コマ動かす（正で先へ、負で前へ）。
  // コマ表があるときは隣のコマへ直接移る。表がないとき（解決役が未登録・解析失敗）だけ
  // fps 換算に落ちる（estimatedStepTarget：今いるコマを数えて、delta 先のコマの真ん中へ）。
  function moveFrames(delta: number): void {
    const v = videoRef.current
    if (!v || delta === 0) return
    v.pause()
    const limit = isFinite(v.duration) ? v.duration : Number.MAX_SAFE_INTEGER
    const pts = framesRef.current?.pts ?? []
    if (pts.length > 0) {
      const cur = currentFrameIdx()
      const curGap = gapOffsetRef.current
      const { idx: next, gap: nextGap } = walkFramesHere(cur, curGap, delta, pts.length)
      frameIdxRef.current = next
      gapOffsetRef.current = nextGap
      // 端でも表示だけは更新する。「719 / 719」で止まっていれば、壊れているのではなく
      // 端まで来たのだと分かる（以前は無反応で、どちらか区別できなかった）。
      updateFrameReadout(next, nextGap)
      if (next === cur) return
      selfSeekRef.current = true
      v.currentTime = Math.max(0, Math.min(frameSeekTarget(pts, next, stepSec, framesRef.current?.dur), limit))
      return
    }
    v.currentTime = estimatedStepTarget(v.currentTime, stepSec, delta, v.duration)
    updateFrameReadout(0)
  }

  // 1 コマ進めたとき、どの行の絵が出るか（コマ再生の先読み用）。抜けの中へ進むときは絵が変わらないので
  // 今の行、端なら今の行。**歩き方は moveFrames と同じ walkFrames を使う**——別に数えると、先読みした
  // 絵と番号がずれる。
  function peekNextRow(): number {
    const pts = framesRef.current?.pts ?? []
    if (pts.length === 0) return 0
    return walkFramesHere(currentFrameIdx(), gapOffsetRef.current, 1, pts.length).idx
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
    onManualStep()
    if (readoutRef.current === 'loading') {
      v.pause()   // 保留中でも再生は止める（押した意図は「ここで止めて見る」なので）
      pendingStepsRef.current = addPendingStep(pendingStepsRef.current, dir)
      return
    }
    moveFrames(dir)
  }

  // 指定コマへ直接移る（タイムシートの行クリック用）。
  function goToFrame(idx: number): void {
    const v = videoRef.current
    const pts = framesRef.current?.pts ?? []
    if (!v || pts.length === 0) return
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

  // 止めた位置を、番号のコマが使っている絵へ寄せる（シークバーから指を離したとき）。
  //
  // **録画ファイルには素材 1 コマにつき 2 枚ほど絵があり、表が使うのはそのうち 1 枚だけ。**
  // 使っていない方で止まると、その絵がもう次のコマのものであることがある（テスト動画の
  // 録画で、行と行の間の 228 枚のうち 56 枚）。そのままだと番号は前のコマなのに絵は次のコマで、
  // 1 コマ進めても同じ絵が出る。寄せる幅は最大 1 コマ。掴んでいる間は寄せない（指に逆らう）。
  function snapToShownFrame(): void {
    const v = videoRef.current
    const frames = framesRef.current
    if (!v || !v.paused || !frames?.sourceBased || frames.pts.length === 0) return
    const limit = isFinite(v.duration) ? v.duration : Number.MAX_SAFE_INTEGER
    const target = Math.max(0, Math.min(frameSeekTarget(frames.pts, currentFrameIdx(), stepSec, frames.dur), limit))
    if (Math.abs(v.currentTime - target) < FRAME_EPS) return
    selfSeekRef.current = true
    v.currentTime = target
  }

  // **流れ始めたらコマ送りの添字を捨てる。** 位置は seeked を出さずに進むので、
  // 持ったままだと止めたときにはもう別のコマに居る。以前はここが残っていたため、
  // 少し流してからコマ送りを押すと、最後に送った場所へ戻ってから 1 コマ動いていた
  // （コマ表示も、止めた瞬間に古い番号が出ていた）。
  function forgetPosition(): void {
    frameIdxRef.current = null
    gapOffsetRef.current = 0
  }

  // 再生中に描かれたコマの時刻から、添字を追い続ける（止めた位置からそのままコマ送りを
  // 続けられるように）。再生中は自分のシークと競合しないので、実測をそのまま反映してよい。
  // **コマ表示は書き換えない**——再生中は毎フレーム値が変わるため、書き換えると番号も
  // 「撮り逃し / 要注意」の注記も高速に明滅して読めたものではなくなる。
  function followPlayback(mediaTime: number): void {
    const pts = framesRef.current?.pts
    if (pts && pts.length > 0) { frameIdxRef.current = findFrameIdx(pts, mediaTime); gapOffsetRef.current = 0 }
  }

  return {
    /** 何を根拠にコマ表示を出しているか（off は出さない） */
    readout,
    readoutRef,
    /** コマ表示を書き込む先（<span> に付ける） */
    frameLabelRef,
    framesRef,
    gapIndexRef,
    frameEnd,
    currentFrameIdx,
    syncFrameIdx,
    refreshFrameReadout,
    moveFrames,
    peekNextRow,
    stepFrame,
    goToFrame,
    snapToShownFrame,
    forgetPosition,
    followPlayback,
  }
}
