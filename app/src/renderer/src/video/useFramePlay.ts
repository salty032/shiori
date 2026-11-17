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
import { useEffect } from 'react'
import type { ClipFrames } from '../../../shared/api.video'
import type { ReadoutKind } from './frameReadout'
import type { PlaybackSpeed } from './videoControls'

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
  /** コマを動かす口と刻み幅。描画ごとに作り直されるので、呼ぶ時点の最新を読む */
  actionsRef: React.RefObject<{
    moveFrames: (delta: number) => void
    goToFrame: (idx: number) => void
    currentFrameIdx: () => number
    stepSec: number
  }>
}

export function useFramePlay({
  videoRef, id, framePlay, setFramePlay, speed, loopRef, readoutRef, framesRef, actionsRef
}: Options): void {
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
    return () => { alive = false; if (timer) clearTimeout(timer) }
    // 関数と刻み幅は actionsRef から最新を読む。依存に並べると、表の読み込みなどで
    // 作り直されるたびにコマ再生が付け直され、押した直後の 1 コマ送りがもう一度走る。
  }, [framePlay, speed, id, videoRef, setFramePlay, loopRef, readoutRef, framesRef, actionsRef])
}
