// 時間のかかる作業を、同時に 2 つ走らせないための入口。
//
// **作業ごとに「動いている最中か」の旗を手で書いていたら、書き忘れが 3 回あった**（画像の書き出し・
// ライブラリのインポート・取り込み。どれもコードの見直しで指摘されてから足した）。renderer 側の
// ボタン無効化だけでは、別ウィンドウからの呼び出しや、無効化が間に合う前の 2 回目を防げない。
// ここを通して始めれば、「動いている最中か」と終了確認の登録簿（busy.ts）を書き忘れようがない。
//
// 2 回目を「待たせて同じ結果を返す」作業（AI モデルのダウンロード）と、クリップごとに防ぐ作業
// （トリミング）は形が違うので、ここを通さない。
import { beginTask, endTask, type BusyTask } from './busy'

export interface ExclusiveTask {
  /**
   * 動いていなければ fn を走らせる。動いていれば fn を呼ばずに whenBusy を返す。
   * busy を渡すと、走っている間だけ終了確認の登録簿に載せる。
   * **始めるたびに「やめて」を下ろす**——前の回の「やめて」が次の回を止めないように。
   */
  run<T>(busy: BusyTask | null, whenBusy: NoInfer<T>, fn: () => Promise<T>): Promise<T>
  /** 「やめて」と言われたか。作業はループの節目でこれを見て抜ける */
  readonly canceled: boolean
  cancel(): void
  /**
   * 「やめて」を下ろす。run が始めに下ろすので、普段は呼ばない。
   * フォルダを選ばせた後など、その時点より前に押された「やめて」を無かったことにしたい作業だけが呼ぶ。
   */
  clearCancel(): void
}

export function exclusiveTask(): ExclusiveTask {
  let running = false
  let canceled = false
  return {
    async run<T>(busy: BusyTask | null, whenBusy: NoInfer<T>, fn: () => Promise<T>): Promise<T> {
      if (running) return whenBusy
      running = true
      canceled = false
      if (busy) beginTask(busy)
      try {
        return await fn()
      } finally {
        running = false
        if (busy) endTask(busy)
      }
    },
    get canceled() { return canceled },
    cancel() { canceled = true },
    clearCancel() { canceled = false },
  }
}
