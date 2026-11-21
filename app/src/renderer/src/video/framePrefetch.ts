// コマ再生の先読み。画面に出さない <video> をもう 1 つ開き、これから出す行の絵を先に作っておく。
//
// **1 コマごとに表の動画を飛ばしてから映すと、飛ぶのにかかる時間（キーフレームからの距離で 10〜60ms）が
// そのまま絵の出ている時間のばらつきになる**（2026-11-20 実測：1 コマ 0.1 秒で 53〜128ms）。動きを分析する
// アプリ（Kinovea など）も、飛びながら映さず、先に絵を作ってから一定の間隔で出している。ここは
// これから出す数コマぶんだけを持つ（録画の長さに関係なく、メモリは数コマぶん）。
//
// 絵を作るシーク先は、表の動画を動かすのと同じ計算を呼ぶ側が渡す（targetOf）。表があれば frameSeekSec
// （frameStep.ts。.claude/rules/frames.md「シーク先はそのコマ自身の長さの中央」）、コマの時刻が分からなければ fps で数えた
// コマの真ん中（estimatedStepTarget と同じ）。同じファイルの同じ時刻なので、重ねた絵と、その下で表の動画が
// 映す絵は同じになる。

// 先に作っておく行の数。1 コマ 0.1 秒でも、飛ぶ時間の長い所（〜60ms）が続いて追いつかれないだけの余裕。
export const PREFETCH_AHEAD = 8
// 1 枚作るのを待つ上限。超えたらその行は諦める（呼ぶ側は表の動画で映す）。
const CAPTURE_TIMEOUT_MS = 1500

export class FramePrefetcher {
  private readonly video: HTMLVideoElement
  private readonly ready: Promise<boolean>
  private readonly bitmaps = new Map<number, ImageBitmap>()
  private readonly waiting = new Map<number, Array<(bitmap: ImageBitmap | null) => void>>()
  private queue: number[] = []
  private busy = false
  private disposed = false

  constructor(src: string, private readonly targetOf: (row: number) => number) {
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.src = src
    this.video = v
    this.ready = new Promise((resolve) => {
      v.addEventListener('loadeddata', () => resolve(true), { once: true })
      v.addEventListener('error', () => resolve(false), { once: true })
    })
  }

  // rows の絵を（まだ無ければ）作る。順番どおりに作る。範囲の外の絵は捨てる。
  want(rows: number[]): void {
    if (this.disposed) return
    const keep = new Set(rows)
    for (const [row, bitmap] of this.bitmaps) {
      if (!keep.has(row)) { bitmap.close(); this.bitmaps.delete(row) }
    }
    this.queue = rows.filter((row) => !this.bitmaps.has(row))
    void this.pump()
  }

  // row の絵。作り終わるまで待つ。作れなければ null。
  get(row: number): Promise<ImageBitmap | null> {
    const ready = this.bitmaps.get(row)
    if (ready) return Promise.resolve(ready)
    if (this.disposed) return Promise.resolve(null)
    return new Promise((resolve) => {
      const list = this.waiting.get(row) ?? []
      list.push(resolve)
      this.waiting.set(row, list)
      if (!this.queue.includes(row)) { this.queue.unshift(row); void this.pump() }
    })
  }

  dispose(): void {
    this.disposed = true
    for (const bitmap of this.bitmaps.values()) bitmap.close()
    this.bitmaps.clear()
    for (const list of this.waiting.values()) for (const resolve of list) resolve(null)
    this.waiting.clear()
    this.video.removeAttribute('src')
    this.video.load()
  }

  private async pump(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      if (!(await this.ready)) { this.failAll(); return }
      while (!this.disposed && this.queue.length > 0) {
        const row = this.queue.shift()!
        if (this.bitmaps.has(row)) { this.settle(row, this.bitmaps.get(row)!); continue }
        const bitmap = await this.capture(row)
        if (this.disposed) { bitmap?.close(); return }
        if (bitmap) this.bitmaps.set(row, bitmap)
        this.settle(row, bitmap)
      }
    } finally {
      this.busy = false
    }
  }

  private async capture(row: number): Promise<ImageBitmap | null> {
    const v = this.video
    const target = this.targetOf(row)
    const limit = isFinite(v.duration) ? v.duration : Number.MAX_SAFE_INTEGER
    const seeked = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { v.removeEventListener('seeked', done); resolve(false) }, CAPTURE_TIMEOUT_MS)
      function done(): void { clearTimeout(timer); resolve(true) }
      v.addEventListener('seeked', done, { once: true })
    })
    v.currentTime = Math.max(0, Math.min(target, limit))
    if (!(await seeked)) return null
    try {
      return await createImageBitmap(v)
    } catch (err) {
      console.warn('[frame-play] prefetch capture failed', err)
      return null
    }
  }

  private settle(row: number, bitmap: ImageBitmap | null): void {
    const list = this.waiting.get(row)
    if (!list) return
    this.waiting.delete(row)
    for (const resolve of list) resolve(bitmap)
  }

  private failAll(): void {
    this.queue = []
    for (const list of this.waiting.values()) for (const resolve of list) resolve(null)
    this.waiting.clear()
  }
}

// row の次から ahead 行ぶん（ループするなら頭へ回る）。コマ再生で、これから絵が要る行の並び。
export function rowsAhead(row: number, total: number, ahead: number, loop: boolean): number[] {
  const out: number[] = []
  for (let k = 1; k <= ahead; k++) {
    const next = row + k
    if (next < total) out.push(next)
    else if (loop && total > 0) out.push(next % total)
    else break
  }
  return out
}
