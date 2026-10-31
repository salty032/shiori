// コマ送りの精度を測るテスト動画の「答え」の符号。生成（make-frame-test-videos.mjs）と
// 採点（score-frame-test.cjs）が同じものを読む。
//
// 各コマの上端に 32 個の白黒ブロックを並べ、そのコマが何であるかを焼き込む。
// 文字ではなくブロックにするのは、録画・再エンコード・縮小を経ても画素の平均だけで読めるから。
//
//   [fps 3bit][種類 1bit][番号 16bit][検査 12bit]
//
// 検査を 12 bit 取るのは、ふつうのアニメの絵がたまたま読めてしまわないため（4 bit では
// 実際に本物の録画 1 本をテスト動画と取り違えた）。
//
// 種類 0（every）… 番号＝素材のコマ番号（0 始まり）。全コマで絵が変わる。
// 種類 1（anime）… 番号＝セル番号。HOLDS の打ち方で 1〜6 コマ同じ絵が続く。
//                  素材のコマ番号からセル番号は animeCelOf で決まるので、答えは出せる。
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

const VARIANTS = ['every', 'anime']

// アニメの打ち方。1 コマ打ちから 6 コマ打ちまでを混ぜ、規則的な 2・3 コマ打ちだけに
// しない（抜けの推定が「たまたま周期に合って当たる」形を避ける）。
const HOLDS = [3, 3, 2, 2, 2, 1, 1, 1, 4, 3, 2, 6, 1, 2, 3, 3, 2, 1, 5, 2]
const HOLDS_SUM = HOLDS.reduce((a, b) => a + b, 0)

function animeCelOf(sourceFrame) {
  const cycle = Math.floor(sourceFrame / HOLDS_SUM)
  let rest = sourceFrame - cycle * HOLDS_SUM
  let cel = cycle * HOLDS.length
  for (const hold of HOLDS) {
    if (rest < hold) return cel
    rest -= hold
    cel++
  }
  throw new Error('unreachable')
}

function checksum(header, number) {
  let h = 0x9e3 ^ header
  for (let i = 0; i < 3; i++) h = (h * 31 + ((number >> (i * 6)) & 0x3f) + 7) % 4093
  return h
}

function encode(fpsCode, variant, number) {
  if (number < 0 || number > 0xffff) throw new Error(`number out of range: ${number}`)
  const header = (fpsCode << 1) | variant
  return [...toBits(header, 4), ...toBits(number, 16), ...toBits(checksum(header, number), 12)]
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
  const number = fromBits(bits.slice(4, 20))
  if (fromBits(bits.slice(20)) !== checksum(header, number)) return null
  const fpsCode = header >> 1
  if (!FPS_CODES[fpsCode]) return null
  return { fpsCode, fps: FPS_CODES[fpsCode], variant: VARIANTS[header & 1], number }
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
  const { spawn } = require('node:child_process')
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

module.exports = {
  BITS, BAND_HEIGHT_RATIO, FPS_CODES, VARIANTS, HOLDS, animeCelOf, encode, decode, readBands
}
