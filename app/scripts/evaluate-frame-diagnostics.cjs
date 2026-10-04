// 録画時の対応検査の候補判定（diagnoseCorrespondence）を、集めた実録画の時刻列で採点する。
// Usage: node scripts/evaluate-frame-diagnostics.cjs <dir|file.json> [...]
//
// 正解が分かるのは「枚数が合った録画」だけなので、その実際の時刻の揺らぎの上で欠落を作って測る：
// - 末尾で 1 枚欠いたもの → 候補になれば誤検出（正常な対応に印が付く形）
// - 途中で 1 枚抜いたもの → 抜いた位置を候補に含めば検出、含まない候補は位置違い（誤った印）
// - 欠落なしで段差が出たもの → 「時刻だけがずれる」実例（時刻だけでは欠落と区別できない形）
// 実際に枚数が足りなかった録画は正解が無いので、判定の内訳だけ出す。
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  module._compile(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, filename)
}
const { diagnoseCorrespondence } = require('../src/main/video/frame-correspondence-diag.ts')
const { findFrameDivergence } = require('../src/main/video/frame-verify.ts')

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

if (process.argv.length < 3) {
  console.error('Usage: node scripts/evaluate-frame-diagnostics.cjs <dir|file.json> [...]')
  process.exit(1)
}

const recordings = []
const invalid = []
for (const file of collect(process.argv.slice(2))) {
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
