import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { spawn } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import ffmpegStatic from 'ffmpeg-static'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn().mockReturnValue(tmpdir()) } }))

import { trimWebm, getVideoDuration } from './ffmpeg'

function runFfmpegSync(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegStatic as string, args, { stdio: 'ignore' })
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))))
    proc.on('error', reject)
  })
}

describe('trimWebm', () => {
  let dir: string
  let srcPath: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shiori-ffmpeg-test-'))
    srcPath = join(dir, 'src.webm')
    // 10秒の testsrc ソース（video-edit.ts の実測手順と同一条件）
    await runFfmpegSync([
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=10:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-c:v', 'libvpx', '-c:a', 'libopus',
      srcPath
    ])
  }, 30_000)

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('IN=6/OUT=8 で切り出すと Duration が約2秒になる（preSeek適用時の回帰防止）', async () => {
    const outPath = join(dir, 'out.webm')
    await trimWebm(srcPath, outPath, 6, 8)
    const duration = await getVideoDuration(outPath)
    expect(duration).not.toBeNull()
    expect(duration as number).toBeGreaterThan(1.5)
    expect(duration as number).toBeLessThan(2.5)
  }, 30_000)

  it('IN=1/OUT=3（preSeek=0）でも Duration が約2秒になる', async () => {
    const outPath = join(dir, 'out-short.webm')
    await trimWebm(srcPath, outPath, 1, 3)
    const duration = await getVideoDuration(outPath)
    expect(duration).not.toBeNull()
    expect(duration as number).toBeGreaterThan(1.5)
    expect(duration as number).toBeLessThan(2.5)
  }, 30_000)
})
