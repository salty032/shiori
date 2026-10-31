// テスト動画（make-frame-test-videos.mjs）を録画したクリップを、焼き込んだ答えで採点する。
// Usage: node scripts/score-frame-test.cjs [クリップ id ...] [--prod | --db パス] [--hours N]
//   id を省くと、直近 N 時間（既定 24）の録画をすべて見る。テスト動画でないものは飛ばす。
//   --prod で製品版のライブラリを見る（既定は開発版 dev.bat のライブラリ）。
//
// 見るのは 2 つ。
//   絵   … 表の各行が指すファイル内フレームに、その素材コマの絵が写っているか。
//          間違っている行は「画面に注記が出る行」と「出ない行」に分ける。後者が黙って間違える行。
//   番号 … ビューアに出るコマ番号が、素材の先頭からの実際のコマ数と合っているか。
//
// 素材コマの正解は mediaTime × fps から出す。mediaTime はブラウザが表示したコマの時刻そのもの
// なので、ここが合っていれば「どのコマを見せたか」の記録は正しい。
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
const Module = require('node:module')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  module._compile(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, filename)
}
// 表の読み方と抜けの数え方はアプリのものをそのまま使う。その途中で読み込まれる、DB 接続と
// 拡張との通信の部分だけを空にする（ここでは使わない）。
const STUBS = [/[\\/]db-core$/, /[\\/]db$/, /[\\/]ws-server$/]
const load = Module._load
Module._load = function (request, parent, isMain) {
  if (STUBS.some((re) => re.test(request))) return { onExtensionMessage: () => () => {} }
  return load.call(this, request, parent, isMain)
}

const Database = require('better-sqlite3')
const { decodeFrames, readUnusableFrames } = require('../src/main/db/db-video-frames.ts')
const { findClipGaps } = require('../src/main/ipc/ipc-video.ts')
const { buildGapIndex, sourceFrameNo } = require('../src/renderer/src/video/frameReadout.ts')
const { readBands } = require('./frame-test-code.cjs')

const ffmpeg = path.join(__dirname, '..', 'resources', 'ffmpeg.exe')

function parseArgs(argv) {
  const ids = []
  let prod = false
  let hours = 24
  let db = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--prod') prod = true
    else if (argv[i] === '--hours') hours = Number(argv[++i])
    else if (argv[i] === '--db') db = argv[++i]
    else ids.push(Number(argv[i]))
  }
  return { ids, prod, hours, db }
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

async function scoreClip(row) {
  const table = decodeFrames(row.data)
  if (!table) {
    return { skip: readUnusableFrames(row.data) ? '表は「使えない」と判定済み（コマ送りはファイル単位）' : '表が無い' }
  }
  const bands = await readBands(ffmpeg, row.filepath)
  // 半分も読めないものはテスト動画ではないとみなす。ふつうの絵でもまれに検査が通るので、
  // 1 枚でも読めたら採点する形にすると、本物の録画を「全部間違い」と採点してしまう。
  const readable = bands.filter(Boolean)
  if (readable.length < bands.length / 2) return { notTest: true }
  const fps = mode(readable.map((b) => b.fpsCode))
  const { num, den, label } = readable.find((b) => b.fpsCode === fps).fps
  const srcOf = (mediaTime) => Math.round((mediaTime * num) / den)
  // 焼き込んだ数字は 1 始まりのコマ番号。
  const answerOf = (src) => src + 1

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
  return result
}

function report(row, r) {
  const when = new Date(row.captured_at).toLocaleString('ja-JP')
  console.log(`\n■ id ${row.id}  ${when}  ${r.fps}fps${r.clipRed ? '  （画面ではクリップ全体が要注意）' : ''}`)
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

async function main() {
  const { ids, prod, hours, db: dbArg } = parseArgs(process.argv.slice(2))
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
    const r = await scoreClip(row)
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

main().catch((err) => { console.error(err); process.exit(1) })
