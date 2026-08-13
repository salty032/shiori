import { describe, expect, it, vi } from 'vitest'
import { logBitrateDiag, parseCaptureDiag, recordedSize, summarizeSupply, type CaptureDiag } from './capture-diag'

// 補助項目が全て「取れなかった」状態の診断。各テストは見たい項目だけを上書きする。
const zeroDiag: CaptureDiag = {
  callbacks: 0, presented: 0, skippedByCallback: 0, duplicateSuppressed: 0,
  captureTimeMissing: null, clockSkewMs: null, totalVideoFrames: null, droppedVideoFrames: null,
  tickerTicks: null, videoBitsPerSecond: null,
  streamWidth: null, streamHeight: null, cropWidth: null, cropHeight: null
}

// 一定間隔で供給された想定の drawnAt を作る（epoch ミリ秒）。
function evenlySpaced(count: number, gapMs: number, start = 1_700_000_000_000): number[] {
  return Array.from({ length: count }, (_, i) => start + i * gapMs)
}

describe('summarizeSupply（供給間隔の要約）', () => {
  it('標本が1枚以下・尺が0なら要約しない', () => {
    expect(summarizeSupply([], 5, 41.7)).toBeNull()
    expect(summarizeSupply([1000], 5, 41.7)).toBeNull()
    expect(summarizeSupply(evenlySpaced(10, 30), 0, 41.7)).toBeNull()
  })

  it('毎秒の供給枚数は「枚数 ÷ 尺」', () => {
    // 5秒で 170 枚 = 34枚/秒（実測レンジの代表値）
    const summary = summarizeSupply(evenlySpaced(170, 29.4), 5, null)
    expect(summary?.drawnPerSec).toBeCloseTo(34, 5)
  })

  it('間隔の中央値・p95・最大を出す', () => {
    // 30ms 間隔の中に 1 回だけ 120ms の谷を混ぜる
    const drawn = evenlySpaced(50, 30)
    for (let i = 25; i < drawn.length; i++) drawn[i] += 90
    const summary = summarizeSupply(drawn, 2, null)
    expect(summary?.medianGapMs).toBe(30)
    expect(summary?.maxGapMs).toBe(120)
  })

  it('素材のコマ1つより長く空いた回数を数える（撮り逃しが起きうる箇所）', () => {
    // 24fps 素材の周期 41.7ms に対し、通常 30ms・谷が 3 回
    const drawn = evenlySpaced(40, 30)
    for (const at of [10, 20, 30]) {
      for (let i = at; i < drawn.length; i++) drawn[i] += 50
    }
    expect(summarizeSupply(drawn, 2, 41.7)?.longGaps).toBe(3)
  })

  it('素材の周期が不明なら longGaps は出さない（推測で数字を作らない）', () => {
    expect(summarizeSupply(evenlySpaced(40, 30), 2, null)?.longGaps).toBeNull()
  })

  it('時刻が逆行した標本は捨てる（captureTime と Date.now() の混在対策）', () => {
    // 3枚目だけ過去へ飛ぶ。負の間隔をそのまま数えると中央値・最小が壊れる
    const drawn = [1000, 1030, 900, 1090]
    const summary = summarizeSupply(drawn, 1, null)
    expect(summary?.maxGapMs).toBe(190)
    expect(summary?.medianGapMs).toBeGreaterThan(0)
  })
})

// 「素材のコマ 1 つに何ビット割けたか」がビットレートを決める唯一の指標なので、
// その算出だけは固定しておく（素材 fps をまたいで比べられるのはこの値だけ）。
describe('logBitrateDiag（画質の判断に使う実測値）', () => {
  function captureLog(fn: () => void): string {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      fn()
      return spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    } finally {
      spy.mockRestore()
    }
  }

  it('素材のコマ数で割った 1 コマあたりのビット数を出す', () => {
    // 30MB / 30秒 = 8Mbps。素材のコマが 720（24fps × 30秒）なら 1 コマ 333kbit。
    const line = captureLog(() => logBitrateDiag(30_000_000, 30, 720, 23.976, null))
    expect(line).toContain('actual 8.0Mbps')
    expect(line).toContain('per source frame 333kbit')
  })

  it('同じビットレートでも素材のコマが多いほど 1 コマあたりは薄くなる', () => {
    // 同じ 30MB でも 60fps 素材（1800 コマ）なら 1 コマ 133kbit。**これが今の設計の問題点**で、
    // 条件の厳しい 60fps 側に薄く配っていることがこの 1 行で見える。
    const line = captureLog(() => logBitrateDiag(30_000_000, 30, 1800, 59.94, null))
    expect(line).toContain('per source frame 133kbit')
  })

  it('素材のコマ表が無ければ 1 コマあたりを出さない（ファイルのフレーム数で代用しない）', () => {
    const line = captureLog(() => logBitrateDiag(30_000_000, 30, null, null, null))
    expect(line).toContain('per source frame n/a')
  })

  // 記録画素数はプレーヤーの動画領域そのものなので、全画面かウィンドウかで何倍も動く。
  // 1 コマあたりのビット数だけを見ていると、同じ数字が別の画質を指す。
  it('同じ 1 コマあたりでも、記録画素数が違えば 1 画素あたりは違う', () => {
    const sized = (w: number, h: number): CaptureDiag =>
      ({ ...zeroDiag, cropWidth: w, cropHeight: h })
    // どちらも 1 コマ 333kbit。1920x1080 なら 161mbit/画素、1280x720 なら 362mbit/画素。
    const full = captureLog(() => logBitrateDiag(30_000_000, 30, 720, 23.976, sized(1920, 1080)))
    const small = captureLog(() => logBitrateDiag(30_000_000, 30, 720, 23.976, sized(1280, 720)))
    expect(full).toContain('recorded 1920x1080')
    expect(full).toContain('per source frame 333kbit, per pixel 161mbit')
    expect(small).toContain('per source frame 333kbit, per pixel 362mbit')
  })

  it('画素数が分からない録画では 1 画素あたりを出さない（推定で埋めない）', () => {
    const line = captureLog(() => logBitrateDiag(30_000_000, 30, 720, 23.976, zeroDiag))
    expect(line).toContain('recorded n/a')
    expect(line).toContain('per pixel n/a')
  })

  // ストリームが画面より小さいと、他のどの数字にも現れないまま画質だけが落ちる
  // （クロップ計算が DPR として吸収してしまうため）。食い違うときだけ言う。
  it('キャプチャが画面より小さいストリームを返していたら並べて出す', () => {
    const diag: CaptureDiag = { ...zeroDiag, streamWidth: 1920, streamHeight: 1080, cropWidth: 1280, cropHeight: 720 }
    const shrunk = captureLog(() => logBitrateDiag(30_000_000, 30, 720, 23.976, diag, { width: 2560, height: 1440 }))
    expect(shrunk).toContain('stream 1920x1080 != screen 2560x1440')

    const exact = captureLog(() => logBitrateDiag(30_000_000, 30, 720, 23.976, diag, { width: 1920, height: 1080 }))
    expect(exact).toContain('stream 1920x1080)')
    expect(exact).not.toContain('!= screen')
  })
})

describe('recordedSize（DB へ入れる記録画素数）', () => {
  it('診断が壊れている・0 なら記録しない（間違った母数を入れるより空欄）', () => {
    expect(recordedSize(null)).toBeNull()
    expect(recordedSize(zeroDiag)).toBeNull()
    expect(recordedSize({ ...zeroDiag, cropWidth: 1920, cropHeight: 0 })).toBeNull()
  })

  it('取れていれば整数で返す', () => {
    expect(recordedSize({ ...zeroDiag, cropWidth: 1919.6, cropHeight: 1080 })).toEqual({ width: 1920, height: 1080 })
  })
})

describe('parseCaptureDiag（レコーダーから届く診断値の検証）', () => {
  const valid = {
    callbacks: 1200,
    presented: 1210,
    skippedByCallback: 10,
    duplicateSuppressed: 96,
    captureTimeMissing: 0,
    clockSkewMs: -12.5,
    totalVideoFrames: 1400,
    droppedVideoFrames: 3,
    tickerTicks: 3600,
    videoBitsPerSecond: 12_000_000,
    streamWidth: 2560,
    streamHeight: 1440,
    cropWidth: 1920,
    cropHeight: 1080
  }

  it('正常な値はそのまま通す', () => {
    expect(parseCaptureDiag(valid)).toEqual(valid)
  })

  it('getVideoPlaybackQuality が無い環境（null）でも受け入れる', () => {
    const diag = parseCaptureDiag({ ...valid, totalVideoFrames: null, droppedVideoFrames: undefined })
    expect(diag?.totalVideoFrames).toBeNull()
    expect(diag?.droppedVideoFrames).toBeNull()
  })

  it('captureTime の計数が欠けていても診断ごとは捨てない（補助項目）', () => {
    // 対応付けの前提を確かめるための追加項目で、これが無くても供給の診断は成立する。
    const diag = parseCaptureDiag({ ...valid, captureTimeMissing: undefined })
    expect(diag).not.toBeNull()
    expect(diag?.captureTimeMissing).toBeNull()
    expect(diag?.callbacks).toBe(1200)
  })

  it('時計のずれが欠けていても診断ごとは捨てない（補助項目）', () => {
    // オフセットが振れる理由の切り分け用で、これが無くても供給の診断は成立する。
    const diag = parseCaptureDiag({ ...valid, clockSkewMs: undefined })
    expect(diag).not.toBeNull()
    expect(diag?.clockSkewMs).toBeNull()
  })

  it('必須の計数が欠けている・数値でないなら診断なしとして扱う', () => {
    expect(parseCaptureDiag(null)).toBeNull()
    expect(parseCaptureDiag('diag')).toBeNull()
    expect(parseCaptureDiag({ ...valid, callbacks: undefined })).toBeNull()
    expect(parseCaptureDiag({ ...valid, presented: 'many' })).toBeNull()
    expect(parseCaptureDiag({ ...valid, skippedByCallback: NaN })).toBeNull()
  })
})
