import { describe, expect, it, vi } from 'vitest'
import { createCaptureBoundary } from './capture-boundary'

describe('createCaptureBoundary', () => {
  it('境界より後に撮られたフレームが既にあれば、すぐ確認できる', async () => {
    const gate = createCaptureBoundary({ now: () => 1_000, performanceNow: () => 500 })
    gate.observe(520)
    await expect(gate.wait(1_000, 1_200)).resolves.toBe(true)
  })

  it('captureTime は起動時の timeOrigin ではなく、観測時点の壁時計へ直す', async () => {
    const gate = createCaptureBoundary({ now: () => 2_000, performanceNow: () => 500 })
    gate.observe(490)
    await expect(gate.wait(1_985, 2_100)).resolves.toBe(true)
  })

  it('境界より前のフレームを無視し、後のフレームを待つ', async () => {
    vi.useFakeTimers()
    try {
      const gate = createCaptureBoundary({ now: () => Date.now(), performanceNow: () => 500 })
      gate.observe(400)
      const waiting = gate.wait(1_000, 1_200)
      gate.observe(501)
      await expect(waiting).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('captureTime が無い環境では、期限で未確認として返す', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const gate = createCaptureBoundary({ now: () => Date.now(), performanceNow: () => 500 })
      gate.observe(undefined)
      const waiting = gate.wait(1_000, 1_200)
      await vi.advanceTimersByTimeAsync(200)
      await expect(waiting).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
