// キャプチャ画像からの主要色抽出。nativeImage のみに依存する純粋ユーティリティ。
import { nativeImage } from 'electron'
import { colorDist } from './db'

export function extractColors(imagePath: string, count = 5): string {
  try {
    const img = nativeImage.createFromPath(imagePath).resize({ width: 100, height: 100 })
    const buf = img.toBitmap()  // BGRA
    const freq = new Map<string, number>()
    for (let i = 0; i < 100 * 100; i++) {
      const b = buf[i * 4], g = buf[i * 4 + 1], r = buf[i * 4 + 2]
      if ((r + g + b) / 3 < 30 || (r + g + b) / 3 > 225) continue  // skip black/white
      if (Math.max(r, g, b) - Math.min(r, g, b) < 30) continue      // skip grays
      // 3-bit quantization (8 levels, step=36) — coarser than 4-bit to group similar colors
      const qr = Math.round(r / 36) * 36
      const qg = Math.round(g / 36) * 36
      const qb = Math.round(b / 36) * 36
      const hex = `#${qr.toString(16).padStart(2, '0')}${qg.toString(16).padStart(2, '0')}${qb.toString(16).padStart(2, '0')}`
      freq.set(hex, (freq.get(hex) ?? 0) + 1)
    }
    // Pick top colors ensuring visual distinctness (min RGB distance = 80)
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1])
    const result: string[] = []
    for (const [hex] of sorted) {
      if (result.length >= count) break
      if (!result.some(c => colorDist(hex, c) < 80)) result.push(hex)
    }
    return result.join(',')
  } catch { return '' }
}
