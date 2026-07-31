import { spawn } from 'child_process'
import { readFile, unlink, mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { app } from 'electron'
// ffmpeg は npm パッケージ経由ではなく resources に直接同梱する。
// ffmpeg-static は GPL-3.0-or-later で公開されており、その JS を本体プロセスが require すると
// Shiori 本体まで GPL の派生物と解される余地が生まれる（本体は proprietary ライセンス）。
// 同梱バイナリも LGPL ビルド（--disable-libx264/x265/xvid ほか、GPL 必須要素なし）に揃えてある。
// Shiori が使うのは libvpx / libopus / mjpeg だけなので機能上の差はない。
function getFfmpegPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'ffmpeg.exe')
  return join(app.getAppPath(), 'resources', 'ffmpeg.exe')
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

// 尺・fps をまとめて取る軽い解析。Duration 行・fps 表記のどちらも入力オープン直後の
// stderr に出るため、出力先を指定せず即座に非ゼロ終了させる（`-f null -` で最後まで
// デコードするのは無駄）。runFfmpegCollect は終了コードを問わず stderr を返す設計。
export async function getVideoMeta(inputPath: string): Promise<{ duration: number | null; fps: number | null }> {
  const { stderr } = await runFfmpegCollect([
    '-hide_banner',
    '-i', inputPath
  ])

  const durationMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  let duration: number | null = null
  if (durationMatch) {
    const hours = Number(durationMatch[1])
    const minutes = Number(durationMatch[2])
    const seconds = Number(durationMatch[3])
    const total = hours * 3600 + minutes * 60 + seconds
    duration = Number.isFinite(total) && total > 0 ? total : null
  }

  // "Stream #0:0(...): Video: ..., 23.98 fps, ..." の fps を拾う。tbr（タイムベース由来の
  // 推定値）にはフォールバックしない。実フレームレートとずれることがあり、誤った数字を
  // 出すより空欄の方がよい。
  const streamLine = /Stream #\d+:\d+.*?: Video:.*$/m.exec(stderr)?.[0]
  const fpsMatch = streamLine ? /([\d.]+)\s*fps/.exec(streamLine) : null
  const fps = fpsMatch ? Number(fpsMatch[1]) : null

  return {
    duration,
    fps: fps != null && Number.isFinite(fps) && fps > 0 ? fps : null
  }
}

export async function getVideoDuration(inputPath: string): Promise<number | null> {
  return (await getVideoMeta(inputPath)).duration
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
    // 録画側は「アニメの線画・ベタ塗りは同じビットレートなら VP9 が明確に有利」という
    // 理由で VP9 を優先している（recorder.ts の MIME_CANDIDATES）。ここが VP8 のままだと
    // せっかく VP9 で録ったものをトリムのたびに VP8 へ焼き直すことになり、輪郭の
    // モスキートノイズという避けたかった劣化をトリム工程で自ら持ち込んでしまう。
    // 録画側と同じコーデックに揃える。
    '-c:v', 'libvpx-vp9',
    '-b:v', '8M',
    // VP9 は既定のままだと VP8 より大幅に遅く、尺次第で FFMPEG_TIMEOUT_MS に触れる。
    // row-mt で行単位のマルチスレッドを有効にし、cpu-used で速度側へ寄せて実用域に収める
    // （good/2 は画質をほぼ落とさずに速度を稼げる範囲）。
    '-row-mt', '1',
    '-deadline', 'good',
    '-cpu-used', '2',
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
      // tpad で最終フレームを尺いっぱいまで複製してから fps で抜く。
      // 録画は「画面が変化したぶんだけ」フレームを吐く（recorder.ts の acquireScreenStream
      // 参照）ため、末尾が静止したクリップでは最終フレームの PTS がコンテナの尺より
      // かなり手前で終わる。実測例では尺 1.95s に対し最終フレームが 0.858s で、
      // fps=count/duration で抜くと 15 タイル中 7 枚しか埋まらず右半分が黒くなっていた。
      // stop_duration は多めに渡してよい（tile が count 枚揃った時点で -frames:v 1 が
      // 打ち切るので、余分なフレームはデコードされない）。
      '-vf', `tpad=stop_mode=clone:stop_duration=${duration},fps=${fpsRate},scale=-1:40,tile=${count}x1`,
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
