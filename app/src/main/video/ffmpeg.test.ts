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

import { trimWebm, getVideoDuration, getVideoMeta, getFrameSignatures, getVideoFramePts, transcodeToH264, h264Args, h264Bitrate, SIGNATURE_GRID } from './ffmpeg'
import { signaturesDiffer } from './frame-verify'

function runFfmpegSync(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { stdio: 'ignore' })
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))))
    proc.on('error', reject)
  })
}


// ffmpeg の -i だけを走らせて stderr を読む。出力の縦横は Stream 行にしか出ないので、
// 「奇数のまま削られていないか」を見るのに要る。
function probeStderr(path: string): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, ['-hide_banner', '-i', path], { stdio: ['ignore', 'ignore', 'pipe'] })
    let out = ''
    proc.stderr?.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', () => resolve({ stderr: out }))
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
    const [{ signatures }, pts] = await Promise.all([getFrameSignatures(vfrPath), getVideoFramePts(vfrPath)])
    expect(pts.length).toBe(16)
    expect(signatures.length).toBe(pts.length)
  }, 60_000)

  it('1フレームにつき 32x32 のグレースケール1枚を返す', async () => {
    const { signatures } = await getFrameSignatures(srcPath)
    expect(signatures.length).toBeGreaterThan(0)
    expect(signatures[0].length).toBe(SIGNATURE_GRID * SIGNATURE_GRID)
  }, 60_000)

  // フレーム表の frameIndex は「ファイル内の何枚目か」なので、署名の添字がそれとずれると
  // 別のコマの絵を比べて判定することになる。両者が同じデコード結果を数えていることを固定する。
  it('署名の枚数が PTS の数と一致する（フレーム表の添字と揃う）', async () => {
    const [{ signatures }, pts] = await Promise.all([getFrameSignatures(srcPath), getVideoFramePts(srcPath)])
    expect(signatures.length).toBe(pts.length)
  }, 60_000)

  // 自分が返す PTS は、別経路の getVideoFramePts と一致していなければならない。
  // これがずれると、供給時刻との突き合わせ（findFrameDivergence）が誤った基準で判定する。
  it('署名と同じデコードから取った PTS が getVideoFramePts と一致する', async () => {
    const [own, viaShowinfo] = await Promise.all([getFrameSignatures(srcPath), getVideoFramePts(srcPath)])
    expect(own.pts).toEqual(viaShowinfo)
  }, 60_000)

  it('静止区間では変化を検出せず、切り替わりだけを検出する', async () => {
    const { signatures } = await getFrameSignatures(srcPath)
    const changes: number[] = []
    for (let i = 1; i < signatures.length; i++) {
      if (signaturesDiffer(signatures[i - 1], signatures[i])) changes.push(i)
    }
    // 黒→白の1回だけ。静止している 9 フレームぶんの隣接比較は全て「変化なし」になる。
    expect(changes).toHaveLength(1)
    expect(changes[0]).toBe(Math.floor(signatures.length / 2))
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

describe('h264Bitrate', () => {
  it('1080p60 では実測で使った 20Mbps 前後になる', () => {
    expect(h264Bitrate(1920, 1080, 60)).toBeCloseTo(19_906_560, -5)
  })

  it('解像度が分からない行では固定値へ落ちる（取り込み動画・古い行）', () => {
    expect(h264Bitrate(null, null, 60)).toBe(16_000_000)
    expect(h264Bitrate(0, 1080, 60)).toBe(16_000_000)
  })

  it('小さすぎ・大きすぎは上下限で止まる', () => {
    expect(h264Bitrate(320, 240, 10)).toBe(4_000_000)
    expect(h264Bitrate(3840, 2160, 120)).toBe(40_000_000)
  })

  it('fps が無い録画は 60 とみなす（低く見積もると足りない）', () => {
    expect(h264Bitrate(1920, 1080, null)).toBe(h264Bitrate(1920, 1080, 60))
  })
})


describe('h264Args', () => {
  const args = h264Args('in.webm', 'out.mp4', { width: 1920, height: 1080, fps: 60 })

  // どちらも外しても変換は成功し、画面にも何も出ない。**外れたことに気づけるのは
  // ここだけ。** それぞれ何が起きるかは ANIME-FRAMES.md に実測付きで書いてある。
  it('コマ数を保つ指定が入っている（外すと ffmpeg がコマを複製する）', () => {
    expect(args.join(' ')).toContain('-fps_mode passthrough')
  })

  it('コマの時刻を保つ指定が入っている（外すと素材の fps 刻みへ丸められる）', () => {
    expect(args.join(' ')).toContain('-enc_time_base demux')
  })

  it('奇数サイズを埋める指定が入っている（外すと libopenh264 が 1px 削る）', () => {
    expect(args.join(' ')).toContain('pad=ceil(iw/2)*2:ceil(ih/2)*2')
  })

  // GPU 依存のエンコーダを既定にすると「うちの PC だけ書き出せない」が起きる。
  it('どの PC でも動くエンコーダを使う', () => {
    expect(args).toContain('libopenh264')
    expect(args.join(' ')).not.toMatch(/nvenc|qsv|amf|libx264/)
  })
})

describe('transcodeToH264', () => {
  let dir: string
  let vfrPath: string
  let oddPath: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shiori-ffmpeg-h264-test-'))

    // 可変フレームレートの素材。録画（MediaRecorder）は「画面が変化したぶんだけ」
    // フレームを吐くので、実物もこの形になる。select でコマを間引いて等間隔でなくする。
    vfrPath = join(dir, 'vfr.webm')
    await runFfmpegSync([
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=60:duration=3',
      '-vf', "select='not(eq(mod(n,7),3))+not(eq(mod(n,11),5))'",
      '-fps_mode', 'passthrough',
      '-c:v', 'libvpx',
      vfrPath
    ])

    // 縦横が奇数の素材。録画のクロップ幅は画面の DPR 次第で奇数になる
    // （capture.ts の computeVideoCrop）ので、実際に起きる。
    oddPath = join(dir, 'odd.webm')
    await runFfmpegSync([
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=321x241:rate=30:duration=1',
      '-c:v', 'libvpx',
      oddPath
    ])
  }, 60_000)

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // **この 2 つが崩れると、コマ送りもフレーム表も黙って嘘になる。**
  // 固定フレームレートへ落とすと ffmpeg が足りない位置にコマを複製し、実測では
  // 237 コマが 240 コマに増えて終わりのほうで約 4 秒ずれた（ANIME-FRAMES.md 参照）。
  it('コマ数が変わらない', async () => {
    const outPath = join(dir, 'vfr.mp4')
    await transcodeToH264(vfrPath, outPath, { width: 320, height: 240, fps: 60 })
    const before = await getVideoFramePts(vfrPath)
    const after = await getVideoFramePts(outPath)
    expect(after.length).toBe(before.length)
  }, 120_000)

  it('各コマの時刻が 1 つも動かない', async () => {
    const outPath = join(dir, 'vfr_pts.mp4')
    await transcodeToH264(vfrPath, outPath, { width: 320, height: 240, fps: 60 })
    const before = await getVideoFramePts(vfrPath)
    const after = await getVideoFramePts(outPath)
    expect(after).toEqual(before)
  }, 120_000)

  // libopenh264 は奇数サイズを黙って 1px 削る（実測 1365x767 → 1364x766）。
  // 削られると画面からは気づけないので、埋めて逃がしていることを固定する。
  it('縦横が奇数でも絵が欠けない（偶数へ埋める）', async () => {
    const outPath = join(dir, 'odd.mp4')
    await transcodeToH264(oddPath, outPath, { width: 321, height: 241, fps: 30 })
    const { stderr } = await probeStderr(outPath)
    expect(stderr).toMatch(/322x242/)
  }, 120_000)

  it('H.264 として書けている', async () => {
    const outPath = join(dir, 'codec.mp4')
    await transcodeToH264(oddPath, outPath, { width: 321, height: 241, fps: 30 })
    expect((await getVideoMeta(outPath)).codec).toBe('h264')
  }, 120_000)
})
