import { useSyncExternalStore } from 'react'

// 全画面のオーバーレイ（トリミング画面）が開いている間だけ立つ合図。
// ビューアと詳細パネルは、開いたことをここ経由で受け取る。
//
// 無いと困るのは音。トリミング画面はビューアと詳細パネルを覆うが、覆われたプレーヤーは
// 止まらないので、裏の映像がそのまま鳴り続けてトリマーの音と重なる。**隠れた映像は止める**は
// DetailPanel の pauseWhen={viewerOpen} と VideoPlayer の visibilitychange で既に採っている
// 方針で、これはその 3 つ目。止めるだけで、閉じても再生は再開しない（上の 2 つと同じ）。
//
// 真偽値ではなく数で持つ：閉じ際に次のオーバーレイが開いて一瞬重なると、真偽値では
// 先に閉じた方が「閉じた」と書き潰してしまう。
let overlayCount = 0
const overlayListeners = new Set<() => void>()

// オーバーレイを開いている間に呼び、閉じるときに戻り値を呼ぶ
// （useEffect のクリーンアップにそのまま返せる形）。
export function markOverlayOpen(): () => void {
  overlayCount++
  for (const fn of overlayListeners) fn()
  let released = false
  return () => {
    if (released) return
    released = true
    overlayCount--
    for (const fn of overlayListeners) fn()
  }
}

const subscribeOverlay = (fn: () => void): (() => void) => {
  overlayListeners.add(fn)
  return () => overlayListeners.delete(fn)
}

export function useOverlayOpen(): boolean {
  return useSyncExternalStore(subscribeOverlay, () => overlayCount > 0)
}
