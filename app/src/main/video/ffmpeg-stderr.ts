// ffmpeg の stderr の受け取り方。ffmpeg.ts 本体から切り出してあるのは、行の区切り方と
// 切り詰めの境目をテストで固定するため。
// ── ffmpeg の出力をメモリへ溜め込まないための上限 ──────────────────────────
//
// stderr は素材が長いほど際限なく伸びる（showinfo はデコードした全フレームを 1 行ずつ
// 出す）。全文を 1 本の文字列へ連結すると、壊れたファイルや尺の申告が嘘のファイルで
// main プロセスのメモリを食い潰し、UI ごと固まる。テキストとして残すのは先頭
// （Duration / Stream 行が出る）と末尾（失敗理由が出る）だけにして、途中の行は
// 受け取る側がその場で数値へ畳む。
export const STDERR_HEAD_MAX = 8 * 1024
export const STDERR_TAIL_MAX = 4 * 1024
// 改行が来ないまま伸び続けるのは異常出力。捨てないと行バッファ側でメモリが伸びる。
export const STDERR_LINE_MAX = 64 * 1024

/**
 * ffmpeg の stderr を「先頭と末尾のテキスト」＋「行ごとのコールバック」へ畳んで受け取る。
 * onLine が false を返したら上限到達の合図で、呼び出し元は ffmpeg を打ち切る。
 */
export class StderrCollector {
  private head = ''
  private tail = ''
  private carry = ''
  private total = 0
  abortRequested = false

  constructor(private readonly onLine?: (line: string) => boolean | void) {}

  push(chunk: string): void {
    this.total += chunk.length
    if (this.head.length < STDERR_HEAD_MAX) {
      this.head += chunk.slice(0, STDERR_HEAD_MAX - this.head.length)
    }
    const merged = this.tail + chunk
    this.tail = merged.length > STDERR_TAIL_MAX ? merged.slice(-STDERR_TAIL_MAX) : merged

    if (!this.onLine) return
    this.carry += chunk
    // ffmpeg は進捗行を CR で上書きし、showinfo は LF で改行する。どちらも行の区切りとして扱う。
    let idx = this.carry.search(/[\r\n]/)
    while (idx >= 0) {
      const line = this.carry.slice(0, idx)
      this.carry = this.carry.slice(idx + 1)
      if (line && this.onLine(line) === false) this.abortRequested = true
      idx = this.carry.search(/[\r\n]/)
    }
    if (this.carry.length > STDERR_LINE_MAX) this.carry = ''
  }

  /** 最後の行は改行で終わらないことがあるので、終了時に一度だけ流す */
  finish(): void {
    if (!this.onLine || !this.carry) return
    const line = this.carry
    this.carry = ''
    if (this.onLine(line) === false) this.abortRequested = true
  }

  /** 失敗理由の表示用。省いた部分があるときはその旨を本文に挟む */
  get text(): string {
    const overlap = this.head.length + this.tail.length - this.total
    if (overlap >= 0) return this.head + this.tail.slice(overlap)
    const omitted = this.total - this.head.length - this.tail.length
    return `${this.head}\n...(${omitted} chars omitted)...\n${this.tail}`
  }
}

