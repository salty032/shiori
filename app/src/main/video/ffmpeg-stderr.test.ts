import { describe, expect, it } from 'vitest'

import { StderrCollector, STDERR_HEAD_MAX, STDERR_TAIL_MAX, STDERR_LINE_MAX } from './ffmpeg-stderr'

describe('ffmpeg の stderr の受け取り', () => {
  it('短い出力はそのまま全文を返す', () => {
    const c = new StderrCollector()
    c.push('Duration: 00:00:12.34\n')
    c.push('Stream #0:0: Video: vp9\n')
    expect(c.text).toBe('Duration: 00:00:12.34\nStream #0:0: Video: vp9\n')
  })

  it('先頭と末尾の間だけを省き、省いた分を本文に書く', () => {
    const c = new StderrCollector()
    const head = 'H'.repeat(STDERR_HEAD_MAX)
    const middle = 'M'.repeat(50000)
    const tail = 'T'.repeat(STDERR_TAIL_MAX)
    c.push(head + middle + tail)
    expect(c.text.startsWith(head)).toBe(true)
    expect(c.text.endsWith(tail)).toBe(true)
    expect(c.text).toContain('50000 chars omitted')
    // 溜め込んでいないので、元の出力の長さには比例しない
    expect(c.text.length).toBeLessThan(STDERR_HEAD_MAX + STDERR_TAIL_MAX + 100)
  })

  it('先頭と末尾が重なる長さでは重複させない（Duration 行が二重に出ない）', () => {
    const c = new StderrCollector()
    const whole = 'abcdefghij'.repeat(1000)  // 10,000 文字（HEAD+TAIL より短い）
    c.push(whole)
    expect(c.text).toBe(whole)
  })

  it('チャンクが行の途中で切れても 1 行として渡す', () => {
    const lines: string[] = []
    const c = new StderrCollector((line) => { lines.push(line) })
    c.push('pts_time:0.0')
    c.push('33\npts_time:0.06')
    c.push('66\n')
    expect(lines).toEqual(['pts_time:0.033', 'pts_time:0.0666'])
  })

  it('CR で上書きされる進捗行も 1 行として区切る', () => {
    const lines: string[] = []
    const c = new StderrCollector((line) => { lines.push(line) })
    c.push('frame=  1 fps=0.0\rframe= 24 fps=23.9\r')
    expect(lines).toEqual(['frame=  1 fps=0.0', 'frame= 24 fps=23.9'])
  })

  it('改行で終わらない最終行は finish() で渡す（最後の 1 フレームを取りこぼさない）', () => {
    const lines: string[] = []
    const c = new StderrCollector((line) => { lines.push(line) })
    c.push('pts_time:1.5\npts_time:1.6')
    expect(lines).toEqual(['pts_time:1.5'])
    c.finish()
    expect(lines).toEqual(['pts_time:1.5', 'pts_time:1.6'])
    // 二重に流さない
    c.finish()
    expect(lines).toHaveLength(2)
  })

  it('onLine が false を返したら打ち切りを立てる', () => {
    let seen = 0
    const c = new StderrCollector(() => { seen += 1; return seen < 2 ? undefined : false })
    c.push('a\n')
    expect(c.abortRequested).toBe(false)
    c.push('b\n')
    expect(c.abortRequested).toBe(true)
  })

  it('改行が来ないまま伸び続ける出力は行バッファに溜めない', () => {
    const lines: string[] = []
    const c = new StderrCollector((line) => { lines.push(line) })
    c.push('x'.repeat(STDERR_LINE_MAX + 1))
    c.push('後続\n')
    // 捨てた分は行として出さない
    expect(lines).toEqual(['後続'])
  })
})
