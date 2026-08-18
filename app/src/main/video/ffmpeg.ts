import { spawn } from 'child_process'
import { readFile, unlink, mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import { StderrCollector } from './ffmpeg-stderr'
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

// 1 本の動画から解析するフレーム数の上限。録画は 30 秒（強制上限 40 秒）、取り込みも
// 30 秒までで、取得レートの上限が 120枚/秒なので、正規の素材は 4,800 コマを超えない。
// 尺の申告が嘘のファイルでもここで必ず止まるよう、4 倍の余裕を見た固定値を置く。
//
// 超えたら throw する。途中までの結果を「全フレーム分」として返すと、撮り逃しの判定が
// 黙って嘘になる（呼び出し側は例外を「検証できなかった」として扱い、未検証のまま残す）。
export const MAX_ANALYZED_FRAMES = 20000

// showinfo が出す 1 行から表示時刻を取る。行単位で当てるので g フラグは付けない
// （付けると lastIndex が行をまたいで持ち越され、拾い漏れる）。
const PTS_TIME_RE = /pts_time:(\d+(?:\.\d+)?)/

function analysisLimitError(): Error {
  return new Error(`ffmpeg output exceeded the analysis limit (${MAX_ANALYZED_FRAMES} frames)`)
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let bin: string
    try { bin = getFfmpegPath() } catch (err) { reject(err); return }
    const proc = spawn(bin, args, { stdio: 'pipe' })
    const stderr = new StderrCollector()
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('ffmpeg timeout'))
    }, FFMPEG_TIMEOUT_MS)
    proc.stderr?.on('data', (d: Buffer) => { stderr.push(d.toString()) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.text.slice(-1000)}`))
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

// stderr を収集して返す（プローブ用: 非ゼロ終了も許容）。タイムアウトで打ち切った場合は
// timedOut を立てる（呼び出し側が「途中までの結果を正常値として扱わない」判断に使う）。
// onStderrLine を渡すと、テキストとして残らない中間行も 1 行ずつ受け取れる。
function runFfmpegCollect(
  args: string[],
  onStderrLine?: (line: string) => boolean | void
): Promise<{ stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    let bin: string
    try { bin = getFfmpegPath() } catch (err) { reject(err); return }
    const proc = spawn(bin, args, { stdio: 'pipe' })
    const stderr = new StderrCollector(onStderrLine)
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill()
      resolve({ stderr: stderr.text, timedOut: true })
    }, FFPROBE_TIMEOUT_MS)
    proc.stderr?.on('data', (d: Buffer) => {
      stderr.push(d.toString())
      if (!stderr.abortRequested || settled) return
      settled = true
      clearTimeout(timer)
      proc.kill()
      reject(analysisLimitError())
    })
    proc.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stderr.finish()
      resolve({ stderr: stderr.text, timedOut: false })
    })
    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
  })
}

// stdout をバイナリのまま集める（rawvideo の取り出し用）。stderr は行ごとに
// onStderrLine へ渡す（showinfo を挟んで「デコードされた実フレーム数」を数えるため）。
// maxStdoutBytes を超えたら溜め込みをやめて打ち切る。途中までの署名で判定すると、
// 撮り逃しの判定が黙って嘘になるので、部分的な結果は返さない。
function runFfmpegCollectStdout(
  args: string[],
  options: { maxStdoutBytes: number; onStderrLine?: (line: string) => boolean | void }
): Promise<{ stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    let bin: string
    try { bin = getFfmpegPath() } catch (err) { reject(err); return }
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let chunks: Buffer[] = []
    let stdoutBytes = 0
    const stderr = new StderrCollector(options.onStderrLine)
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      chunks = []
      proc.kill()
      reject(err)
    }
    timer = setTimeout(() => fail(new Error('ffmpeg timeout')), FFMPEG_TIMEOUT_MS)
    proc.stdout?.on('data', (d: Buffer) => {
      if (settled) return
      stdoutBytes += d.length
      if (stdoutBytes > options.maxStdoutBytes) {
        fail(analysisLimitError())
        return
      }
      chunks.push(d)
    })
    proc.stderr?.on('data', (d: Buffer) => {
      stderr.push(d.toString())
      if (stderr.abortRequested) fail(analysisLimitError())
    })
    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stderr.finish()
      if (code === 0) resolve({ stdout: Buffer.concat(chunks) })
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.text.slice(-1000)}`))
    })
    proc.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
  })
}

// 1辺のセル数。撮り逃したコマの前後で「絵が変わったか」を判定するためだけの解像度で、
// 元の絵を復元する用途ではない。細かくするほどエンコードのノイズを拾って「変わった」に
// 倒れやすくなり、粗くするほど小さな変化（口パク等）を見落とす。32 は 1920x1080 に対して
// 1セル 60x34px 相当で、キャラの口ほどの領域でも複数セルが動く粒度。
export const SIGNATURE_GRID = 32
const SIGNATURE_BYTES = SIGNATURE_GRID * SIGNATURE_GRID

// クリップの全フレームを 32x32 のグレースケールへ落として取り出す。
//
// 録画中ではなく録画後に行う。唯一の制約資源である画面キャプチャの供給レート
// （実測 31枚/秒）を、解析のために1枚たりとも削りたくないため。フル デコードを伴うので
// 保存後のバックグラウンド処理として呼ぶこと。
interface FrameSignatures {
  /** 各フレームを 32x32 グレースケールへ落とした署名。添字はファイル内のフレーム番号 */
  signatures: Uint8Array[]
  /**
   * 各フレームの表示時刻（秒）。showinfo の pts_time をそのまま拾う。
   *
   * 署名と同じ 1 回のデコードで取れるので、フレーム表の frameIndex が本当にこのファイルの
   * フレームと対応しているかを時刻で突き合わせるのに使う（frame-verify.ts の
   * findFrameDivergence）。別途 getVideoFramePts を呼ぶとデコードがもう 1 周増える。
   */
  pts: number[]
}

export async function getFrameSignatures(inputPath: string): Promise<FrameSignatures> {
  // flags=area: 縮小時に領域平均を取る。既定の bilinear だと間引きに近い挙動になり、
  // 面積の小さい変化がセルの値にほとんど出ない。
  //
  // -fps_mode passthrough は必須。録画クリップは可変フレームレートで、既定のまま
  // rawvideo へ出すと ffmpeg が一定フレームレートへ揃えるためにフレームを複製する
  // （実測: 実フレーム 16 枚のクリップが 20 枚になり、dup=4 と報告された）。
  // 複製が混ざると署名の添字がファイルのフレーム番号とずれ、フレーム表の frameIndex で
  // 引いたときに別のコマの絵を比べることになる＝検証結果が丸ごと無意味になる。
  // showinfo はフィルタなので、フレームレート調整（muxer 側）より前の「デコードされた
  // 実フレーム」を1行ずつ出す。取り出した署名の枚数と突き合わせれば、複製が混ざったことを
  // その場で検出できる。ここが静かにずれると別のコマの絵で検証してしまい、結果は
  // もっともらしいまま無意味になる（実際に踏んだ）。1回のデコードで両方の数が取れる。
  // pts は stderr を全文ためてから正規表現で走査するのではなく、届いた行をその場で
  // 数値へ畳む。showinfo は 1 フレーム 1 行（実測 200 バイト前後）出すので、全文を
  // 保持するとテキストだけで署名本体より重くなる。
  const pts: number[] = []
  const { stdout } = await runFfmpegCollectStdout([
    '-hide_banner',
    '-i', inputPath,
    '-an',
    '-fps_mode', 'passthrough',
    '-vf', `showinfo,scale=${SIGNATURE_GRID}:${SIGNATURE_GRID}:flags=area,format=gray`,
    '-f', 'rawvideo',
    '-'
  ], {
    maxStdoutBytes: MAX_ANALYZED_FRAMES * SIGNATURE_BYTES,
    onStderrLine: (line) => {
      const m = PTS_TIME_RE.exec(line)
      if (!m) return
      // 上限に達したら打ち切らせる。ここで足し続けると、下の枚数照合が通ってしまい
      // 「全フレーム分の署名」として扱われる。
      if (pts.length >= MAX_ANALYZED_FRAMES) return false
      pts.push(parseFloat(m[1]))
    }
  })
  const count = Math.floor(stdout.length / SIGNATURE_BYTES)
  if (pts.length > 0 && count !== pts.length) {
    // 呼び出し元（verify-clip.ts）は例外を「検証できなかった」として扱い、未検証のまま残す。
    // ずれた署名で判定を書き込むより、判定しない方がよい。
    throw new Error(
      `getFrameSignatures: frame count mismatch (rawvideo ${count}, decoded ${pts.length}) for ${inputPath}`
    )
  }
  const signatures: Uint8Array[] = []
  for (let i = 0; i < count; i++) {
    signatures.push(new Uint8Array(stdout.subarray(i * SIGNATURE_BYTES, (i + 1) * SIGNATURE_BYTES)))
  }
  return { signatures, pts }
}

// showinfo フィルタで各フレームの pts_time を取得する
export async function getVideoFramePts(inputPath: string): Promise<number[]> {
  const pts: number[] = []
  const { timedOut } = await runFfmpegCollect([
    '-i', inputPath,
    '-vf', 'showinfo',
    '-an',
    '-f', 'null',
    '-'
  ], (line) => {
    const m = PTS_TIME_RE.exec(line)
    if (!m) return
    if (pts.length >= MAX_ANALYZED_FRAMES) return false
    pts.push(parseFloat(m[1]))
  })
  // タイムアウトで打ち切った場合、途中までの PTS を「全フレーム分」のように黙って返すと
  // VideoTrimmer のコマ送り・トリム範囲が途中までしか使えなくなる。呼び出し側
  // （ipc-video.ts）は catch → [] で安全側に倒すため、ここでは throw して委ねる。
  if (timedOut) throw new Error(`getVideoFramePts timed out after ${FFPROBE_TIMEOUT_MS}ms: ${inputPath}`)
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
