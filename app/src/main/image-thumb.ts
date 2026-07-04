import { mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { nativeImage } from 'electron'

export async function createImageThumb(srcPath: string, thumbPath: string): Promise<void> {
  const img = nativeImage.createFromPath(srcPath)
  if (img.isEmpty()) throw new Error(`nativeImage: failed to load ${srcPath}`)
  const { width, height } = img.getSize()
  const targetW = 480
  const targetH = width > 0 ? Math.round(height * targetW / width) : 270
  const resized = img.resize({ width: targetW, height: targetH, quality: 'good' })
  await mkdir(dirname(thumbPath), { recursive: true })
  await writeFile(thumbPath, resized.toJPEG(85))
}
