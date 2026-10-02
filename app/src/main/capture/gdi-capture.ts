// 静止画の撮影に使う、GDI の BitBlt による画面コピー（Windows のみ）。
//
// **desktopCapturer より先にこちらを使う理由は速さだけ。** desktopCapturer は呼ぶたびに
// 全モニターの画面共有を開始して 1 枚もらって終える作りで、縮小サイズを 1x1 にしても
// 1 回約 350ms かかる（固定の手間）。BitBlt は今の画面の画素をその場でコピーするだけで
// 約 20ms。撮った画素は desktopCapturer と一致することを実画面で確かめてある
// （等倍・縮小表示のアニメ画像、1 画素おきの色模様。2026-10-02）。
//
// 動画として流し続けて 1 コマ取る方式は却下した——色が 2x2 画素ごとに間引かれ
// （YUV 4:2:0）、細い色の線がにじむ。
//
// 失敗したら null を返し、呼び出し側が desktopCapturer に戻る。黒く写った場合の撮り直しも
// 呼び出し側（capture.ts）が持つ。BitBlt だけが黒くなる環境は知られていないが、
// 配布先で確かめられないため。
import { screen as electronScreen, nativeImage, type Display, type NativeImage } from 'electron'

const SRCCOPY = 0x00CC0020
// レイヤードウィンドウ（半透明の窓）も合成された状態で写す。desktopCapturer の写り方に揃える。
const CAPTUREBLT = 0x40000000

type GdiApi = {
  GetDC: (hwnd: null) => unknown
  ReleaseDC: (hwnd: null, hdc: unknown) => number
  CreateCompatibleDC: (hdc: unknown) => unknown
  CreateCompatibleBitmap: (hdc: unknown, w: number, h: number) => unknown
  SelectObject: (hdc: unknown, obj: unknown) => unknown
  BitBlt: (dst: unknown, x: number, y: number, w: number, h: number, src: unknown, sx: number, sy: number, rop: number) => boolean
  GetDIBits: (hdc: unknown, bmp: unknown, start: number, lines: number, bits: Buffer, bmi: Buffer, usage: number) => number
  DeleteObject: (obj: unknown) => boolean
  DeleteDC: (hdc: unknown) => boolean
}

// 読み込みに失敗した（koffi が無い・DLL が引けない）ら false を覚え、以後は試さない。
let api: GdiApi | false | null = null

function loadApi(): GdiApi | false {
  if (api !== null) return api
  if (process.platform !== 'win32') return (api = false)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    const gdi32 = koffi.load('gdi32.dll')
    api = {
      GetDC: user32.func('void* __stdcall GetDC(void* hwnd)'),
      ReleaseDC: user32.func('int __stdcall ReleaseDC(void* hwnd, void* hdc)'),
      CreateCompatibleDC: gdi32.func('void* __stdcall CreateCompatibleDC(void* hdc)'),
      CreateCompatibleBitmap: gdi32.func('void* __stdcall CreateCompatibleBitmap(void* hdc, int w, int h)'),
      SelectObject: gdi32.func('void* __stdcall SelectObject(void* hdc, void* obj)'),
      BitBlt: gdi32.func('bool __stdcall BitBlt(void* dst, int x, int y, int w, int h, void* src, int sx, int sy, uint32 rop)'),
      GetDIBits: gdi32.func('int __stdcall GetDIBits(void* hdc, void* bmp, uint32 start, uint32 lines, _Out_ uint8_t* bits, void* bmi, uint32 usage)'),
      DeleteObject: gdi32.func('bool __stdcall DeleteObject(void* obj)'),
      DeleteDC: gdi32.func('bool __stdcall DeleteDC(void* hdc)')
    }
  } catch (err) {
    console.warn('[capture] GDI capture unavailable, using desktopCapturer only', err)
    api = false
  }
  return api
}

// ディスプレイ 1 枚ぶんを、物理ピクセルの原寸で写す。desktopCapturer に
// thumbnailSize = size * scaleFactor を渡したときと同じ大きさになる。
export function captureDisplayGdi(display: Display): NativeImage | null {
  const gdi = loadApi()
  if (!gdi) return null
  // Electron のメインプロセスはモニターごとの DPI に対応しているので、GDI の座標は物理ピクセル。
  const r = electronScreen.dipToScreenRect(null, display.bounds)
  if (r.width <= 0 || r.height <= 0) return null

  const screenDc = gdi.GetDC(null)
  if (!screenDc) return null
  let memDc: unknown = null
  let bitmap: unknown = null
  let previous: unknown = null
  try {
    memDc = gdi.CreateCompatibleDC(screenDc)
    bitmap = memDc ? gdi.CreateCompatibleBitmap(screenDc, r.width, r.height) : null
    if (!memDc || !bitmap) return null
    previous = gdi.SelectObject(memDc, bitmap)
    if (!gdi.BitBlt(memDc, 0, 0, r.width, r.height, screenDc, r.x, r.y, SRCCOPY | CAPTUREBLT)) return null

    // BITMAPINFOHEADER: 高さを負にすると上から下の並びで返る。32bit の BGRA。
    const bmi = Buffer.alloc(44)
    bmi.writeUInt32LE(40, 0)
    bmi.writeInt32LE(r.width, 4)
    bmi.writeInt32LE(-r.height, 8)
    bmi.writeUInt16LE(1, 12)
    bmi.writeUInt16LE(32, 14)
    const pixels = Buffer.alloc(r.width * r.height * 4)
    if (gdi.GetDIBits(memDc, bitmap, 0, r.height, pixels, bmi, 0) !== r.height) return null
    // GDI は 4 バイト目（アルファ）を 0 で返す。そのままだと透明な画像として扱われる。
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255
    const image = nativeImage.createFromBitmap(pixels, { width: r.width, height: r.height })
    return image.isEmpty() ? null : image
  } catch (err) {
    console.warn('[capture] GDI capture failed', err)
    return null
  } finally {
    if (memDc && previous) gdi.SelectObject(memDc, previous)
    if (bitmap) gdi.DeleteObject(bitmap)
    if (memDc) gdi.DeleteDC(memDc)
    gdi.ReleaseDC(null, screenDc)
  }
}
