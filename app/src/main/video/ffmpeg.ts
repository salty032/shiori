import { spawn } from 'child_process'
import { readFile, unlink, mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'

function getFfmpegPath(): string {
  const p = ffmpegStatic
  if (!p) throw new Error('ffmpeg-static: binary not found')
  if (app.isPackaged) return p.replace('app.asar', 'app.asar.unpacked')
  return p
}

const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000  // 5分
const FFPROBE_TIMEOUT_MS = 60 * 1000      // 1分

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let bin: string
    try { bin = getFfmpegPath() } catch (err) { reject(err); return }
    const proc = spawn(bin, args, { stdio: 'pipe' })
    let stderr = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('ffmpeg timeout'))
    }, FFMPEG_TIMEOUT_MS)
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1000)}`))
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

// stderr を収集して返す（プローブ用: 非ゼロ終了も許容）。タイムアウトで打ち切った場合は
// timedOut を立てる（呼び出し側が「途中までの結果を正常値として扱わない」判断に使う）。
function runFfmpegCollect(args: string[]): Promise<{ stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    let bin: string
    try { bin = getFfmpegPath() } catch (err) { reject(err); return }
    const proc = spawn(bin, args, { stdio: 'pipe' })
    let stderr = ''
    const timer = setTimeout(() => { proc.kill(); resolve({ stderr, timedOut: true }) }, FFPROBE_TIMEOUT_MS)
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', () => { clearTimeout(timer); resolve({ stderr, timedOut: false }) })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

// showinfo フィルタで各フレームの pts_time を取得する
export async function getVideoFramePts(inputPath: string): Promise<number[]> {
  const { stderr, timedOut } = await runFfmpegCollect([
    '-i', inputPath,
    '-vf', 'showinfo',
    '-an',
    '-f', 'null',
    '-'
  ])
  // タイムアウトで打ち切った場合、途中までの PTS を「全フレーム分」のように黙って返すと
  // VideoTrimmer のコマ送り・トリム範囲が途中までしか使えなくなる。呼び出し側
  // （ipc-video.ts）は catch → [] で安全側に倒すため、ここでは throw して委ねる。
  if (timedOut) throw new Error(`getVideoFramePts timed out after ${FFPROBE_TIMEOUT_MS}ms: ${inputPath}`)
  const pts: number[] = []
  const re = /pts_time:(\d+(?:\.\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stderr)) !== null) {
    pts.push(parseFloat(m[1]))
  }
  return pts
}

export async function getVideoDuration(inputPath: string): Promise<number | null> {
  // Duration 行は入力オープン直後に stderr へ出力されるため、出力先を指定せず即座に
  // 非ゼロ終了させる（`-f null -` で最後までデコードするのは無駄）。runFfmpegCollect は
  // 終了コードを問わず stderr を返す設計なのでそのまま機能する。
  const { stderr } = await runFfmpegCollect([
    '-hide_banner',
    '-i', inputPath
  ])
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  if (!m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  const seconds = Number(m[3])
  const duration = hours * 3600 + minutes * 60 + seconds
  return Number.isFinite(duration) && duration > 0 ? duration : null
}

export async function trimWebm(
  inputPath: string,
  outPath: string,
  inSec: number,
  outSec: number
): Promise<void> {
  // 入力側で2秒前まで高速ストリームシーク（タイムスタンプは0リセットされる）→
  // 出力側はシーク後の相対時刻を指定してフレーム精確カット。
  // これにより inSec が大きい長尺クリップでも先頭から全デコードせずに済む
  const args = ['-y']
  const preSeek = Math.max(0, inSec - 2)
  if (preSeek > 0) args.push('-ss', String(preSeek))
  args.push(
    '-i', inputPath,
    '-ss', String(inSec - preSeek),
    '-to', String(outSec - preSeek),
    '-c:v', 'libvpx',
    '-b:v', '8M',
    '-c:a', 'libopus',
    '-avoid_negative_ts', 'make_zero',
    outPath
  )
  await runFfmpeg(args)
}

export async function getTimelineStrip(inputPath: string, duration: number, count: number): Promise<Buffer> {
  const tmpPath = join(app.getPath('temp'), `shiori_tl_${Date.now()}_${randomUUID()}.jpg`)
  const fpsRate = Math.max(0.01, count / Math.max(0.1, duration))
  try {
    await runFfmpeg([
      '-y',
      '-i', inputPath,
      '-vf', `fps=${fpsRate},scale=-1:40,tile=${count}x1`,
      '-frames:v', '1',
      '-q:v', '8',
      tmpPath
    ])
    return await readFile(tmpPath)
  } finally {
    try { await unlink(tmpPath) } catch {}
  }
}

export async function extractThumb(videoPath: string, thumbPath: string): Promise<void> {
  await mkdir(dirname(thumbPath), { recursive: true })
  await runFfmpeg([
    '-y',
    '-i', videoPath,
    '-frames:v', '1',
    '-f', 'image2',
    thumbPath
  ])
}
