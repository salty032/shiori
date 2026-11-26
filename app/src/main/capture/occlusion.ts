// 撮る直前に、動画の上に別のウィンドウが重なっていないかを Windows に尋ねる。
//
// **ホットキーの誤作動で、ブラウザを隠している別のウィンドウが写った画像が保存されていた。** 撮影は
// 「動画があった位置の画面」を写すので、ブラウザが後ろにあっても、拡張が返事をすれば撮れてしまう。
// 「動画のタブが前面のときだけ撮る」は却下（モニター 2 枚で、片方の動画を流しながらもう片方の
// アプリを触っているときに撮れなくなる）。前面かではなく、動画が見えているかで決める。
//
// 動画の中の 5 点（真ん中と四隅の内側）で、いちばん手前のウィンドウ（の一番上の親）を調べ、
// 拡張が知らせたブラウザのウィンドウと位置・大きさが合わないものが 1 つでもあれば重なっているとみなす。
// ブラウザ自身のポップアップ（メニュー等）も別のウィンドウなので、重なっていれば撮らない（写るため）。
//
// 調べられなかったとき（koffi が無い・Windows 以外）は null を返し、呼び出し側は今までどおり撮る。
import { screen as electronScreen } from 'electron'

type Rect = { x: number; y: number; width: number; height: number }

type Api = {
  WindowFromPoint: (pt: { x: number; y: number }) => unknown
  GetAncestor: (hwnd: unknown, flags: number) => unknown
  GetWindowRect: (hwnd: unknown, rect: { left?: number; top?: number; right?: number; bottom?: number }) => boolean
}

const GA_ROOT = 2
// 位置・大きさが合うとみなす幅（DIP）。拡張の outerWidth と Windows の枠（見えないリサイズ枠を含む）の数え方の差を吸収する。
// 2026-11-26、100% の画面で最大化した Chrome は拡張が幅 1920・高さ 1032、Windows が 1936・1048 で差がちょうど 16 だった。
// 16 だと倍率やブラウザの違いで超え、隠れていないのに撮れなくなるので倍にしてある。ブラウザとほぼ同じ位置・大きさの
// 別のウィンドウが動画を覆うことはまず無い。
const MATCH_TOLERANCE_DIP = 32
// 四隅は動画の端から内側へこの割合だけ入れて調べる（枠ぎりぎりはブラウザの縁と区別しにくい）。
const CORNER_INSET_RATIO = 0.1

let api: Api | false | null = null

function loadApi(): Api | false {
  if (api !== null) return api
  if (process.platform !== 'win32') return (api = false)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    koffi.struct('SHIORI_POINT', { x: 'long', y: 'long' })
    koffi.struct('SHIORI_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
    api = {
      WindowFromPoint: user32.func('void* __stdcall WindowFromPoint(SHIORI_POINT pt)'),
      GetAncestor: user32.func('void* __stdcall GetAncestor(void* hwnd, uint32 flags)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(void* hwnd, _Out_ SHIORI_RECT* rect)'),
    }
  } catch (err) {
    console.warn('[capture] occlusion check unavailable', err)
    api = false
  }
  return api
}

export function samplePoints(video: Rect): { x: number; y: number }[] {
  const ix = video.width * CORNER_INSET_RATIO
  const iy = video.height * CORNER_INSET_RATIO
  const l = video.x + ix, r = video.x + video.width - ix
  const t = video.y + iy, b = video.y + video.height - iy
  return [
    { x: video.x + video.width / 2, y: video.y + video.height / 2 },
    { x: l, y: t }, { x: r, y: t }, { x: l, y: b }, { x: r, y: b },
  ].map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
}

export function sameRect(a: Rect, b: Rect, tolerance = MATCH_TOLERANCE_DIP): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
    && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance
}

// 動画（DIP）の上に、ブラウザ（DIP）以外のウィンドウが重なっているか。調べられなければ null。
export function isVideoCovered(video: Rect, browser: Rect): boolean | null {
  const a = loadApi()
  if (!a) return null
  try {
    for (const dip of samplePoints(video)) {
      const physical = electronScreen.dipToScreenPoint(dip)
      const hit = a.WindowFromPoint({ x: Math.round(physical.x), y: Math.round(physical.y) })
      if (!hit) return true
      const root = a.GetAncestor(hit, GA_ROOT) ?? hit
      const r: { left?: number; top?: number; right?: number; bottom?: number } = {}
      if (!a.GetWindowRect(root, r)) return null
      const rootDip = electronScreen.screenToDipRect(null, {
        x: r.left ?? 0, y: r.top ?? 0, width: (r.right ?? 0) - (r.left ?? 0), height: (r.bottom ?? 0) - (r.top ?? 0),
      })
      if (!sameRect(rootDip, browser)) {
        console.log(`[capture] video covered at ${dip.x},${dip.y}: window ${JSON.stringify(rootDip)} vs browser ${JSON.stringify(browser)}`)
        return true
      }
    }
    return false
  } catch (err) {
    console.warn('[capture] occlusion check failed', err)
    return null
  }
}
