import { describe, expect, it } from 'vitest'
import { contentJs, extractFunction } from './extension-source'

// extension/content.js の「どこを撮るか」を決める幾何計算の回帰テスト。
//
// **外すと黒帯が写るか、映像の端が切れる。** どちらも画面には出るが、少しずれた程度では
// 気づきにくく、コマ送りで見比べて初めて分かる。純関数なのでここで固定できる。
//
// 読み込みと切り出しは extension-source.ts（content.js は import できないため）。
// window / document / location / getComputedStyle はスタブを注入して評価する。

interface Rect { left: number; top: number; width: number; height: number; right: number; bottom: number }

function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

interface FakeVideo { videoWidth: number; videoHeight: number }

const src = `
${extractFunction(contentJs, 'videoContentRect')}
${extractFunction(contentJs, 'primeVideoSurfaceRect')}
${extractFunction(contentJs, 'isFullscreenVideoRect')}
${extractFunction(contentJs, 'captureRectForVideo')}
return { videoContentRect, isFullscreenVideoRect, captureRectForVideo }
`

interface Env {
  /** 画面（ビューポート）の大きさ */
  viewport?: { width: number; height: number }
  objectFit?: string
  host?: string
  /** 全画面表示中か */
  fullscreen?: boolean
  /** Prime Video の描画面（複数あれば大きいものが選ばれる） */
  surfaces?: Rect[]
}

function load(env: Env = {}) {
  const viewport = env.viewport ?? { width: 1920, height: 1080 }
  const document = {
    fullscreenElement: env.fullscreen ? {} : null,
    querySelectorAll: (sel: string) =>
      sel.includes('atvwebplayersdk-video-surface')
        ? (env.surfaces ?? []).map((r) => ({ getBoundingClientRect: () => r }))
        : [],
  }
  return new Function('window', 'document', 'location', 'getComputedStyle', src)(
    { innerWidth: viewport.width, innerHeight: viewport.height },
    document,
    { hostname: env.host ?? 'example.com' },
    () => ({ objectFit: env.objectFit ?? 'contain' })
  ) as {
    videoContentRect(video: FakeVideo, r: Rect): Rect
    isFullscreenVideoRect(video: FakeVideo | null, r: Rect | null): boolean
    captureRectForVideo(video: FakeVideo, r: Rect): Rect
  }
}

describe('videoContentRect - 黒帯を除いて映像そのものの範囲を返す', () => {
  const fn = load().videoContentRect

  it('プレーヤーと映像の縦横比が同じなら、そのまま使う', () => {
    const r = rect(0, 0, 1600, 900)
    expect(fn({ videoWidth: 1920, videoHeight: 1080 }, r)).toBe(r)
  })

  // 16:9 の映像を 4:3 の枠に入れると上下が余る。そこを削らないと黒帯が写る。
  it('映像が横長なら、上下の黒帯を除く', () => {
    const out = fn({ videoWidth: 1920, videoHeight: 1080 }, rect(0, 0, 1600, 1200))
    expect(out).toEqual({ left: 0, top: 150, width: 1600, height: 900 })
  })

  // dアニメストア等で起きる形。左右が余る。
  it('映像が縦長なら、左右の黒帯を除く', () => {
    const out = fn({ videoWidth: 1440, videoHeight: 1080 }, rect(0, 0, 1600, 900))
    expect(out).toEqual({ left: 200, top: 0, width: 1200, height: 900 })
  })

  // 比率のわずかな差は端数の揺らぎ。ここで切ると、毎回 1px ずつ違う範囲を撮ることになる。
  it('縦横比の差がごく僅かなら切らない', () => {
    const r = rect(0, 0, 1600, 901)
    expect(fn({ videoWidth: 1920, videoHeight: 1080 }, r)).toBe(r)
  })

  // cover / fill は枠いっぱいに引き伸ばす指定なので、そもそも黒帯が無い。
  it('objectFit が cover / fill なら枠全体を使う', () => {
    const r = rect(0, 0, 1600, 1200)
    expect(load({ objectFit: 'cover' }).videoContentRect({ videoWidth: 1920, videoHeight: 1080 }, r)).toBe(r)
    expect(load({ objectFit: 'fill' }).videoContentRect({ videoWidth: 1920, videoHeight: 1080 }, r)).toBe(r)
  })

  // メタデータ読み込み前は 0。比率が分からないので枠のまま渡す（推測で切らない）。
  it('映像の画素数がまだ分からなければ枠のまま返す', () => {
    const r = rect(0, 0, 1600, 1200)
    expect(fn({ videoWidth: 0, videoHeight: 0 }, r)).toBe(r)
  })
})

describe('isFullscreenVideoRect - 画面いっぱいに広がっているか', () => {
  const fn = load().isFullscreenVideoRect

  it('四辺が画面の端に達していれば全画面とみなす', () => {
    expect(fn({ videoWidth: 1920, videoHeight: 1080 }, rect(0, 0, 1920, 1080))).toBe(true)
  })

  // 端から 2px までは許容する（ブラウザの端数で 1px ずれることがある）。
  it('2px までのずれは許容する', () => {
    expect(fn({ videoWidth: 1920, videoHeight: 1080 }, rect(2, 2, 1916, 1076))).toBe(true)
  })

  it('少しでも内側に収まっていれば全画面ではない', () => {
    expect(fn({ videoWidth: 1920, videoHeight: 1080 }, rect(3, 0, 1917, 1080))).toBe(false)
    expect(fn({ videoWidth: 1920, videoHeight: 1080 }, rect(0, 0, 1900, 1080))).toBe(false)
  })

  it('映像も矩形も無ければ false', () => {
    expect(fn(null, rect(0, 0, 1920, 1080))).toBe(false)
    expect(fn({ videoWidth: 1920, videoHeight: 1080 }, null)).toBe(false)
  })
})

describe('captureRectForVideo - 実際に撮る範囲', () => {
  it('通常は黒帯を除いた映像の範囲をそのまま使う', () => {
    const out = load().captureRectForVideo({ videoWidth: 1920, videoHeight: 1080 }, rect(0, 0, 1600, 1200))
    expect(out).toEqual({ left: 0, top: 150, width: 1600, height: 900 })
  })

  // 潰れた矩形（プレーヤーが 0 幅の要素を返す）を画面全体へ逃がす分岐が書いてあるが、
  // **現状その条件は成立しない。** 逃げ道は「四辺が画面の端に届いている」かつ「幅か高さが
  // 10px 以下」を両方求めるところ、四辺が端に届くには right >= 画面幅 - 2 が要る。幅 10px の
  // 矩形で left <= 2 なら right は最大 12 なので、**画面幅が 14px 以下でないと通らない。**
  //
  // ここでは現状の動きを固定しておく（黙って直すと、逃げ道が要る場面を実機で見たときに
  // 「前から効いていたはず」と読み違える）。**直すかどうかは、その場面を実機で見てから。**
  it('潰れた矩形は全画面とみなされないので、逃げ道は働かない（現状）', () => {
    const r = rect(0, 0, 1920, 4)
    const out = load({ viewport: { width: 1920, height: 1080 } }).captureRectForVideo({ videoWidth: 0, videoHeight: 0 }, r)
    expect(out).toBe(r)
  })

  it('逃げ道が通るのは、画面そのものが矩形と同じくらい小さいときだけ', () => {
    const out = load({ viewport: { width: 10, height: 10 } })
      .captureRectForVideo({ videoWidth: 0, videoHeight: 0 }, rect(0, 0, 10, 8))
    expect(out).toEqual({ left: 0, top: 0, width: 10, height: 10 })
  })

  // Prime Video は全画面時にコンテナの矩形と実際の描画域がずれる。描画面が見つかっていて、
  // 全画面で、まだ画素数も取れていない場面だけビューポート全体を使う。
  describe('Prime Video', () => {
    const surfaces = [rect(0, 0, 800, 450), rect(0, 0, 1600, 900)]

    it('全画面かつ画素数が取れていないときは画面全体を使う', () => {
      const out = load({ host: 'primevideo.com', fullscreen: true, surfaces })
        .captureRectForVideo({ videoWidth: 0, videoHeight: 0 }, rect(0, 0, 300, 200))
      expect(out).toEqual({ left: 0, top: 0, width: 1920, height: 1080 })
    })

    // 画素数が取れていれば描画面を探しにいかない（通常の経路と同じ扱いになる）。
    it('画素数が取れていれば、渡された矩形の方を使う', () => {
      const r = rect(0, 0, 1600, 900)
      const out = load({ host: 'primevideo.com', fullscreen: true, surfaces })
        .captureRectForVideo({ videoWidth: 1920, videoHeight: 1080 }, r)
      expect(out).toBe(r)
    })

    // 全画面でなければ描画面をそのまま使う。複数あるときは面積が最大のものを採る。
    it('全画面でなければ、最も大きい描画面を使う', () => {
      const out = load({ host: 'primevideo.com', surfaces })
        .captureRectForVideo({ videoWidth: 0, videoHeight: 0 }, rect(0, 0, 300, 200))
      expect(out).toEqual(surfaces[1])
    })

    it('他のサービスでは描画面を探さない', () => {
      const r = rect(0, 0, 300, 200)
      const out = load({ host: 'example.com', fullscreen: true, surfaces }).captureRectForVideo({ videoWidth: 0, videoHeight: 0 }, r)
      expect(out).toBe(r)
    })
  })
})
