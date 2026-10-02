// 「準備中」を消した後の画面がキャプチャ経路を通り、canvas まで届いたかを判定する。
// DOM 側の描画完了だけでは、画面キャプチャに古いフレームが残っている可能性があるため、
// requestVideoFrameCallback の captureTime を観測時点の壁時計へ直して境界と比較する。
// performance.timeOrigin を固定で足すと、長時間起動やスリープ後の時計補正が反映されず、
// 数十 ms の境界判定が逆転しうるため使わない。
export interface CaptureBoundary {
  /** canvas に描いたフレームの captureTime を知らせる。無い環境では確認扱いにしない。 */
  observe(captureTime: number | undefined): void
  /** afterEpoch 以後に撮られたフレームを deadlineEpoch まで待つ。 */
  wait(afterEpoch: number, deadlineEpoch: number): Promise<boolean>
}

export function createCaptureBoundary(clock?: { now?: () => number; performanceNow?: () => number }): CaptureBoundary {
  const now = clock?.now ?? (() => Date.now())
  const performanceNow = clock?.performanceNow ?? (() => performance.now())
  let lastCaptureEpoch: number | null = null
  let pending: { after: number; finish: (confirmed: boolean) => void } | null = null

  return {
    observe(captureTime) {
      if (captureTime === undefined || !Number.isFinite(captureTime)) return
      // captureTime と performance.now() は同じ単調時計。観測した瞬間の Date.now() から
      // 経過差を引けば、起動時から壁時計が補正されていても現在の epoch にそろう。
      lastCaptureEpoch = now() - (performanceNow() - captureTime)
      if (pending && lastCaptureEpoch >= pending.after) pending.finish(true)
    },
    wait(afterEpoch, deadlineEpoch) {
      if (lastCaptureEpoch !== null && lastCaptureEpoch >= afterEpoch) return Promise.resolve(true)
      return new Promise<boolean>((resolve) => {
        let done = false
        const finish = (confirmed: boolean): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          if (pending?.finish === finish) pending = null
          resolve(confirmed)
        }
        const timer = setTimeout(() => finish(false), Math.max(0, deadlineEpoch - now()))
        pending = { after: afterEpoch, finish }
      })
    }
  }
}
