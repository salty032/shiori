// getDisplayMedia のソース決定（main 側の setDisplayMediaRequestHandler）。
//
// ここで「一致しなければ先頭の画面」に落とすと、画面が複数ある環境で別のモニターを
// 丸ごと録った動画が、他と見分けの付かない形でライブラリに並ぶ（撮り直しも効かない）。
// 空で返した場合はレンダラーが getUserMedia + chromeMediaSourceId の退避経路へ回るので、
// 「拒否しても録画は失われない」ことが前提になっている（recorder.ts の acquireScreenStream）。
import { describe, expect, it, vi, beforeEach } from 'vitest'

type DisplayMediaCallback = (streams: { video?: unknown; audio?: string }) => void
let requestHandler: ((request: unknown, callback: DisplayMediaCallback) => void) | null = null

const getSources = vi.fn(async () => [] as { id: string; display_id: string }[])

vi.mock('electron', () => ({
  app: { isPackaged: true },
  desktopCapturer: { getSources: (...args: unknown[]) => getSources(...(args as [])) },
  BrowserWindow: class {
    webContents = {
      id: 1,
      session: {
        setDisplayMediaRequestHandler: (h: (request: unknown, callback: DisplayMediaCallback) => void) => {
          requestHandler = h
        }
      },
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    }
    on = vi.fn()
    loadFile = vi.fn()
    loadURL = vi.fn()
    isDestroyed = (): boolean => false
  }
}))

vi.mock('../system/windows', () => ({ isAllowedDevRendererUrl: vi.fn(() => false) }))

import { createRecorderWindow, setPendingDisplaySource } from './recorder-window'

async function resolveSource(): Promise<{ video?: unknown; audio?: string }> {
  return new Promise((resolve) => { requestHandler!({}, resolve) })
}

describe('setDisplayMediaRequestHandler: 録画する画面の固定', () => {
  beforeEach(() => {
    requestHandler = null
    getSources.mockReset()
    createRecorderWindow()
    expect(requestHandler).not.toBeNull()
  })

  it('預けた ID の画面をそのまま使う', async () => {
    const screen1 = { id: 'screen:1:0', display_id: '1' }
    const screen2 = { id: 'screen:2:0', display_id: '2' }
    getSources.mockResolvedValue([screen1, screen2])
    setPendingDisplaySource('screen:2:0')

    expect(await resolveSource()).toEqual({ video: screen2, audio: 'loopback' })
  })

  it('預けた ID が見つからないとき、別の画面を代わりに録らない', async () => {
    // 列挙の間にモニターを抜き差しした・DPI 変更で ID が振り直された場合。
    getSources.mockResolvedValue([{ id: 'screen:9:0', display_id: '9' }])
    setPendingDisplaySource('screen:2:0')

    // 空 = 退避経路（chromeMediaSourceId 指定）へ回す。録画自体は失われない。
    expect(await resolveSource()).toEqual({})
  })

  it('画面を 1 つも列挙できないときも空で返す', async () => {
    getSources.mockResolvedValue([])
    setPendingDisplaySource('screen:2:0')

    expect(await resolveSource()).toEqual({})
  })

  it('列挙自体が失敗しても例外を投げず空で返す', async () => {
    getSources.mockRejectedValue(new Error('enumeration failed'))
    setPendingDisplaySource('screen:2:0')

    expect(await resolveSource()).toEqual({})
  })
})
