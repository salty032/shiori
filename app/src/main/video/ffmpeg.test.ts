import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { spawn } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
// 同梱バイナリ（resources/ffmpeg.exe）を直接使う。ffmpeg.ts の未パッケージ時のパス解決が
// app.getAppPath() 基準なので、mock からも同じ場所を指させる。
const APP_ROOT = process.cwd()
const FFMPEG_BIN = join(APP_ROOT, 'resources', 'ffmpeg.exe')

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn().mockReturnValue(tmpdir()),
    getAppPath: vi.fn().mockReturnValue(process.cwd())
  }
}))

import { trimWebm, getVideoDuration, getVideoMeta, getFrameSignatures, getVideoFramePts, SIGNATURE_GRID } from './ffmpeg'
import { signaturesDiffer } from './frame-verify'

function runFfmpegSync(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { stdio: 'ignore' })
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

// 撮り逃したコマの検証（frame-verify.ts）が読む署名の取り出し。
// 判定ロジック自体は frame-verify.test.ts が持つので、ここでは「ffmpeg から意図した形で
// 取り出せているか」だけを実バイナリで確かめる。
describe('getFrameSignatures', () => {
  let dir: string
  let srcPath: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shiori-ffmpeg-sig-test-'))
    srcPath = join(dir, 'half.webm')
    // 前半1秒が黒・後半1秒が白の 20 フレーム。静止区間と切り替わりの両方を含む。
    await runFfmpegSync([
      '-y',
      '-f', 'lavfi', '-i', 'color=c=black:d=1:s=320x240:r=10',
      '-f', 'lavfi', '-i', 'color=c=white:d=1:s=320x240:r=10',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1',
      '-c:v', 'libvpx',
      srcPath
    ])
  }, 30_000)

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // 録画クリップは可変フレームレート。既定のままだと ffmpeg が一定フレームレートへ
  // 揃えるためにフレームを複製し、署名の添字がファイルのフレーム番号からずれる
  // （実際に踏んだ: 298 枚のクリップが 537 枚として読まれ、検証結果が丸ごと無意味になった）。
  // 一定フレームレートの素材では再現しないため、可変フレームレートのファイルで固定する。
  it('可変フレームレートでもフレームを複製しない（署名の添字がずれない）', async () => {
    const vfrPath = join(dir, 'vfr.webm')
    // 10fps の素材から中間4フレームを落とす＝タイムスタンプが飛んだ 16 枚のファイル
    await runFfmpegSync([
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-vf', "select='not(between(n,3,6))'",
      '-fps_mode', 'passthrough',
      '-c:v', 'libvpx',
      vfrPath
    ])
    const [sigs, pts] = await Promise.all([getFrameSignatures(vfrPath), getVideoFramePts(vfrPath)])
    expect(pts.length).toBe(16)
    expect(sigs.length).toBe(pts.length)
  }, 60_000)

  it('1フレームにつき 32x32 のグレースケール1枚を返す', async () => {
    const sigs = await getFrameSignatures(srcPath)
    expect(sigs.length).toBeGreaterThan(0)
    expect(sigs[0].length).toBe(SIGNATURE_GRID * SIGNATURE_GRID)
  }, 60_000)

  // フレーム表の frameIndex は「ファイル内の何枚目か」なので、署名の添字がそれとずれると
  // 別のコマの絵を比べて判定することになる。両者が同じデコード結果を数えていることを固定する。
  it('署名の枚数が PTS の数と一致する（フレーム表の添字と揃う）', async () => {
    const [sigs, pts] = await Promise.all([getFrameSignatures(srcPath), getVideoFramePts(srcPath)])
    expect(sigs.length).toBe(pts.length)
  }, 60_000)

  it('静止区間では変化を検出せず、切り替わりだけを検出する', async () => {
    const sigs = await getFrameSignatures(srcPath)
    const changes: number[] = []
    for (let i = 1; i < sigs.length; i++) {
      if (signaturesDiffer(sigs[i - 1], sigs[i])) changes.push(i)
    }
    // 黒→白の1回だけ。静止している 9 フレームぶんの隣接比較は全て「変化なし」になる。
    expect(changes).toHaveLength(1)
    expect(changes[0]).toBe(Math.floor(sigs.length / 2))
  }, 60_000)

  it('存在しないファイルでは失敗する（黙って空を返して未検証扱いに化けさせない）', async () => {
    await expect(getFrameSignatures(join(dir, 'does-not-exist.webm'))).rejects.toThrow()
  }, 30_000)
})

describe('getVideoMeta', () => {
  let dir: string
  let srcPath: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shiori-ffmpeg-meta-test-'))
    srcPath = join(dir, 'src10fps.webm')
    // rate=10 の testsrc から fps を実際に抽出できることを確認する（stream 行の
    // "NN fps" 表記。tbr へのフォールバックはしない仕様なので、素材の fps とタイムベース
    // が一致するこの単純なケースでは両者が同値になり、フォールバック有無の違いは
    // このテストだけでは切り分けられない点に留意）。
    await runFfmpegSync([
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-c:v', 'libvpx',
      srcPath
    ])
  }, 30_000)

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('duration と fps を同じ実行から取得する', async () => {
    const meta = await getVideoMeta(srcPath)
    expect(meta.duration).not.toBeNull()
    expect(meta.duration as number).toBeGreaterThan(1.5)
    expect(meta.duration as number).toBeLessThan(2.5)
    expect(meta.fps).not.toBeNull()
    expect(meta.fps as number).toBeCloseTo(10, 0)
  }, 30_000)

  it('存在しないファイルでは duration・fps とも null', async () => {
    const meta = await getVideoMeta(join(dir, 'does-not-exist.webm'))
    expect(meta.duration).toBeNull()
    expect(meta.fps).toBeNull()
  }, 30_000)
})
