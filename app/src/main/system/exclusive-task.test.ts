import { describe, expect, it, beforeEach, vi } from 'vitest'

// busy.ts が i18n 経由で設定を読む。モックしないと Electron の app.getPath を呼んで落ちる。
vi.mock('./settings', () => ({ loadSettings: () => ({ language: 'ja' }) }))

import { exclusiveTask } from './exclusive-task'
import { hasActiveTasks, resetTasksForTest } from './busy'

beforeEach(() => resetTasksForTest())

// 外から終わらせられる作業。終わる前に 2 回目を呼ぶために使う。
function pending<T>(): { promise: Promise<T>; finish: (value: T) => void; fail: (err: Error) => void } {
  let finish!: (value: T) => void
  let fail!: (err: Error) => void
  const promise = new Promise<T>((resolve, reject) => { finish = resolve; fail = reject })
  return { promise, finish, fail }
}

describe('exclusiveTask', () => {
  it('動いている間の 2 回目は、作業を呼ばずに whenBusy を返す', async () => {
    const task = exclusiveTask()
    const first = pending<string>()
    const second = vi.fn(async () => 'second')
    const running = task.run(null, 'busy', () => first.promise)
    expect(await task.run(null, 'busy', second)).toBe('busy')
    expect(second).not.toHaveBeenCalled()
    first.finish('first')
    expect(await running).toBe('first')
  })

  it('終わったら、また始められる', async () => {
    const task = exclusiveTask()
    expect(await task.run(null, 'busy', async () => 'a')).toBe('a')
    expect(await task.run(null, 'busy', async () => 'b')).toBe('b')
  })

  it('途中で失敗しても、動いている最中のまま残らない', async () => {
    const task = exclusiveTask()
    const first = pending<string>()
    const running = task.run(null, 'busy', () => first.promise)
    first.fail(new Error('boom'))
    await expect(running).rejects.toThrow('boom')
    expect(await task.run(null, 'busy', async () => 'again')).toBe('again')
  })

  it('busy を渡すと、走っている間だけ終了確認の登録簿に載る（失敗しても外れる）', async () => {
    const task = exclusiveTask()
    const first = pending<void>()
    const running = task.run('import', undefined, () => first.promise)
    expect(hasActiveTasks()).toBe(true)
    first.fail(new Error('boom'))
    await expect(running).rejects.toThrow('boom')
    expect(hasActiveTasks()).toBe(false)
  })

  it('2 回目を断ったときは、登録簿に余分に載せない', async () => {
    const task = exclusiveTask()
    const first = pending<void>()
    const running = task.run('import', undefined, () => first.promise)
    await task.run('import', undefined, async () => {})
    first.finish()
    await running
    expect(hasActiveTasks()).toBe(false)
  })

  it('前の回の「やめて」は、次の回に持ち越さない', async () => {
    const task = exclusiveTask()
    await task.run(null, undefined, async () => { task.cancel() })
    expect(task.canceled).toBe(true)
    let seen: boolean | null = null
    await task.run(null, undefined, async () => { seen = task.canceled })
    expect(seen).toBe(false)
  })

  it('動いている間の「やめて」は、作業から見える', async () => {
    const task = exclusiveTask()
    const first = pending<void>()
    let seen: boolean | null = null
    const running = task.run(null, undefined, async () => { await first.promise; seen = task.canceled })
    task.cancel()
    first.finish()
    await running
    expect(seen).toBe(true)
  })
})
