// コマ送りの精度を測るテスト動画と、それを localhost で再生する一式を作る。
// Usage: node scripts/make-frame-test-videos.mjs [秒数=90]
//
// 出力先はリポジトリ直下の frame-test/（gitignore 対象）:
//   *.mp4        各コマに答え（frame-test-code.cjs の帯）を焼き込んだ動画
//   index.html   再生ページ（serve-frame-test.mjs で配る）
//   extension/   localhost でも動くようにした拡張のコピー（同じ key なので ID も同じ）
//
// 作った動画は全コマの帯を読み直して確かめる。ここで 1 コマでも食い違ったら、採点の答えが
// 信用できないので止める。
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { BAND_HEIGHT_RATIO, BITS, FPS_CODES, VARIANTS, animeCelOf, encode, readBands } = require('./frame-test-code.cjs')

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = join(appDir, '..')
const outDir = join(repoDir, 'frame-test')
const ffmpeg = join(appDir, 'resources', 'ffmpeg.exe')

const W = 1280
const H = 720
const seconds = Number(process.argv[2] ?? 90)

// 実際のアニメ配信に多い 23.976 を軸に、供給が足りなくなる 29.97・59.94 も並べる
// （docs/ANIME-FRAMES.md「供給レートと素材 fps の関係」）。
const VIDEOS = [
  { variant: 'every', fpsCode: 1 },
  { variant: 'every', fpsCode: 2 },
  { variant: 'every', fpsCode: 3 },
  { variant: 'anime', fpsCode: 1 },
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

function drawNumber(buf, n, cy) {
  const text = String(n)
  const dw = 110, dh = 200, gap = 40
  const total = text.length * dw + (text.length - 1) * gap
  let x = Math.floor((W - total) / 2)
  for (const ch of text) { drawDigit(buf, Number(ch), x, cy - dh / 2, dw, dh, 24); x += dw + gap }
}

function renderFrame(buf, fpsCode, variant, sourceFrame) {
  const number = variant === 'anime' ? animeCelOf(sourceFrame) : sourceFrame
  buf.fill(64)
  const bandH = Math.floor(H * BAND_HEIGHT_RATIO)
  const bits = encode(fpsCode, VARIANTS.indexOf(variant), number)
  for (let b = 0; b < BITS; b++) {
    const x0 = Math.round((b * W) / BITS)
    const x1 = Math.round(((b + 1) * W) / BITS)
    fillRect(buf, x0, 0, x1 - x0, bandH, bits[b] ? 255 : 0)
  }
  drawNumber(buf, number, Math.floor(bandH + (H - bandH) / 2))
}

function fileName({ variant, fpsCode }) {
  return `${variant}-${FPS_CODES[fpsCode].label}fps.mp4`
}

async function makeVideo(video) {
  const { num, den } = FPS_CODES[video.fpsCode]
  const frames = Math.round((seconds * num) / den)
  const out = join(outDir, fileName(video))
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
    renderFrame(buf, video.fpsCode, video.variant, i)
    if (!proc.stdin.write(buf)) await new Promise((resolve) => proc.stdin.once('drain', resolve))
  }
  proc.stdin.end()
  await closed

  const bands = await readBands(ffmpeg, out)
  if (bands.length !== frames) throw new Error(`${out}: ${bands.length} frames decoded, expected ${frames}`)
  bands.forEach((band, i) => {
    const want = video.variant === 'anime' ? animeCelOf(i) : i
    if (!band || band.number !== want || band.fpsCode !== video.fpsCode || band.variant !== video.variant) {
      throw new Error(`${out}: frame ${i} reads ${JSON.stringify(band)}, expected ${want}`)
    }
  })
  console.log(`${fileName(video)}: ${frames} frames, all readable`)
}

function writePage() {
  const items = VIDEOS.map((v) => `<button data-src="${fileName(v)}">${fileName(v)}</button>`).join('\n    ')
  // コントロールは映像の外に置く。映像に重なる UI は録画に写り込み、帯の読み取りを邪魔する。
  writeFileSync(join(outDir, 'index.html'), `<!doctype html>
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
</script>
</body>
</html>
`)
}

function writeExtension() {
  const dest = join(outDir, 'extension')
  rmSync(dest, { recursive: true, force: true })
  cpSync(join(repoDir, 'extension'), dest, { recursive: true })
  const manifestPath = join(dest, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.name += ' (frame test)'
  for (const cs of manifest.content_scripts) {
    if (cs.matches.includes('*://*.youtube.com/*')) cs.matches.push('http://localhost/*')
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}

mkdirSync(outDir, { recursive: true })
for (const video of VIDEOS) await makeVideo(video)
writePage()
writeExtension()
console.log(`\n出力先: ${outDir}`)
