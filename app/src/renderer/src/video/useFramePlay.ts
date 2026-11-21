// コマ再生（自動でコマを送り続ける）。VideoPlayer.tsx から切り出した。
//
// **素材のコマを 1 つずつ、一定の時間だけ見せて自動で送る。**
//
// 倍率を下げた再生（playbackRate）との違いは、送るのがファイルのフレームではなく
// 素材の実コマだということ。録画クリップのファイルのフレームは画面キャプチャの供給レートの
// 産物なので、遅くして眺めてもそこで数えたコマ数は素材のコマ数ではない。
//
// 素材のコマは等間隔に並ぶので、これは**時間軸を一様に伸ばした減速**であり、コマ打ちの
// 溜め（3 コマ続く絵は 3 倍の時間そこに留まる）はそのまま残る。
// 映像要素は止めたまま動かすので、コマ番号と「撮り逃し / 要注意」も出たままになる。
//
// **コマ表があるときは、先に作った絵を固定の刻みで重ねて出す**（framePrefetch.ts）。表の動画を飛ばして
// から映すと、飛ぶ時間のばらつきがそのまま絵の出ている時間のばらつきになっていた（2026-11-20 実測）。
// 番号の表示と表の動画の位置はこれまでどおり 1 コマずつ動かすので、止めれば元の状態に戻る。
// **先読みが間に合わないときは待つ。** 別のコマの絵を出してまで刻みを守らない（精度が先）。
import { useEffect } from 'react'
import type { ClipFrames } from '../../../shared/api.video'
import type { ReadoutKind } from './frameReadout'
import type { PlaybackSpeed } from './videoControls'
import { FramePrefetcher, PREFETCH_AHEAD, rowsAhead } from './framePrefetch'
import { FRAME_EPS } from './frameTable'
import { frameSeekSec } from './frameStep'

interface Options {
  videoRef: React.RefObject<HTMLVideoElement | null>
  id: number
  /** コマ再生が走っているか */
  framePlay: boolean
  setFramePlay: (on: boolean) => void
  /** 1 コマを何秒見せるか。null は等速（コマ再生ではない） */
  speed: PlaybackSpeed
  /** ループの現在値（描画の外で回るので ref で読む） */
  loopRef: React.RefObject<boolean>
  /** コマ表の読み込み中かを見る（useFramePosition の readoutRef） */
  readoutRef: React.RefObject<ReadoutKind>
  framesRef: React.RefObject<ClipFrames | null>
  /** 先に作った絵を重ねる先（映像の真上に置いた canvas） */
  overlayRef: React.RefObject<HTMLCanvasElement | null>
  /** コマを動かす口と刻み幅。描画ごとに作り直されるので、呼ぶ時点の最新を読む */
  actionsRef: React.RefObject<{
    moveFrames: (delta: number) => void
    goToFrame: (idx: number) => void
    currentFrameIdx: () => number
    peekNextRow: () => number
    stepSec: number
  }>
}

// 画面の書き換えの間隔の初めの見込み（60Hz）。コマ再生中に実際の間隔を測って置き換える
// （120Hz・144Hz の画面では 8.3ms・6.9ms。決め打ちすると、どの書き換えに乗せるかの境目が粗くなる）。
const DEFAULT_REFRESH_MS = 1000 / 60

// 先に作った絵を、映像と同じ場所・同じ大きさ・同じ拡大で重ねる。
function showOverlay(canvas: HTMLCanvasElement, video: HTMLVideoElement, bitmap: ImageBitmap): void {
  if (canvas.width !== bitmap.width) canvas.width = bitmap.width
  if (canvas.height !== bitmap.height) canvas.height = bitmap.height
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
  const st = canvas.style
  st.left = `${video.offsetLeft}px`
  st.top = `${video.offsetTop}px`
  st.width = `${video.offsetWidth}px`
  st.height = `${video.offsetHeight}px`
  st.transform = video.style.transform
  st.transformOrigin = video.style.transformOrigin
  st.visibility = 'visible'
}

export function useFramePlay({
  videoRef, id, framePlay, setFramePlay, speed, loopRef, readoutRef, framesRef, overlayRef, actionsRef
}: Options): void {
  useEffect(() => {
    if (!framePlay || speed === null) return
    const holdSec = speed
    const v = videoRef.current
    if (!v) return
    v.pause()
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let raf: number | null = null
    // コマ表があるときの先読み（最初に表のある状態で進めるときに作る）。
    let prefetcher: FramePrefetcher | null = null
    // 重ねている絵の行（null = 重ねていない。下の表の動画がそのまま見えている）。
    let shownRow: number | null = null
    // この 1 コマを進めるきっかけになった画面の書き換えの時刻（atFrame から。それ以外で進めたときは null）。
    let frameTs: number | null = null
    // 測った画面の書き換えの間隔。
    let refreshMs = DEFAULT_REFRESH_MS

    const hideOverlay = (): void => {
      const canvas = overlayRef.current
      if (canvas) canvas.style.visibility = 'hidden'
      shownRow = null
    }

    // 先読みして 1 コマ進める。先に作った絵を待ってから、番号と表の動画を動かし、絵を重ねる。
    // コマ表（またはファイルのコマの時刻）があれば表の行で、無ければ fps で数えたコマで数える。
    const advancePrefetched = async (pts: number[]): Promise<void> => {
      const canvas = overlayRef.current
      if (!canvas) return
      const stepSec = actionsRef.current.stepSec
      const byTable = pts.length > 0
      const dur = framesRef.current?.dur
      const targetOf = byTable
        ? (row: number): number => frameSeekSec({ pts, dur }, row, stepSec, isFinite(v.duration) ? v.duration : Number.MAX_SAFE_INTEGER)
        : (row: number): number => Math.min((row + 0.5) * stepSec, v.duration)
      if (!prefetcher) prefetcher = new FramePrefetcher(v.currentSrc || v.src, targetOf)
      const total = byTable ? pts.length : Math.max(1, Math.ceil(v.duration / stepSec - FRAME_EPS))
      const loop = loopRef.current
      const cur = byTable ? actionsRef.current.currentFrameIdx() : Math.floor((v.currentTime + FRAME_EPS) / stepSec)
      // 端に着いたら、ループが入っていれば先頭へ戻し、そうでなければ止める。
      const wrap = cur >= total - 1
      if (wrap && !loop) { setFramePlay(false); return }
      const nextRow = wrap ? 0 : byTable ? actionsRef.current.peekNextRow() : cur + 1
      // 抜けの中へ進むときは絵が変わらない（手前の行の絵のまま）。
      const needsPicture = nextRow !== (shownRow ?? cur)
      if (needsPicture) prefetcher.want([nextRow, ...rowsAhead(nextRow, total, PREFETCH_AHEAD, loop)])
      const bitmap = needsPicture ? await prefetcher.get(nextRow) : null
      if (!alive) return
      if (wrap && byTable) actionsRef.current.goToFrame(0)
      else if (wrap) v.currentTime = targetOf(0)
      else actionsRef.current.moveFrames(1)
      if (needsPicture) {
        // 作れなかった行は重ねず、表の動画で映す（遅いが、別のコマの絵は出さない）。
        if (bitmap) { showOverlay(canvas, v, bitmap); shownRow = nextRow } else hideOverlay()
      }
      prefetcher.want([nextRow, ...rowsAhead(nextRow, total, PREFETCH_AHEAD, loop)])
      // 次に出す時刻は「この絵を出した書き換えの時刻 + 表示時間」。書き換えの刻みの上で数えるので、
      // 出す時刻が書き換えと書き換えの中間に来て、早い方と遅い方を行き来することがない。
      // 絵を待って書き換えの外で出したときは、出した今から数える（遅れを早送りで取り返さない）。
      const now = performance.now()
      const shownAt = frameTs !== null && now - frameTs < refreshMs / 2 ? frameTs : now
      frameTs = null
      atFrame(shownAt + holdSec * 1000)
    }

    // 次の絵を出すのを、画面の書き換え（requestAnimationFrame）の刻みに合わせる。
    // **タイマーだけで決めると、鳴るのが 10〜15ms 遅れたり、書き換えの刻みとずれたりして**、同じ 0.1 秒が
    // 画面では 83ms や 117ms になっていた（2026-11-20 実測）。少し手前でタイマーを鳴らし、その後は
    // 書き換えのたびに時刻を見て、出す時刻（の書き換え半回ぶん手前）を過ぎた最初の書き換えで出す。
    const atFrame = (due: number): void => {
      let lastTs: number | null = null
      const tick = (ts: number): void => {
        if (!alive) return
        // 続けて来た書き換えの間隔から、画面の書き換えの間隔を測る（飛んだ回・止まっていた回は数えない）。
        if (lastTs !== null) {
          const d = ts - lastTs
          if (d > 2 && d < 50) refreshMs = refreshMs * 0.8 + d * 0.2
        }
        lastTs = ts
        if (ts >= due - refreshMs / 2) { frameTs = ts; advance(); return }
        raf = requestAnimationFrame(tick)
      }
      timer = setTimeout(() => { raf = requestAnimationFrame(tick) }, Math.max(0, due - performance.now() - 30))
    }

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
      // コマの時刻も長さも分からないときだけ、先読みせずに表の動画を飛ばして映す。
      if (overlayRef.current && (pts.length > 0 || (isFinite(v.duration) && v.duration > 0))) { void advancePrefetched(pts); return }
      const cur = actionsRef.current.currentFrameIdx()
      // 端に着いたら、ループが入っていれば先頭へ戻し、そうでなければ止める。
      // **止まったことは画面に出る**（ボタンの色が戻り、コマ表示は最後の番号のまま残る）。
      if (pts.length > 0 && cur >= pts.length - 1) {
        if (!loopRef.current) { setFramePlay(false); return }
        actionsRef.current.goToFrame(0)
      } else if (pts.length === 0 && isFinite(v.duration) && v.currentTime >= v.duration - actionsRef.current.stepSec) {
        if (!loopRef.current) { setFramePlay(false); return }
        v.currentTime = 0
      } else {
        actionsRef.current.moveFrames(1)
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
    const cur = actionsRef.current.currentFrameIdx()
    const atEnd = pts.length > 0
      ? cur >= pts.length - 1
      : isFinite(v.duration) && v.currentTime >= v.duration - actionsRef.current.stepSec
    if (atEnd) {
      if (pts.length > 0) actionsRef.current.goToFrame(0)
      else v.currentTime = 0
      timer = setTimeout(advance, holdSec * 1000)
    } else {
      // 押したらすぐ 1 コマ動く。**待たせない**——最初の 1 コマを待たせると、
      // 遅い設定（1 コマ 1 秒）では押しても動かないのと区別が付かない。
      advance()
    }
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      if (raf !== null) cancelAnimationFrame(raf)
      prefetcher?.dispose()
      // 重ねた絵は、下の表の動画が同じ行を映し終えてから外す（外した瞬間に前の絵が見えないように）。
      if (shownRow !== null) {
        if (v.seeking) v.addEventListener('seeked', hideOverlay, { once: true })
        else hideOverlay()
      }
    }
    // 関数と刻み幅は actionsRef から最新を読む。依存に並べると、表の読み込みなどで
    // 作り直されるたびにコマ再生が付け直され、押した直後の 1 コマ送りがもう一度走る。
  }, [framePlay, speed, id, videoRef, setFramePlay, loopRef, readoutRef, framesRef, overlayRef, actionsRef])
}
