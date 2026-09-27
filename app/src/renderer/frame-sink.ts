// 供給したフレームの「いつ画面から取り込まれたか」を数える口。
//
// 録画クリップの精度は「素材のコマ N はファイルの何枚目か」で持っており、その対応は
// 供給した順番そのものが根拠になっている（recorder.ts の drawnAt → main の buildFrameTable）。
// **数えた枚数とファイルの枚数が 1 枚でも食い違うと、以降の対応が丸ごと 1 枚ずれる。**
// **ずれても画面には何も出ない**——コマ送りは動くし、枚数も割合も合ったままで、隣のコマが
// 表示されるだけになる。
//
// **ファイルの 1 枚目は、記録開始の時点でキャンバスに描いてあった絵。** requestFrame を
// 1 度も呼んでいなくても、MediaRecorder は動き出した瞬間にそれを 1 枚書く（2026-09-28 実測：
// 送った枚数 552 に対しファイル 553、1 枚目と 2 枚目の間は 13ms）。以前はこの 1 枚を数えて
// おらず、表全体が 1 枚前へずれていた。1 枚目に「録画の準備中」が写ったのも同じ 1 枚。
// そこで、開く前に描いた最後の 1 枚の時刻を覚えておき、開いたときに 1 枚目として数える。
// **それより前に描いたぶんは数えない**（ファイルに入っていない）。
//
// 開いているかどうかを明示的に持つのは、画面キャプチャの立ち上げを録画の外へ出したため
// （描画ループが回り始めてから記録開始までに落ち着き待ちが入る）。
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
  /**
   * 記録が始まった。**MediaRecorder が動き出した後にだけ呼ぶ。**
   * 開く前に描いた最後の 1 枚（ファイルの 1 枚目になる絵）をここで数える。
   */
  open(): void
  /**
   * 1 枚描いたことを知らせる。
   *
   * 戻り値は「このフレームを記録に送ってよいか」。false のときは呼び出し元も
   * requestFrame してはいけない（送ったのに数えなければ、ずれる向きが逆になるだけ）。
   * 開く前は false を返し、時刻だけ「最後に描いた 1 枚」として覚えておく。
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
  // 開く前に描いた最後の 1 枚。描いた時点で epoch へ直しておく（退避も描いた時点の時刻にする）。
  let held: { at: number; missing: boolean } | null = null
  const toEpoch = (captureTime: number | undefined): { at: number; missing: boolean } =>
    captureTime === undefined
      ? { at: now(), missing: true }
      : { at: timeOrigin + captureTime, missing: false }
  const push = (frame: { at: number; missing: boolean }): void => {
    if (frame.missing) captureTimeMissing++
    drawnAt.push(frame.at)
  }
  return {
    drawnAt,
    get captureTimeMissing() { return captureTimeMissing },
    get isOpen() { return open },
    open() {
      if (open) return
      open = true
      if (held) push(held)
      held = null
    },
    record(captureTime: number | undefined): boolean {
      if (!open) {
        held = toEpoch(captureTime)
        return false
      }
      push(toEpoch(captureTime))
      return true
    }
  }
}
