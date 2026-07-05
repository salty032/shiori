import { app, nativeImage, net } from 'electron'
import { join } from 'path'
import { mkdir, readFile, access, unlink, rename } from 'fs/promises'
import { createWriteStream, createReadStream } from 'fs'
import { createHash } from 'crypto'

const MODEL_URL = 'https://huggingface.co/SmilingWolf/wd-vit-tagger-v3/resolve/main/model.onnx'
const TAGS_URL = 'https://huggingface.co/SmilingWolf/wd-vit-tagger-v3/resolve/main/selected_tags.csv'

// 供給元ファイル差し替え対策の SHA-256 pin（HuggingFace main の正規値）。
// model.onnx は HF LFS の oid、selected_tags.csv は実ファイルの sha256。
const MODEL_SHA256 = '35f23693620b668f4d53fd3c62bf65e40af739bc52c7eb0fbc49258b58d065b6'
const TAGS_SHA256 = '298633d94d0031d2081c0893f29c82eab7f0df00b08483ba8f29d1e979441217'

function modelDir(): string { return join(app.getPath('userData'), 'models', 'wd-vit-tagger-v3') }
function modelPath(): string { return join(modelDir(), 'model.onnx') }
function tagsPath(): string { return join(modelDir(), 'selected_tags.csv') }

const THRESHOLD_GENERAL = 0.35
const THRESHOLD_CHARACTER = 0.85

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000  // 10分
const MAX_MODEL_BYTES = 600 * 1024 * 1024    // 600 MB
const MAX_CSV_BYTES = 5 * 1024 * 1024        // 5 MB

export interface TagResult {
  name: string
  category: number  // 0=general, 4=character
  score: number
}

type ProgressCallback = (progress: number) => void
type DownloadSignal = { signal?: AbortSignal }
export interface TagEntry { name: string; category: number }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ortModule: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let session: any = null
let tagList: TagEntry[] = []
let ensureModelPromise: Promise<void> | null = null
let activeDownloadController: AbortController | null = null
// 一度オートロードされたかどうか。アイドル解放後もキャプチャ時に再ロードして
// 自動タグ付けを続けるかどうかの判定に使う（session の有無とは別軸）。
let wasLoadedOnce = false

// この時間タグ付けが呼ばれなければ、推論セッションをメモリから解放する
// （600MB級モデルなので、使っていない間は常駐させない）。
// 短めに設定し「使った直後にはもう解放されている」状態を優先する。
// retagAll 等の連続処理はジョブ完了ごとにタイマーがリセットされるため、
// 1 枚あたりの処理時間がこの値を超えない限りバッチ中に解放されることはない。
const IDLE_UNLOAD_MS = 3 * 1000
let idleTimer: ReturnType<typeof setTimeout> | null = null

function scheduleIdleUnload(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    // 実行中/待機中のタグ付けジョブと競合しないよう、同じチェーンに乗せて解放する
    taggerChain = taggerChain.then(() => unloadModel()).catch(() => {})
  }, IDLE_UNLOAD_MS)
}

async function unloadModel(): Promise<void> {
  if (!session) return
  const s = session
  session = null
  try {
    await s.release()
  } catch (err) {
    console.warn('[tagger] session release failed', err)
  }
}

async function getOrt(): Promise<any> {
  if (!ortModule) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ortModule = require('onnxruntime-node')
  }
  return ortModule
}

function fileExists(p: string): Promise<boolean> {
  return access(p).then(() => true).catch(() => false)
}

function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(p)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Download canceled')
}

async function downloadFile(url: string, dest: string, onProgress?: ProgressCallback, maxBytes?: number, expectedSha256?: string, options: DownloadSignal = {}): Promise<void> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  // 本文ストリーミング中も監視する「無通信タイムアウト」。チャンク受信のたびに引き直すので、
  // 進捗がある限り大容量DLは打ち切らず、回線が固着（この時間まったく受信できない）したときだけ
  // 中断する。旧実装は fetch 解決直後に clearTimeout していたため本文の読み込みループには
  // タイムアウトが効かず、回線が詰まるとダウンロードが無限にぶら下がる余地があった。
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  }
  armStall()
  try {
    throwIfAborted(options.signal)
    const resp = await net.fetch(url, { signal: controller.signal })
    if (!resp.ok) throw new Error(`HTTP ${resp.status} downloading ${url}`)
    const total = Number(resp.headers.get('content-length') ?? 0)
    let received = 0
    const tempDest = `${dest}.tmp`
    const file = createWriteStream(tempDest)
    const reader = resp.body!.getReader()
    try {
      try {
        while (true) {
          throwIfAborted(options.signal)
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            armStall()  // 受信があったのでタイムアウトを引き直す
            received += value.length
            if (maxBytes && received > maxBytes) {
              reader.cancel()
              throw new Error(`Download too large (>${maxBytes} bytes): ${url}`)
            }
            if (total > 0) onProgress?.(received / total)
            await new Promise<void>((res, rej) => {
              if (file.write(value)) res()
              else { file.once('drain', res); file.once('error', rej) }
            })
          }
        }
        if (total > 0 && received !== total) {
          throw new Error(`Incomplete download for ${url}: ${received}/${total} bytes`)
        }
      } finally {
        await new Promise<void>((res, rej) => {
          file.end()
          file.once('finish', res)
          file.once('error', rej)
        })
      }
    } catch (err) {
      await unlink(tempDest).catch(() => {})
      throw err
    }
    if (expectedSha256) {
      const actual = await sha256File(tempDest)
      if (actual !== expectedSha256) {
        await unlink(tempDest).catch(() => {})
        throw new Error(`SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actual}`)
      }
    }
    try {
      await rename(tempDest, dest)
    } catch (err) {
      await unlink(tempDest).catch(() => {})
      throw err
    }
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
    options.signal?.removeEventListener('abort', abort)
  }
}

export function parseTagsCSV(csv: string): TagEntry[] {
  return csv.split('\n').slice(1)
    .filter((l) => l.trim())
    .map((l) => {
      const parts = l.split(',')
      if (parts.length < 3) return null
      return { name: parts[1], category: parseInt(parts[2], 10) }
    })
    .filter((e): e is TagEntry => e !== null && !!e.name)
}

// このプロセスで一度ハッシュ検証済みのパス集合。アイドル解放後の再ロードのたびに
// 600MB の model.onnx を再検証しないためのキャッシュ（初回ロード・新規ダウンロード時は必ず検証する）。
const verifiedPaths = new Set<string>()

// キャッシュ済みなら SHA-256 を検証し、一致しなければ削除して再取得する。
async function ensureVerifiedFile(
  url: string,
  dest: string,
  sha256: string,
  onProgress?: ProgressCallback,
  maxBytes?: number,
  options: DownloadSignal = {}
): Promise<void> {
  throwIfAborted(options.signal)
  if (verifiedPaths.has(dest) && (await fileExists(dest))) return
  if (await fileExists(dest)) {
    const actual = await sha256File(dest)
    if (actual === sha256) { verifiedPaths.add(dest); return }
    console.warn(`[tagger] cached file failed hash check, re-downloading: ${dest}`)
    verifiedPaths.delete(dest)
    await unlink(dest).catch(() => {})
  }
  await downloadFile(url, dest, onProgress, maxBytes, sha256, options)
  verifiedPaths.add(dest)
}

async function loadModel(onProgress?: ProgressCallback, options: DownloadSignal = {}): Promise<void> {
  const ort = await getOrt()
  const dir = modelDir()
  const mp = modelPath()
  const tp = tagsPath()
  await mkdir(dir, { recursive: true })

  await ensureVerifiedFile(TAGS_URL, tp, TAGS_SHA256, undefined, MAX_CSV_BYTES, options)
  await ensureVerifiedFile(MODEL_URL, mp, MODEL_SHA256, onProgress, MAX_MODEL_BYTES, options)
  throwIfAborted(options.signal)

  const csv = await readFile(tp, 'utf-8')
  tagList = parseTagsCSV(csv)
  if (tagList.length === 0) throw new Error('selected_tags.csv is empty or invalid')
  session = await ort.InferenceSession.create(mp)
  wasLoadedOnce = true
  scheduleIdleUnload()
}

export async function ensureModel(onProgress?: ProgressCallback): Promise<void> {
  // 既にロード済みならアイドル解放後の再ロードも含めて毎回検証し直さない
  if (session) return
  if (!ensureModelPromise) {
    activeDownloadController = new AbortController()
    ensureModelPromise = loadModel(onProgress, { signal: activeDownloadController.signal }).finally(() => {
      ensureModelPromise = null
      activeDownloadController = null
    })
  }
  return ensureModelPromise
}

export function cancelModelDownload(): void {
  activeDownloadController?.abort()
}

// ONNX 推論は重い。キャプチャ連打・大量インポートで runTagger が無制限に並行起動すると
// メモリ/CPU がスパイクする（最悪 OOM）。全呼び出しを 1 本のチェーンに通して直列化する。
// retagAll は元々逐次 await なので、ここを通しても自然に同じ列に乗るだけ。
let taggerChain: Promise<unknown> = Promise.resolve()

export function runTagger(imagePath: string): Promise<TagResult[]> {
  // 保留中のアイドル解放を取り消す。呼び出し側は ensureModel().then(() => runTagger(...)) の形で
  // 呼ぶため、ここで clear しておけば「解放直後の再ロード」という無駄な往復自体を防げる。
  // 解放が既にチェーンへ積まれてしまっている場合は runTaggerInner 側の自己修復で救済する。
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  const job = taggerChain.then(() => runTaggerInner(imagePath))
  // 1 件が失敗しても後続を止めないよう、チェーン本体は reject を飲み込む（呼び出し側は job で受ける）
  // 完了のたびにアイドルタイマーを引き直し、使用中に解放されないようにする
  taggerChain = job.catch(() => {}).then(() => { scheduleIdleUnload() })
  return job
}

async function runTaggerInner(imagePath: string): Promise<TagResult[]> {
  // アイドル解放がこのジョブより先にチェーンに積まれていた場合、session はここで null になっている。
  // ダウンロード済みなら（検証キャッシュにより高速な）再ロードでその場から自己修復し、
  // 未ダウンロードのときだけ従来どおり throw する。
  if (!session) {
    if (!(await isModelDownloaded())) {
      throw new Error('Model not loaded (not downloaded)')
    }
    await ensureModel()
  }
  if (!session || !ortModule || tagList.length === 0) {
    throw new Error(`Model not loaded (session=${session != null}, ort=${ortModule != null}, tags=${tagList.length})`)
  }

  const base = nativeImage.createFromPath(imagePath)
  if (base.isEmpty()) throw new Error(`Cannot decode image: ${imagePath}`)

  // WD Tagger は正方形入力を前提とするが、単純に 448x448 へリサイズすると縦長/横長の絵が
  // 潰れてタグ精度が落ちる。モデル本来の前処理（make_square）に合わせ、アスペクト比を保って
  // 448 に収め、余白を白(255)でパディングする。
  const SIZE = 448
  const { width: ow, height: oh } = base.getSize()
  const scale = Math.min(SIZE / ow, SIZE / oh)
  const rw = Math.max(1, Math.min(SIZE, Math.round(ow * scale)))
  const rh = Math.max(1, Math.min(SIZE, Math.round(oh * scale)))
  const resized = base.resize({ width: rw, height: rh })
  const buf = resized.toBitmap()  // BGRA, 4 bytes/pixel
  const offX = Math.floor((SIZE - rw) / 2)
  const offY = Math.floor((SIZE - rh) / 2)

  // まず全体を白(255)で埋め、実画素を中央へ配置。BGRA → RGB float32 (0-255、WD Tagger は正規化なし)
  const float32 = new Float32Array(SIZE * SIZE * 3).fill(255)
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const src = (y * rw + x) * 4
      const dst = ((y + offY) * SIZE + (x + offX)) * 3
      float32[dst + 0] = buf[src + 2]  // R
      float32[dst + 1] = buf[src + 1]  // G
      float32[dst + 2] = buf[src + 0]  // B
    }
  }

  const inputName = session.inputNames[0]
  const tensor = new ortModule.Tensor('float32', float32, [1, SIZE, SIZE, 3])
  const output = await session.run({ [inputName]: tensor })
  const scores = output[session.outputNames[0]].data as Float32Array

  const results: TagResult[] = []
  for (let i = 0; i < tagList.length; i++) {
    const { name, category } = tagList[i]
    if (category === 9) continue  // rating はスキップ
    const score = scores[i]
    const threshold = category === 4 ? THRESHOLD_CHARACTER : THRESHOLD_GENERAL
    if (score >= threshold) results.push({ name, category, score })
  }

  return results.sort((a, b) => b.score - a.score)
}

export function isModelLoaded(): boolean {
  return session !== null
}

export async function deleteModel(): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  // ダウンロード進行中に削除されると、ここで unlink した後も進行中の downloadFile が
  // 完了時に tmp → rename でモデルを復活させてしまう。中断して完了を待ってから unlink する。
  cancelModelDownload()
  if (ensureModelPromise) await ensureModelPromise.catch(() => {})
  // 実行中/待機中の推論ジョブと競合しないよう、アイドル解放と同じチェーンに乗せる
  taggerChain = taggerChain.then(() => unloadModel()).catch(() => {})
  await taggerChain
  wasLoadedOnce = false
  tagList = []
  verifiedPaths.delete(modelPath())
  verifiedPaths.delete(tagsPath())
  try { await unlink(modelPath()) } catch {}
  try { await unlink(tagsPath()) } catch {}
}

// 起動時オートロード等で一度でもロードに成功していれば true。
// アイドル解放でメモリ上から消えていても、次回キャプチャ時に再ロードして
// 自動タグ付けを続けるかどうかの判定に使う。
export function canAutoTag(): boolean {
  return wasLoadedOnce
}

export async function isModelDownloaded(): Promise<boolean> {
  return (await fileExists(modelPath())) && (await fileExists(tagsPath()))
}

// テスト専用: 実ダウンロード/ハッシュ計算を経由せずモジュール内部状態を直接操作する
// （S3-2 のアイドル解放レース・検証キャッシュの回帰テスト用）。
export function _resetTaggerStateForTest(opts?: {
  session?: unknown
  ortModule?: unknown
  tagList?: TagEntry[]
  wasLoadedOnce?: boolean
  verifiedPaths?: string[]
}): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  session = opts?.session ?? null
  ortModule = opts?.ortModule ?? null
  tagList = opts?.tagList ?? []
  wasLoadedOnce = opts?.wasLoadedOnce ?? false
  verifiedPaths.clear()
  for (const p of opts?.verifiedPaths ?? []) verifiedPaths.add(p)
  taggerChain = Promise.resolve()
  ensureModelPromise = null
  activeDownloadController = null
}

export function _modelFilePathsForTest(): { model: string; tags: string } {
  return { model: modelPath(), tags: tagsPath() }
}
