import { siteName } from './utils'

// サービス（配信サイト）ごとの表示色。serviceColor のフォールバック付きで参照する。
const SERVICE_COLORS: Record<string, string> = {
  YouTube: '#ff5a5f',
  Netflix: '#e85d75',
  'Prime Video': '#49b6ff',
  'Disney+': '#6aa8ff',
  ABEMA: '#65d17a',
  'U-NEXT': '#35d0c3',
  niconico: '#b8a4ff',
  'DMM TV': '#f2a65a',
  'dアニメストア': '#f4d35e',
}

// host（例: youtube.com）→ 表示名（例: YouTube）。未知ホストは host をそのまま返す。
export function serviceLabel(host: string): string {
  return siteName(`https://${host}`) ?? host
}

// host → 表示色。未知サービスは中立色にフォールバック。
export function serviceColor(host: string): string {
  return SERVICE_COLORS[serviceLabel(host)] ?? '#9ea5ff'
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return null
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

// #rrggbb を rgba(...) に変換して不透明度 a を付与する。パース不能ならそのまま返す。
export function alpha(hex: string, a: number): string {
  const rgb = hexToRgb(hex)
  return rgb ? `rgba(${rgb.r},${rgb.g},${rgb.b},${a})` : hex
}
