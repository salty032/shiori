import { describe, expect, it, vi } from 'vitest'
import { notifyUntilFixed } from './notify-until-fixed'

// ホットキーの「登録できませんでした」が、起動時と取り直しで二重に出ていた。
describe('notifyUntilFixed', () => {
  it('失敗が続く間は最初の 1 回だけ知らせる', () => {
    const send = vi.fn()
    const n = notifyUntilFixed(send)
    n.onError('a'); n.result(false)
    n.onError('a'); n.result(false)
    n.onError('a'); n.result(false)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('一度登録できたら、次の失敗はまた知らせる', () => {
    const send = vi.fn()
    const n = notifyUntilFixed(send)
    n.onError('a'); n.result(false)
    n.result(true)
    n.onError('b'); n.result(false)
    expect(send).toHaveBeenNthCalledWith(2, 'b')
  })
})
