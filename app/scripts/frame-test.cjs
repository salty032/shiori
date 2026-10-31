// コマ送りの精度を確かめる道具。テスト動画を作る・配る・録画を採点する、をまとめてある。
// Usage: node scripts/frame-test.cjs <command> [...]
//   make [秒数=30]    各コマに答えを焼き込んだテスト動画を frame-test/ に作る
//   serve [port=8790] frame-test/ を http://localhost で配る（dev.bat が起動時に立ち上げる）
//   score [クリップ id ...] [--prod | --db パス] [--hours N] [--rematch] [--no-thumbs]
//                     録画したテスト動画を、焼き込んだ答えで採点する
//   diag <dir|file.json> [...]
//                     録画時の対応検査（diagnoseCorrespondence）を、集めた診断ファイルの時刻列で採点する
//
// 拡張はリポジトリの extension/ をそのまま読み込めば localhost でも動く（manifest に入れてある）。
// 診断ファイル（frame-diag/）は dev.bat で起動すると録画ごとに書き出される。
const path = require('node:path')

// better-sqlite3 は Electron の ABI でビルドされているので、素の Node なら Electron で起動し直す。
// 出力はこちらで受けて書き直す。Electron がそのままコンソールへ書くと、PowerShell では日本語が化ける。
if (!process.versions.electron) {
  const { spawn } = require('node:child_process')
  const electron = require('electron')
  const child = spawn(electron, [__filename, ...process.argv.slice(2)], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  child.stdout.setEncoding('utf8').on('data', (s) => process.stdout.write(s))
  child.stderr.setEncoding('utf8').on('data', (s) => process.stderr.write(s))
  child.on('close', (code) => process.exit(code ?? 1))
  return
}

const fs = require('node:fs')
const { spawn } = require('node:child_process')
const appDir = path.join(__dirname, '..')
const outDir = path.join(appDir, '..', 'frame-test')
const ffmpeg = path.join(appDir, 'resources', 'ffmpeg.exe')
const diagDir = path.join(appDir, '..', 'frame-diag')

// アプリの .ts をそのまま読む（採点はアプリと同じ読み方・照合を使う）。その途中で読み込まれる、
// DB 接続と拡張との通信の部分だけを空にする（ここでは使わない）。
function loadAppModules() {
  const Module = require('node:module')
  const ts = require('typescript')
  require.extensions['.ts'] = (module, filename) => {
    const source = fs.readFileSync(filename, 'utf8')
    module._compile(ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, filename)
  }
  const STUBS = [/[\\/]db-core$/, /[\\/]db$/, /[\\/]ws-server$/]
  const load = Module._load
  Module._load = function (request, parent, isMain) {
    if (STUBS.some((re) => re.test(request))) return { onExtensionMessage: () => () => {} }
    return load.call(this, request, parent, isMain)
  }
}

// ==== 答えの符号。make と score が同じものを読む。
//
// 各コマの上端に 32 個の白黒ブロックを並べ、そのコマが何であるかを焼き込む。
// 文字ではなくブロックにするのは、録画・再エンコード・縮小を経ても画素の平均だけで読めるから。
//
//   [fps 4bit][打ち方 4bit][番号 12bit][検査 12bit]
//
// 検査を 12 bit 取るのは、ふつうのアニメの絵がたまたま読めてしまわないため（4 bit では
// 実際に本物の録画 1 本をテスト動画と取り違えた）。
//
// 番号はその絵が出る最初のコマ番号（1 始まり。Shiori の画面の数え方と同じ）。打ち方 0 は毎コマ
// 絵が変わるので、番号はコマ番号そのもの。打ち方 1〜3 はアニメのコマ打ちを模した動画で、同じ絵が
// 何コマか続く。画面の数字は「13-14」のようにその絵が出るコマの範囲で書く——1 つの数字だけだと、
// 目で確かめる人が「コマが重複している」と読む（実際にそう読まれた）。
const BITS = 32
const BAND_HEIGHT_RATIO = 0.25

const FPS_CODES = [
  null,
  { label: '23.976', num: 24000, den: 1001 },
  { label: '29.97', num: 30000, den: 1001 },
  { label: '59.94', num: 60000, den: 1001 },
  { label: '24', num: 24, den: 1 },
  { label: '30', num: 30, den: 1 },
  { label: '60', num: 60, den: 1 },
]

// 打ち方。各絵が何コマ続くかを繰り返す並び。
const HOLDS = [
  { label: '1koma', cycle: [1] },
  { label: '2koma', cycle: [2] },
  { label: '3koma', cycle: [3] },
  { label: '2-3koma', cycle: [2, 3] },
  // 絵がほとんど動かない場面。手がかり（絵の変わり目）が少ないと、遅れの決め方がぶれて全体がずれうる。
  { label: '6-12-24koma', cycle: [6, 12, 24] },
]

// コマ番号（1 始まり）が属する絵の、最初と最後のコマ番号。
function drawingOf(hold, frameNo) {
  const { cycle } = HOLDS[hold]
  let start = 1
  for (let i = 0; ; i++) {
    const len = cycle[i % cycle.length]
    if (frameNo < start + len) return { first: start, last: start + len - 1 }
    start += len
  }
}

function checksum(header, number) {
  let h = 0x9e3 ^ header
  for (let i = 0; i < 3; i++) h = (h * 31 + ((number >> (i * 6)) & 0x3f) + 7) % 4093
  return h
}

function encode(fpsCode, number, hold = 0) {
  if (number < 0 || number > 0xfff) throw new Error(`number out of range: ${number}`)
  const header = fpsCode
  const field = (hold << 12) | number
  return [...toBits(header, 4), ...toBits(field, 16), ...toBits(checksum(header, field), 12)]
}

function toBits(value, width) {
  const bits = []
  for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1)
  return bits
}

function fromBits(bits) {
  return bits.reduce((v, b) => v * 2 + b, 0)
}

// 各ブロックの明るさ（0-255）から読む。検査が合わなければ null（読めない）。
function decode(levels) {
  const bits = levels.map((level) => (level >= 128 ? 1 : 0))
  const header = fromBits(bits.slice(0, 4))
  const field = fromBits(bits.slice(4, 20))
  if (fromBits(bits.slice(20)) !== checksum(header, field)) return null
  const fpsCode = header
  const hold = field >> 12
  if (!FPS_CODES[fpsCode] || !HOLDS[hold]) return null
  return { fpsCode, fps: FPS_CODES[fpsCode], hold, number: field & 0xfff }
}

// 読むときは全コマをこの大きさのグレーへ縮めてからブロックの中央を平均する。
// 1 ブロック 10 画素なので、録画の切り抜きが左右に数画素ずれても中央はブロックの内側に残る。
const SAMPLE_W = BITS * 10
const SAMPLE_H = 135

function readBand(gray) {
  const bandH = Math.floor(SAMPLE_H * BAND_HEIGHT_RATIO)
  const y0 = Math.floor(bandH * 0.25)
  const y1 = Math.ceil(bandH * 0.75)
  const levels = []
  for (let b = 0; b < BITS; b++) {
    let sum = 0
    let n = 0
    for (let y = y0; y < y1; y++) {
      for (let x = b * 10 + 3; x < b * 10 + 7; x++) { sum += gray[y * SAMPLE_W + x]; n++ }
    }
    levels.push(sum / n)
  }
  return decode(levels)
}

// ファイル内の実フレームを 1 枚ずつ読む。-fps_mode passthrough が無いと、可変フレームレートの
// 録画で ffmpeg がフレームを複製し、添字がファイル内のフレーム番号とずれる（ffmpeg.ts と同じ理由）。
function readBands(ffmpegPath, file) {
  return new Promise((resolve, reject) => {
    const frameBytes = SAMPLE_W * SAMPLE_H
    const out = []
    let pending = Buffer.alloc(0)
    let stderr = ''
    const proc = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-i', file, '-an', '-fps_mode', 'passthrough',
      '-vf', `scale=${SAMPLE_W}:${SAMPLE_H}:flags=area,format=gray`, '-f', 'rawvideo', '-'
    ])
    proc.stdout.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      while (pending.length >= frameBytes) {
        out.push(readBand(pending.subarray(0, frameBytes)))
        pending = pending.subarray(frameBytes)
      }
    })
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('error', reject)
    proc.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`ffmpeg exited ${code}: ${stderr}`)))
  })
}

// ==== make
const W = 1280
const H = 720

// 実際のアニメ配信に多い 23.976 を軸に、供給が足りなくなる 29.97・59.94 も並べる
// （docs/ANIME-FRAMES.md「供給レートと素材 fps の関係」）。
// コマ打ち（同じ絵が 2〜3 コマ続く）の動画はアニメに合わせて 23.976 だけ。絵がほとんど動かない動画は、
// 60Hz の画面で外れが集まる 29.97 にも置く。
const VIDEOS = [
  { fpsCode: 1, hold: 0 }, { fpsCode: 2, hold: 0 }, { fpsCode: 3, hold: 0 },
  { fpsCode: 1, hold: 1 }, { fpsCode: 1, hold: 2 }, { fpsCode: 1, hold: 3 },
  { fpsCode: 1, hold: 4 }, { fpsCode: 2, hold: 4 },
]

// 7 セグメントの数字。人が目でコマ送りしたときに読むためのもので、採点には使わない。
const SEGMENTS = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abcdfg']

function fillRect(buf, x, y, w, h, v) {
  for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) buf.fill(v, yy * W + Math.max(0, x), yy * W + Math.min(W, x + w))
}

function drawDigit(buf, d, x, y, dw, dh, t) {
  const half = Math.floor(dh / 2)
  const seg = {
    a: [x, y, dw, t], g: [x, y + half - t / 2, dw, t], d: [x, y + dh - t, dw, t],
    f: [x, y, t, half], b: [x + dw - t, y, t, half],
    e: [x, y + half, t, half], c: [x + dw - t, y + half, t, half],
  }
  for (const s of SEGMENTS[d]) fillRect(buf, ...seg[s].map(Math.round), 235)
}

// 数字と「-」だけを書く。長いときは横幅に収まるまで縮める。
function drawNumber(buf, text, cy) {
  const scale = Math.min(1, (W - 80) / (text.length * 150 - 40))
  const dw = 110 * scale, dh = 200 * scale, gap = 40 * scale, t = 24 * scale
  const total = text.length * dw + (text.length - 1) * gap
  let x = Math.floor((W - total) / 2)
  for (const ch of text) {
    if (ch === '-') fillRect(buf, Math.round(x), Math.round(cy - t / 2), Math.round(dw), Math.round(t), 235)
    else drawDigit(buf, Number(ch), x, cy - dh / 2, dw, dh, t)
    x += dw + gap
  }
}

// 数字はコマ番号（1 始まり）。Shiori で取り込んだ動画をコマ送りすると、画面のコマ番号と同じ数字が出る。
// コマ打ちの動画は「その絵が出るコマ番号の範囲」を書く（13-14 なら、13 コマ目と 14 コマ目がこの絵）。
function renderFrame(buf, fpsCode, hold, sourceFrame) {
  const { first, last } = drawingOf(hold, sourceFrame + 1)
  const number = first
  buf.fill(64)
  const bandH = Math.floor(H * BAND_HEIGHT_RATIO)
  const bits = encode(fpsCode, number, hold)
  for (let b = 0; b < BITS; b++) {
    const x0 = Math.round((b * W) / BITS)
    const x1 = Math.round(((b + 1) * W) / BITS)
    fillRect(buf, x0, 0, x1 - x0, bandH, bits[b] ? 255 : 0)
  }
  drawNumber(buf, first === last ? String(first) : `${first}-${last}`, Math.floor(bandH + (H - bandH) / 2))
}

function fileName({ fpsCode, hold }) {
  return hold === 0
    ? `frames-${FPS_CODES[fpsCode].label}fps.mp4`
    : `frames-${FPS_CODES[fpsCode].label}fps-${HOLDS[hold].label}.mp4`
}

async function makeVideo(video, seconds) {
  const { num, den } = FPS_CODES[video.fpsCode]
  const frames = Math.round((seconds * num) / den)
  const out = path.join(outDir, fileName(video))
  // -allow_skip_frames 0: openh264 は既定でレート制御のためにフレームを捨てる。捨てられると
  // 答えのコマ自体が動画に無くなる。
  const proc = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-framerate', `${num}/${den}`, '-i', '-',
    '-c:v', 'libopenh264', '-b:v', '8M', '-allow_skip_frames', '0', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', out
  ], { stdio: ['pipe', 'inherit', 'inherit'] })
  const closed = new Promise((resolve, reject) => {
    proc.on('error', reject)
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))
  })
  for (let i = 0; i < frames; i++) {
    const buf = Buffer.alloc(W * H)
    renderFrame(buf, video.fpsCode, video.hold, i)
    if (!proc.stdin.write(buf)) await new Promise((resolve) => proc.stdin.once('drain', resolve))
  }
  proc.stdin.end()
  await closed

  const bands = await readBands(ffmpeg, out)
  if (bands.length !== frames) throw new Error(`${out}: ${bands.length} frames decoded, expected ${frames}`)
  bands.forEach((band, i) => {
    const want = drawingOf(video.hold, i + 1).first
    if (!band || band.number !== want || band.fpsCode !== video.fpsCode || band.hold !== video.hold) {
      throw new Error(`${out}: frame ${i} reads ${JSON.stringify(band)}, expected ${want}`)
    }
  })
  console.log(`${fileName(video)}: ${frames} frames, all readable`)
}

function writePage() {
  const items = VIDEOS.map((v) => `<button data-src="${fileName(v)}">${fileName(v)}</button>`).join('\n    ')
  // コントロールは映像の外に置く。映像に重なる UI は録画に写り込み、帯の読み取りを邪魔する。
  fs.writeFileSync(path.join(outDir, 'index.html'), `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>Shiori frame test</title>
<style>
  body { margin: 0; background: #111; color: #ddd; font: 14px sans-serif; }
  nav { padding: 8px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  video { display: block; width: 100%; max-height: calc(100vh - 48px); background: #000; }
</style>
</head>
<body>
  <nav>
    ${items}
    <button id="toggle">再生 / 一時停止</button>
    <span id="now"></span>
  </nav>
  <video id="v" muted playsinline preload="auto"></video>
<script>
  const v = document.getElementById('v')
  for (const b of document.querySelectorAll('button[data-src]')) {
    b.onclick = () => { v.src = b.dataset.src; document.getElementById('now').textContent = b.dataset.src; v.play() }
  }
  document.getElementById('toggle').onclick = () => v.paused ? v.play() : v.pause()
  // ?play=ファイル名 で開くとその動画を自動で再生する（録画を自動で回すとき用）。
  const auto = new URLSearchParams(location.search).get('play')
  if (auto) { v.src = auto; document.getElementById('now').textContent = auto; v.play() }
</script>
</body>
</html>
`)
}

async function make(argv) {
  // 30 秒を超えると Shiori に取り込めない（MAX_IMPORT_VIDEO_SECONDS。著作権対策で緩めない）。
  const seconds = Number(argv[0] ?? 30)
  // 前の版で作った動画（数字の意味が違うもの）を残すと、取り違えて見てしまう。
  // 作った動画は全コマの帯を読み直して確かめる（makeVideo）。1 コマでも食い違ったら、採点の答えが
  // 信用できないので止める。
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  for (const video of VIDEOS) await makeVideo(video, seconds)
  writePage()
  console.log(`\n出力先: ${outDir}`)
}

// ==== serve
// file:// で開かないのは、拡張の content script が http://localhost にしか足していないため。
// Range に応じるのは、応じないと Chrome がシークできず、頭から再生し直すしかなくなるため。
const TYPES = { '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4' }

function serve(argv) {
  const port = Number(argv[0] ?? 8790)
  if (!fs.existsSync(outDir)) {
    console.error(`${outDir} がありません。先に node scripts/frame-test.cjs make を実行してください。`)
    process.exit(1)
  }
  require('node:http').createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html'
    const file = path.normalize(path.join(outDir, name))
    if (!file.startsWith(outDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end()
      return
    }
    const size = fs.statSync(file).size
    const headers = { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : size - Number(range[2])
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
        return
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
      fs.createReadStream(file, { start, end }).pipe(res)
      return
    }
    res.writeHead(200, { ...headers, 'Content-Length': size })
    fs.createReadStream(file).pipe(res)
  })
    // dev.bat を開き直すと前の配信がまだ残っていることがある。落とさずに一行だけ出す。
    .on('error', (err) => console.log(`[frame-test] serve: ${err.message}`))
    .listen(port, '127.0.0.1', () => console.log(`[frame-test] http://localhost:${port}/`))
}

// ==== score
// 見るのは 2 つ。
//   絵   … 表の各行が指すファイル内フレームに、その素材コマの絵が写っているか。
//          間違っている行は「画面に注記が出る行」と「出ない行」に分ける。後者が黙って間違える行。
//   番号 … ビューアに出るコマ番号が、素材の先頭からの実際のコマ数と合っているか。
// id を省くと、直近 N 時間（既定 24）の録画をすべて見る。テスト動画でないものは飛ばす。
// --prod で製品版のライブラリを見る（既定は開発版 dev.bat のライブラリ）。
// --rematch で、保存済みの表ではなく今のコードで作り直した表を採点する。材料は診断ファイル（frame-diag/）と
// 録画ファイルの絵。録画直後の処理（verify-clip.ts）と同じく、ファイルの枚数が撮影時刻の数と合うときだけ
// 作り直す。照合を変えたら、撮り直さずに過去の録画すべてで外れが増えていないかをこれで確かめる。
// --no-thumbs で、控えの絵を無いものとして作り直す（--rematch を含む）。テスト動画は DRM ではないので控えがあり、
// そのままでは DRM の配信の決め方（frame-align.ts）が採点されない。
//
// 素材コマの正解は mediaTime × fps から出す。mediaTime はブラウザが表示したコマの時刻そのもの
// なので、ここが合っていれば「どのコマを見せたか」の記録は正しい。
// ffmpeg.ts の SIGNATURE_GRID と同じ大きさ。違うと録画直後とは別の「絵が変わった」で作り直すことになる。
// ffmpeg.ts は electron を読み込むのでここからは読めない。
const SIGNATURE_GRID = 32

function parseArgs(argv) {
  const ids = []
  let prod = false
  let hours = 24
  let db = null
  let rematch = false
  let noThumbs = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--prod') prod = true
    else if (argv[i] === '--hours') hours = Number(argv[++i])
    else if (argv[i] === '--db') db = argv[++i]
    else if (argv[i] === '--rematch') rematch = true
    else if (argv[i] === '--no-thumbs') rematch = noThumbs = true
    else ids.push(Number(argv[i]))
  }
  return { ids, prod, hours, db, rematch, noThumbs }
}

// getFrameSignatures（ffmpeg.ts）と同じ取り出し方。
function readSignatures(file) {
  const bytes = SIGNATURE_GRID * SIGNATURE_GRID
  return new Promise((resolve, reject) => {
    const chunks = []
    let stderr = ''
    const proc = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-i', file, '-an', '-fps_mode', 'passthrough',
      '-vf', `scale=${SIGNATURE_GRID}:${SIGNATURE_GRID}:flags=area,format=gray`, '-f', 'rawvideo', '-'
    ])
    proc.stdout.on('data', (c) => chunks.push(c))
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr}`))
      const all = Buffer.concat(chunks)
      const out = []
      for (let k = 0; k + bytes <= all.length; k += bytes) out.push(new Uint8Array(all.subarray(k, k + bytes)))
      resolve(out)
    })
  })
}

// 今のコードで表を作り直す。作り直せないときは理由を返す（採点は保存済みの表で続ける）。
async function rematchTable(row, stored, noThumbs) {
  const { matchFrames } = require('../src/main/video/frame-feed.ts')
  const { signaturesDiffer } = require('../src/main/video/frame-verify.ts')
  const name = fs.existsSync(diagDir)
    ? fs.readdirSync(diagDir).filter((f) => f.startsWith(`frame-${row.id}-`)).sort().pop()
    : null
  if (!name) return { reason: '診断ファイルが無い' }
  const diag = JSON.parse(fs.readFileSync(path.join(diagDir, name), 'utf8'))
  if (!diag.source?.length) return { reason: '診断ファイルに素材のコマ通知が無い' }
  const signatures = await readSignatures(row.filepath)
  if (signatures.length !== diag.drawnAt.length) {
    return { reason: `ファイル ${signatures.length} 枚・撮影時刻 ${diag.drawnAt.length} 個で合わない` }
  }
  const changed = signatures.map((sig, k) => k > 0 && signaturesDiffer(signatures[k - 1], sig))
  const result = matchFrames(diag.source.map((f) => ({ ...f, receivedAt: NaN })), diag.drawnAt, changed)
  if (!result) return { reason: '照合が表を返さなかった' }
  // 録画直後の処理（verify-clip.ts）と同じく、控えの絵があれば照合で、無ければ録画全体で決め直す。
  if (!noThumbs && diag.source.some((f) => f.thumb)) {
    const { refineByThumbnails } = require('../src/main/video/frame-thumbs.ts')
    result.matches = refineByThumbnails(result.matches, new Map(diag.source.map((f) => [f.mediaTime, f.thumb])), signatures).matches
  } else {
    const { alignWholeRecording } = require('../src/main/video/frame-align.ts')
    const aligned = alignWholeRecording(
      result.matches, diag.source, diag.drawnAt, changed, result.searchRangeMs, result.sourcePeriodMs
    )
    if (aligned) result.matches = aligned.matches
  }
  // 診断ファイルは presentedFrames を持たない。保存済みの表の値（重複を畳んだ後の値）を同じコマへ写す。
  // 番号の採点（抜けの数え方）にだけ効く。
  const presented = new Map(stored.map((f) => [f.mediaTime, f.presentedFrames]))
  const table = result.matches.map((m) => ({ ...m, presentedFrames: presented.get(m.mediaTime) ?? null }))
  return { table, offsetMs: result.offsetMs }
}

function mode(values) {
  const counts = new Map()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
}

function ranges(indices) {
  const out = []
  for (const i of indices) {
    const last = out[out.length - 1]
    if (last && last[1] === i - 1) last[1] = i
    else out.push([i, i])
  }
  const text = out.slice(0, 8).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ')
  return out.length > 8 ? `${text} ほか ${out.length - 8} か所` : text
}

async function scoreClip(row, rematch, noThumbs) {
  const { decodeFrames, readUnusableFrames } = require('../src/main/db/db-video-frames.ts')
  const { findClipGaps } = require('../src/main/ipc/ipc-video.ts')
  const { buildGapIndex, sourceFrameNo } = require('../src/renderer/src/video/frameReadout.ts')
  let table = decodeFrames(row.data)
  if (!table) {
    return { skip: readUnusableFrames(row.data) ? '表は「使えない」と判定済み（コマ送りはファイル単位）' : '表が無い' }
  }
  let rematchNote = null
  if (rematch) {
    const r = await rematchTable(row, table, noThumbs)
    if (r.table) { table = r.table; rematchNote = `今のコードで作り直した表（遅れ ${r.offsetMs}ms${noThumbs ? '・控えの絵を使わない' : ''}）` }
    else rematchNote = `保存済みの表のまま（${r.reason}）`
  }
  const bands = await readBands(ffmpeg, row.filepath)
  // 半分も読めないものはテスト動画ではないとみなす。ふつうの絵でもまれに検査が通るので、
  // 1 枚でも読めたら採点する形にすると、本物の録画を「全部間違い」と採点してしまう。
  const readable = bands.filter(Boolean)
  if (readable.length < bands.length / 2) return { notTest: true }
  const fps = mode(readable.map((b) => b.fpsCode))
  const { num, den, label } = readable.find((b) => b.fpsCode === fps).fps
  const srcOf = (mediaTime) => Math.round((mediaTime * num) / den)
  // 焼き込んだ数字は、その絵が出る最初のコマ番号（1 始まり）。コマ打ちの動画では同じ絵の
  // どのコマも同じ数字を持つので、そのコマが属する絵の最初のコマ番号と比べる。
  const hold = mode(readable.map((b) => b.hold))
  const answerOf = (src) => drawingOf(hold, src + 1).first

  // ビューアと同じく、ファイル内に実在するフレームを指す行だけを使う（ipc-video の buildClipFrames）。
  const usable = table.filter((f) => f.frameIndex >= 0 && f.frameIndex < bands.length)
  const clipRed = usable.some((f) => f.misaligned)
  const result = {
    fps: label, rows: usable.length, outside: table.length - usable.length,
    correct: 0, unreadable: [], wrongWarned: [], wrongSilent: [], offsets: [], numberWarned: [], numberSilent: [],
  }

  usable.forEach((f, i) => {
    const band = bands[f.frameIndex]
    if (!band) { result.unreadable.push(i); return }
    const diff = band.number - answerOf(srcOf(f.mediaTime))
    if (diff === 0) { result.correct++; return }
    result.offsets.push(diff)
    // 流用の行は「要確認」、ずれの印が 1 つでもあればクリップ全体が赤く出る（frameReadout）。
    if (!f.captured || clipRed) result.wrongWarned.push(i)
    else result.wrongSilent.push(i)
  })

  const index = buildGapIndex({ pts: usable.map(() => 0), quality: [], sourceBased: true, gaps: findClipGaps(usable) })
  // 抜けの枚数を推定できなかった場所は、画面に「抜け 不明」と出る。そこより後ろの番号は
  // 合わなくても注記ありの扱い。
  const unknownGaps = [...index.gaps].filter(([, g]) => !g.known).map(([at]) => at)
  const firstUnknown = unknownGaps.length ? Math.min(...unknownGaps) : Infinity
  const src0 = srcOf(usable[0].mediaTime)
  usable.forEach((f, i) => {
    if (sourceFrameNo(i, index.gapBefore) === srcOf(f.mediaTime) - src0 + 1) return
    if (i > firstUnknown) result.numberWarned.push(i)
    else result.numberSilent.push(i)
  })

  const srcs = usable.map((f) => srcOf(f.mediaTime))
  result.span = srcs[srcs.length - 1] - src0 + 1
  result.noRow = result.span - new Set(srcs).size
  result.duplicated = srcs.length - new Set(srcs).size
  result.clipRed = clipRed
  result.rematchNote = rematchNote
  return result
}

function report(row, r) {
  const when = new Date(row.captured_at).toLocaleString('ja-JP')
  console.log(`\n■ id ${row.id}  ${when}  ${r.fps}fps${r.clipRed ? '  （画面ではクリップ全体が要注意）' : ''}`)
  if (r.rematchNote) console.log(`  ${r.rematchNote}`)
  console.log(`  素材 ${r.span} コマ / 表 ${r.rows} 行（表に無い素材コマ ${r.noRow}、同じ素材コマを指す行 ${r.duplicated}）`)
  if (r.outside) console.log(`  ファイルに無いフレームを指す行 ${r.outside}（ビューアは使わない）`)
  console.log(`  絵: 正しい ${r.correct} / 違う・注記あり ${r.wrongWarned.length} / 違う・注記なし ${r.wrongSilent.length} / 読めない ${r.unreadable.length}`)
  if (r.wrongSilent.length) console.log(`    ！注記なしで違う絵（表の行）: ${ranges(r.wrongSilent)}`)
  if (r.wrongWarned.length) console.log(`    注記ありで違う絵（表の行）: ${ranges(r.wrongWarned)}`)
  if (r.unreadable.length) console.log(`    読めない（表の行）: ${ranges(r.unreadable)}`)
  if (r.offsets.length) {
    const counts = {}
    for (const d of r.offsets) counts[d] = (counts[d] ?? 0) + 1
    console.log(`    ずれ（コマ）: ${Object.entries(counts).map(([d, n]) => `${d > 0 ? '+' : ''}${d}: ${n}`).join(', ')}`)
  }
  const numberOk = r.rows - r.numberWarned.length - r.numberSilent.length
  console.log(`  番号: 合う ${numberOk} / 違う・注記あり ${r.numberWarned.length} / 違う・注記なし ${r.numberSilent.length}`)
  if (r.numberSilent.length) console.log(`    ！注記なしで番号違い（表の行）: ${ranges(r.numberSilent)}`)
  if (r.numberWarned.length) console.log(`    「抜け 不明」より後ろで番号違い（表の行）: ${ranges(r.numberWarned)}`)
}

async function score(argv) {
  loadAppModules()
  const Database = require('better-sqlite3')
  const { ids, prod, hours, db: dbArg, rematch, noThumbs } = parseArgs(argv)
  const appData = process.env.APPDATA
  const dbPath = dbArg ?? path.join(appData, prod ? 'Shiori' : 'Shiori-dev', 'Shiori.db')
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  const base = `SELECT i.id, i.filepath, i.captured_at, v.data FROM images i JOIN video_frames v ON v.image_id = i.id
    WHERE i.media_type = 'video'`
  const rows = ids.length
    ? db.prepare(`${base} AND i.id IN (${ids.map(() => '?').join(',')}) ORDER BY i.id`).all(...ids)
    : db.prepare(`${base} AND i.captured_at >= ? ORDER BY i.id`).all(Date.now() - hours * 3600_000)
  console.log(`${dbPath}: ${rows.length} 本`)

  const total = { clips: 0, rows: 0, correct: 0, wrongWarned: 0, wrongSilent: 0, unreadable: 0, numberWarned: 0, numberSilent: 0 }
  let notTest = 0
  for (const row of rows) {
    if (!fs.existsSync(row.filepath)) { console.log(`\n■ id ${row.id}: ファイルが無い（${row.filepath}）`); continue }
    const r = await scoreClip(row, rematch, noThumbs)
    if (r.notTest) { notTest++; continue }
    if (r.skip) { console.log(`\n■ id ${row.id}: ${r.skip}`); continue }
    report(row, r)
    total.clips++
    total.rows += r.rows
    total.correct += r.correct
    total.wrongWarned += r.wrongWarned.length
    total.wrongSilent += r.wrongSilent.length
    total.unreadable += r.unreadable.length
    total.numberWarned += r.numberWarned.length
    total.numberSilent += r.numberSilent.length
  }
  if (notTest) console.log(`\n（テスト動画でない録画 ${notTest} 本は飛ばした）`)
  if (total.clips > 1) {
    console.log(`\n=== 合計 ${total.clips} 本・${total.rows} 行 ===`)
    console.log(`絵: 正しい ${total.correct} / 違う・注記あり ${total.wrongWarned} / 違う・注記なし ${total.wrongSilent} / 読めない ${total.unreadable}`)
    console.log(`番号: 違う・注記あり ${total.numberWarned} / 違う・注記なし ${total.numberSilent}`)
  }
}

// ==== diag
// 正解が分かるのは「枚数が合った録画」だけなので、その実際の時刻の揺らぎの上で欠落を作って測る：
// - 末尾で 1 枚欠いたもの → 候補になれば誤検出（正常な対応に印が付く形）
// - 途中で 1 枚抜いたもの → 抜いた位置を候補に含めば検出、含まない候補は位置違い（誤った印）
// - 欠落なしで段差が出たもの → 「時刻だけがずれる」実例（時刻だけでは欠落と区別できない形）
// 実際に枚数が足りなかった録画は正解が無いので、判定の内訳だけ出す。
const TOLERANCES = [3, 5, 8, 10, 12, 15]
const MID_FRACTIONS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]

function collect(args) {
  const files = []
  for (const arg of args) {
    const stat = fs.statSync(arg)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(arg)) if (name.endsWith('.json')) files.push(path.join(arg, name))
    } else files.push(arg)
  }
  return files
}

const increasing = (values) => values.every((v, i) => Number.isFinite(v) && (i === 0 || v > values[i - 1]))


function diag(argv) {
  if (argv.length === 0) {
    console.error('Usage: node scripts/frame-test.cjs diag <dir|file.json> [...]')
    process.exit(1)
  }
  loadAppModules()
  const { diagnoseCorrespondence } = require('../src/main/video/frame-correspondence-diag.ts')
  const { findFrameDivergence } = require('../src/main/video/frame-verify.ts')
  const recordings = []
  const invalid = []
  for (const file of collect(argv)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (data.schemaVersion !== 1 || !Array.isArray(data.drawnAt) || !Array.isArray(data.pts)) {
        throw new Error('unsupported format')
      }
      const reasons = []
      if (!data.drawnAt.length || !data.pts.length) reasons.push('empty')
      if (!increasing(data.drawnAt)) reasons.push('drawnAt not increasing')
      if (!increasing(data.pts)) reasons.push('pts not increasing')
      if (reasons.length) invalid.push({ imageId: data.imageId, reasons })
      else recordings.push({ imageId: data.imageId, drawnAt: data.drawnAt, pts: data.pts })
    } catch (error) {
      invalid.push({ imageId: path.basename(file), reasons: [error.message] })
    }
  }

  const exact = recordings.filter((r) => r.drawnAt.length === r.pts.length)
  const short = recordings.filter((r) => r.drawnAt.length > r.pts.length)
  const longer = recordings.filter((r) => r.drawnAt.length < r.pts.length)

  console.log(`録画 ${recordings.length + invalid.length} 本: 枚数一致 ${exact.length} / 不足 ${short.length}` +
    ` / ファイルが多い ${longer.length} / 判定不能 ${invalid.length}`)
  for (const r of invalid) console.log(`  判定不能 image ${r.imageId}: ${r.reasons.join(', ')}`)

  const shifted = exact.filter((r) => findFrameDivergence([...r.drawnAt], [...r.pts]) < r.pts.length)
  console.log(`\n欠落なしで段差が出た録画（時刻だけのずれ）: ${shifted.length} / ${exact.length}`)
  for (const r of shifted) {
    console.log(`  image ${r.imageId}: 段差 ${findFrameDivergence([...r.drawnAt], [...r.pts])} 枚目 / ${r.pts.length}`)
  }

  console.log('\n許容幅ごとの採点（枚数一致の録画に欠落を作ったもの）')
  console.log('許容ms | 末尾欠落の誤検出 | 途中欠落の検出 | 位置違いの候補 | 欠落なしで候補')
  for (const tol of TOLERANCES) {
    let tailFalse = 0
    let midHit = 0
    let midWrong = 0
    let midTotal = 0
    let noLossCandidate = 0
    for (const r of exact) {
      if (diagnoseCorrespondence(r.drawnAt, r.pts.slice(0, -1), tol).status === 'candidate') tailFalse++
      // 欠落なしの録画を、末尾 1 枚を抜いた上で「時刻だけのずれ」を持つものとして判定したとき
      if (shifted.includes(r) && diagnoseCorrespondence(r.drawnAt, r.pts.slice(0, -1), tol).status === 'candidate') {
        noLossCandidate++
      }
      const positions = new Set(MID_FRACTIONS.map((f) => Math.floor(r.pts.length * f)).filter((k) => k >= 5 && k <= r.pts.length - 6))
      for (const k of positions) {
        const pts = r.pts.slice()
        pts.splice(k, 1)
        const d = diagnoseCorrespondence(r.drawnAt, pts, tol)
        midTotal++
        if (d.status !== 'candidate') continue
        if (d.candidateStart <= k && k <= d.candidateEnd) midHit++
        else midWrong++
      }
    }
    console.log(`${String(tol).padStart(6)} | ${tailFalse} / ${exact.length} | ${midHit} / ${midTotal}` +
      ` | ${midWrong} | ${noLossCandidate} / ${shifted.length}`)
  }

  if (short.length) {
    console.log('\n実際に枚数が足りなかった録画（正解なし・判定の内訳だけ）')
    for (const r of short) {
      const verdicts = TOLERANCES.map((tol) => {
        const d = diagnoseCorrespondence(r.drawnAt, r.pts, tol)
        return d.status === 'candidate' ? `${tol}ms:候補 ${d.candidateStart}-${d.candidateEnd}` : `${tol}ms:${d.status}`
      })
      console.log(`  image ${r.imageId}（${r.drawnAt.length - r.pts.length} 枚不足 / ${r.drawnAt.length}）: ${verdicts.join(' ')}`)
    }
  }
}

const COMMANDS = { make, serve, score, diag }
const [command, ...rest] = process.argv.slice(2)
if (!COMMANDS[command]) {
  console.error('Usage: node scripts/frame-test.cjs <make|serve|score|diag> [...]')
  process.exit(1)
}
Promise.resolve(COMMANDS[command](rest)).catch((err) => { console.error(err); process.exit(1) })
