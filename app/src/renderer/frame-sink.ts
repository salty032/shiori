// 供給したフレームの「いつ画面から取り込まれたか」を数える口。
//
// **数え始めるのは MediaRecorder が動き出してから。** 録画クリップの精度は「素材のコマ N は
// ファイルの何枚目か」で持っており、その対応は供給した順番そのものが根拠になっている
// （recorder.ts の drawnAt → main の buildFrameTable）。記録が始まる前に供給した 1 枚を
// 数えると、以降の対応が丸ごと 1 枚ずれる。**ずれても画面には何も出ない**——コマ送りは
// 動くし、枚数も割合も合ったままで、隣のコマが表示されるだけになる。
//
// 以前はこれを「描画ループを回し始めてから rec.start() までの間に await を挟まない」ことで
// 守っていた（間に処理が中断しなければ rVFC は 1 度も呼ばれない）。画面キャプチャの
// 立ち上げを録画の外へ出すため、そこに落ち着き待ちが入って前提が消えたので、開いているか
// どうかを明示的に持つ。
//
// 独立したモジュールにするのは、recorder.ts が MediaRecorder・getDisplayMedia・canvas を
// 直に触る層でテストから駆動できないため。**この 1 点だけは検証できる形に置く。**
export interface FrameSink {
  /** 記録開始からこれまでに供給したフレームの取り込み時刻（epoch ミリ秒） */
  readonly drawnAt: number[]
  /** captureTime が載らず現在時刻へ退避した枚数（CaptureDiag に載せる） */
  readonly captureTimeMissing: number
  /** 記録が始まっているか */
  readonly isOpen: boolean
  /** 記録が始まった。**MediaRecorder が動き出した後にだけ呼ぶ** */
  open(): void
  /**
   * 1 枚供給したことを記録する。
   *
   * 戻り値は「このフレームを記録に送ってよいか」。false のときは呼び出し元も
   * requestFrame してはいけない（送ったのに数えなければ、ずれる向きが逆になるだけ）。
   */
  record(captureTime: number | undefined): boolean
}

/**
 * @param clock now: captureTime が無いときの退避先（既定は Date.now）。
 *              timeOrigin: performance 時刻を epoch へ直すための原点。
 *              **配信ページとは別プロセスなので、この変換をしないと突き合わせられない。**
 */
export function createFrameSink(clock?: { now?: () => number; timeOrigin?: number }): FrameSink {
  const now = clock?.now ?? (() => Date.now())
  const timeOrigin = clock?.timeOrigin ?? performance.timeOrigin
  const drawnAt: number[] = []
  let captureTimeMissing = 0
  let open = false
  return {
    drawnAt,
    get captureTimeMissing() { return captureTimeMissing },
    get isOpen() { return open },
    open() { open = true },
    record(captureTime: number | undefined): boolean {
      if (!open) return false
      if (captureTime === undefined) {
        captureTimeMissing++
        drawnAt.push(now())
      } else {
        drawnAt.push(timeOrigin + captureTime)
      }
      return true
    }
  }
}
