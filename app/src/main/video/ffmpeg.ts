import { spawn } from 'child_process'
import { readFile, unlink, mkdir, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import { StderrCollector } from './ffmpeg-stderr'
// ffmpeg は npm パッケージ経由ではなく resources に直接同梱する。
// ffmpeg-static は GPL-3.0-or-later で公開されており、その JS を本体プロセスが require すると
// Shiori 本体まで GPL の派生物と解される余地が生まれる（本体は proprietary ライセンス）。
// 同梱バイナリも LGPL ビルド（--disable-libx264/x265/xvid ほか、GPL 必須要素なし）に揃えてある。
// Shiori が使うのは libvpx / libopus / mjpeg と、mp4 書き出しの libopenh264（Cisco・BSD-2）/ aac
// だけなので機能上の差はない。**H.264 に GPL の libx264 を使わないのはこのため**（H264_ENCODER）。
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

// isCanceled を渡すと、実行中でも中止できる。**変換（transcodeToH264）で要る。**
// 1 本あたり十数秒かかるので、中止ボタンを押しても今の 1 本が終わるまで反応しないと
// 「押したのに止まらない」ように見える。トリムやサムネは一瞬で終わるので渡していない。
function runFfmpeg(
  args: string[],
  isCanceled?: () => boolean,
  onStderrLine?: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    let bin: string
    try { bin = getFfmpegPath() } catch (err) { reject(err); return }
    const proc = spawn(bin, args, { stdio: 'pipe' })
    const stderr = new StderrCollector(onStderrLine)
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      clearTimers()
      proc.kill()
      reject(new Error('ffmpeg timeout'))
    }, FFMPEG_TIMEOUT_MS)
    const cancelTimer = isCanceled
      ? setInterval(() => {
          if (settled || !isCanceled()) return
          settled = true
          clearTimers()
          proc.kill()
          reject(new Error('ffmpeg canceled'))
        }, 250)
      : null
    function clearTimers(): void {
      clearTimeout(timer)
      if (cancelTimer) clearInterval(cancelTimer)
    }
    proc.stderr?.on('data', (d: Buffer) => { stderr.push(d.toString()) })
    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimers()
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.text.slice(-1000)}`))
    })
    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimers()
      reject(err)
    })
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
export async function getVideoMeta(inputPath: string): Promise<{ duration: number | null; fps: number | null; codec: string | null }> {
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

  // "Video: h264 (Constrained Baseline)" の最初の語。書き出しの変換で「もう H.264 なら
  // 作り直さない」を判断するために使う（非可逆なので、掛け直すだけ画質が落ちる）。
  const codecMatch = streamLine ? /: Video: (\w+)/.exec(streamLine) : null

  return {
    duration,
    fps: fps != null && Number.isFinite(fps) && fps > 0 ? fps : null,
    codec: codecMatch ? codecMatch[1].toLowerCase() : null
  }
}

export async function getVideoDuration(inputPath: string): Promise<number | null> {
  return (await getVideoMeta(inputPath)).duration
}

// ffmpeg が進捗行に出す経過時刻（time=00:00:01.23）。**尺の申告ではなく実際に処理した
// ところ**を指すので、これを切り出す長さで割れば進み具合になる。
const PROGRESS_TIME_RE = /\btime=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/

// 切り出しの焼き直しで要求する映像ビットレート。
//
// **元のファイルが実際に何ビット使っているかから決める。** 以前は 8Mbps 決め打ちで、
// 解像度も素材 fps も元の要求値も見ていなかった。録画側は供給枚数と素材 fps から決めていて
// 1080p60 なら約 24Mbps を要求するので、**切り出した瞬間に 1/3 へ落ちたうえに非可逆の
// 掛け直しが乗っていた。切り出した箇所こそ細かく見たいのに、そこで一番画質が落ちる。**
//
// 実効ビットレート（ファイルサイズ ÷ 尺）を根拠にするのは、**解像度・素材 fps・録画時の
// 要求値がすべて結果としてそこに出ている**から。条件を数え上げる式を別に持つと、録画側の
// 式を変えたときにこちらだけ取り残される。取り込んだ動画（Shiori が録ったのではないもの）
// にも同じ理屈がそのまま効く。
//
// 上乗せ（TRIM_BITRATE_HEADROOM）は、**切り出した区間が元クリップの平均より動くことがある**
// ため。平均そのままを要求すると、動きの多い数秒を切り出したときだけ痩せる。
//
// 音声ぶんも実効ビットレートに含まれているが、差し引かない——上乗せの内側に収まる程度
// （192kbps は映像の数 % ）で、引くために音声だけのビットレートを測り直す価値はない。
const TRIM_BITRATE_HEADROOM = 1.15
// 元の実効ビットレートが測れないとき（サイズか尺が取れない）の退避値。**従来の固定値と
// 同じにする**——測れない録画で挙動を変える理由が無い。
const TRIM_FALLBACK_BITRATE = 8_000_000
// 下限は、静止画に近い素材で極端に痩せた値を要求しないため。上限は、エンコードが破綻せず
// 実測済みの範囲（録画側の 24Mbps 近傍）に収める。
const TRIM_MIN_BITRATE = 4_000_000
const TRIM_MAX_BITRATE = 32_000_000

export function trimBitrate(fileBytes: number | null, durationSec: number | null): number {
  if (!fileBytes || !durationSec || fileBytes <= 0 || durationSec <= 0) return TRIM_FALLBACK_BITRATE
  const effective = (fileBytes * 8) / durationSec
  const raw = Math.round(effective * TRIM_BITRATE_HEADROOM)
  return Math.min(TRIM_MAX_BITRATE, Math.max(TRIM_MIN_BITRATE, raw))
}

// キーフレームを入れる間隔（コマ数）。**録画側と同じ値・同じ単位**（recorder.ts の
// KEYFRAME_INTERVAL_FRAMES）。ここを指定しないと既定の約 100 コマに 1 回へ戻り、
// キーフレームから遠いコマほどコマ送りが重くなる（実測 30ms → 294ms）。
// **録画で入れた間隔は焼き直しでは引き継がれない**ので、こちらでも明示する必要がある。
// 代償はファイルサイズ +27%（録画側の実測）。
const TRIM_KEYFRAME_INTERVAL_FRAMES = 10

export async function trimWebm(
  inputPath: string,
  outPath: string,
  inSec: number,
  outSec: number,
  onProgress?: (ratio: number) => void
): Promise<void> {
  // 元が実際に何ビット使っているかを測る。**要求値ではなく結果**を見る（要求どおりに
  // 出るとは限らないので、判断材料になるのは実際に出た方。recorder.ts と同じ考え方）。
  const [srcBytes, srcDuration] = await Promise.all([
    stat(inputPath).then((st) => st.size).catch(() => null),
    getVideoDuration(inputPath).catch(() => null)
  ])
  const videoBitrate = trimBitrate(srcBytes, srcDuration)
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
    '-b:v', String(videoBitrate),
    // コマ送りのために詰める（上の注記）。**単位はコマ数**——決めたいのは「最悪どれだけ
    // デコードするか」で、それはコマ数そのものだから。
    '-g', String(TRIM_KEYFRAME_INTERVAL_FRAMES),
    // VP9 は既定のままだと VP8 より大幅に遅く、尺次第で FFMPEG_TIMEOUT_MS に触れる。
    // row-mt で行単位のマルチスレッドを有効にし、cpu-used で速度側へ寄せて実用域に収める
    // （good/2 は画質をほぼ落とさずに速度を稼げる範囲）。
    '-row-mt', '1',
    '-deadline', 'good',
    '-cpu-used', '2',
    '-c:a', 'libopus',
    // 録画側と同じ 192kbps を明示する。未指定だと Chromium ではなく ffmpeg の既定に
    // 落ちるが、いずれにせよ**元より痩せる方向にしか動かない**ので指定する。
    '-b:a', '192k',
    '-avoid_negative_ts', 'make_zero',
    outPath
  )
  // 進捗が要らない呼び出しでは行の解析ごと省く（サムネ生成など一瞬で終わるものが大半）。
  const total = outSec - inSec
  const watch = onProgress && total > 0
    ? (line: string): void => {
        const m = PROGRESS_TIME_RE.exec(line)
        if (!m) return
        const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
        onProgress(Math.max(0, Math.min(1, sec / total)))
      }
    : undefined
  await runFfmpeg(args, undefined, watch)
}

// 書き出し（設定 > データ > 動画の書き出し形式）で H.264 を選んだときの変換。
// **ライブラリの中身には触らない。** 変換するのは書き出し先へ置くコピーだけ。
//
// 同梱している ffmpeg は LGPL ビルドで、GPL の libx264 は入っていない（ファイル冒頭参照）。
// 代わりに libopenh264（Cisco・BSD-2）が入っており、これは GPU の有無に関係なく動く。
// h264_nvenc / h264_qsv / h264_amf のほうが 3 倍ほど速いが、載っている GPU で結果が
// 変わるものを既定にすると「うちの PC だけ書き出せない・画質が違う」が起きる。
// 実測（1080p60・30秒）では libopenh264 12秒 / MediaFoundation 5秒 / NVENC 4秒、
// 元との一致度（SSIM）は 0.981 / 0.982 / 0.985 でほぼ差が無かったので、速さより
// 「どの PC でも同じ結果」を採る。
const H264_ENCODER = 'libopenh264'

// 画素あたりのビット数。1920×1080×60fps で約 20Mbps になる係数。
// 上の実測（20Mbps・SSIM 0.981）がこの値。
const H264_BITS_PER_PIXEL = 0.16
const H264_MIN_BITRATE = 4_000_000
const H264_MAX_BITRATE = 40_000_000
// 解像度が分からないとき（取り込んだ動画・古い行では width/height が null）の固定値。
const H264_FALLBACK_BITRATE = 16_000_000

export function h264Bitrate(width: number | null, height: number | null, fps: number | null): number {
  if (!width || !height || width <= 0 || height <= 0) return H264_FALLBACK_BITRATE
  // fps が無い録画がある。低く見積もると足りないので、対応上限に近い 60 を置く。
  const rate = fps && fps > 0 ? Math.min(fps, 120) : 60
  const raw = Math.round(width * height * rate * H264_BITS_PER_PIXEL)
  return Math.min(H264_MAX_BITRATE, Math.max(H264_MIN_BITRATE, raw))
}

// 引数を組み立てるところだけ切り出す。**コマのずれを防いでいるのは 2 つの指定だけで、
// どちらも外しても変換自体は成功する**（画面にも出ない）ので、指定が残っていること自体を
// テストで固定する。実素材での確認は同じテストファイルの transcodeToH264 の項。
export function h264Args(
  inputPath: string,
  outPath: string,
  meta: { width: number | null; height: number | null; fps: number | null }
): string[] {
  return [
    '-y',
    '-i', inputPath,
    // **これが無いとコマ数が変わる。** 録画は「画面が変化したぶんだけ」フレームを吐く
    // 可変フレームレートで、mp4 の既定（固定フレームレート）に落とすと ffmpeg が
    // 足りない位置にコマを複製する。実測では 237 コマが 240 コマに水増しされ、
    // 終わりのほうで元より約 4 秒ずれた。コマ送りもフレーム表も丸ごと嘘になる。
    // passthrough なら 237 コマのまま、ずれは最大 0.33ms（記録の刻みの丸めぶん）に収まる。
    '-fps_mode', 'passthrough',
    // **passthrough だけでは足りない。** コマの本数は保たれるが、時刻は「エンコーダの
    // 時間の刻み」へ丸められる。ffmpeg はこの刻みを素材の fps から決めるので、57fps の
    // 録画では 1/57 秒＝17.5ms 刻みになり、実録画で**最大 8.8ms（素材 1 コマの約 1/4）
    // ずれた**。コマ数のほうは合っているので、枚数を見ても気づけない。
    // demux は「素材が持っている刻みをそのまま使う」指定。webm は 1ms 刻みなので、
    // 実録画 4 本で最大ずれ 0.000ms になった（2026-08-26 実測）。
    // **`-video_track_timescale` では直らない**（丸めは muxer より前で起きている）。
    '-enc_time_base', 'demux',
    // libopenh264 は縦横が奇数だと**黙って 1px 削る**（実測 1365x767 → 1364x766）。
    // 録画のクロップ幅は画面の DPR 次第で奇数になる（capture.ts の computeVideoCrop）ので
    // 現実に起きる。削られると画面からは気づけないため、削らせずに埋める。
    // 代償：奇数だったときだけ右端・下端に黒が 1px 入る（見れば分かる）。
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:v', H264_ENCODER,
    '-b:v', String(h264Bitrate(meta.width, meta.height, meta.fps)),
    '-pix_fmt', 'yuv420p',
    // 音声が無いクリップでは無視される。
    '-c:a', 'aac',
    '-b:a', '192k',
    // 先頭にインデックスを置く。編集ソフトや再生側が全部読まずに開ける。
    '-movflags', '+faststart',
    outPath
  ]
}

export async function transcodeToH264(
  inputPath: string,
  outPath: string,
  meta: { width: number | null; height: number | null; fps: number | null },
  isCanceled?: () => boolean
): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true })
  await runFfmpeg(h264Args(inputPath, outPath, meta), isCanceled)
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

// サムネイルを頭から少しだけ後ろにずらす秒数。
//
// **1 コマ目は「録画の準備中」が写っていることがある。** 札を消してから撮り始めるまでの
// 猶予（recording.ts の ARMED_CLEAR_MS）を落ち着き待ちと重ねてあるので普段は写らないが、
// キャプチャ経路の遅れが猶予を超えた録画では頭の数コマに残る。一覧に並ぶ絵がそれだと、
// 撮れているものまで失敗に見える。0.3 秒あれば 24fps でも 7 コマ先で、写り込みは抜ける。
//
// **写り込みそのものを隠す策ではない**（録画の頭に残っているものは残っている）。
const THUMB_OFFSET_SEC = 0.3

export async function extractThumb(videoPath: string, thumbPath: string): Promise<void> {
  await mkdir(dirname(thumbPath), { recursive: true })
  const args = (offsetSec: number | null): string[] => [
    '-y',
    ...(offsetSec === null ? [] : ['-ss', String(offsetSec)]),
    '-i', videoPath,
    '-frames:v', '1',
    '-f', 'image2',
    thumbPath
  ]
  try {
    await runFfmpeg(args(THUMB_OFFSET_SEC))
  } catch (err) {
    console.warn('[thumb] offset extraction failed, falling back to the first frame', err)
  }
  // 尺が THUMB_OFFSET_SEC に届かないクリップでは、ffmpeg は成功で終わりながら 1 枚も
  // 書かない（0 バイトのまま残ることもある）。**終了コードだけでは判定できない**ので
  // 中身を見る。書けていなければ頭から作り直す。
  let written = 0
  try { written = (await stat(thumbPath)).size } catch { /* 1 枚も書かれなかった */ }
  if (written > 0) return
  await runFfmpeg(args(null))
}
