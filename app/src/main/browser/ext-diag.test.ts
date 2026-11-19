import { beforeEach, describe, expect, it, vi } from 'vitest'

// 拡張が黙って壊れたことに気づくためのログ。**目印（diag-log.on）のある PC でだけ**、サービスごとに 1 回残す。
let enabled = true
vi.mock('../system/diag-log', () => ({ diagLogEnabled: () => enabled }))

beforeEach(() => { vi.resetModules(); enabled = true })

describe('ext-diag', () => {
  it('作品名が空で撮れたら、サービス名を添えて 1 行残す（同じサービスは 1 回だけ）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { noteMissingTitle } = await import('./ext-diag')
    noteMissingTitle('https://www.youtube.com/watch?v=x', 'capture')
    noteMissingTitle('https://www.youtube.com/watch?v=y', 'clip')
    noteMissingTitle('https://tv.dmm.com/vod/playback/', 'clip')
    expect(warn.mock.calls.map((c) => String(c[0]).split(':')[0])).toEqual(['[ext-diag] youtube.com', '[ext-diag] tv.dmm.com'])
    warn.mockRestore()
  })

  it('目印の無い PC では何も残さない', async () => {
    enabled = false
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { noteMissingTitle, notePlayerUiMissing } = await import('./ext-diag')
    noteMissingTitle('https://www.netflix.com/watch/1', 'clip')
    notePlayerUiMissing('netflix.com')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
