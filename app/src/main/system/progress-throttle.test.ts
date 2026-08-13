import { describe, expect, it, vi } from 'vitest'
import { createProgressThrottle } from './progress-throttle'

describe('createProgressThrottle', () => {
  it('最終件（current >= total）は常に true', () => {
    const shouldSend = createProgressThrottle(10)
    expect(shouldSend(10)).toBe(true)
  })

  it('総数0件でも最終件（current >= total）は true', () => {
    const shouldSend = createProgressThrottle(0)
    expect(shouldSend(0)).toBe(true)
  })

  it('パーセントが変わらず時間も経過していなければ間引く', () => {
    vi.useFakeTimers()
    try {
      const shouldSend = createProgressThrottle(1000, 25)
      expect(shouldSend(1)).toBe(true) // 0% → 0%だが初回(lastPercent=-1)なので送る
      // 同じ 0% 台のまま、時間も進めていない → 間引かれる
      expect(shouldSend(2)).toBe(false)
      expect(shouldSend(3)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('パーセント表示が変わったら間引かれていても送る', () => {
    vi.useFakeTimers()
    try {
      const shouldSend = createProgressThrottle(100, 25)
      expect(shouldSend(1)).toBe(true) // 1%
      expect(shouldSend(1)).toBe(false) // 変化なし
      expect(shouldSend(2)).toBe(true) // 2% に変化
    } finally {
      vi.useRealTimers()
    }
  })

  it('intervalMs 経過したら同じパーセントでも送る', () => {
    vi.useFakeTimers()
    try {
      const shouldSend = createProgressThrottle(1000, 25)
      expect(shouldSend(1)).toBe(true)
      expect(shouldSend(2)).toBe(false)
      vi.advanceTimersByTime(30)
      expect(shouldSend(3)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
