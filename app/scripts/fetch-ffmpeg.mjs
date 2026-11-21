// 同梱する ffmpeg.exe（LGPL ビルド）を取得する。
//
// ffmpeg は 92MB あるためリポジトリには含めず、セットアップ時にここで降らせる
// （以前 ffmpeg-static が node_modules に置いていたのと同じ扱い）。
// バイナリは LGPL ビルドで固定する。GPL ビルドに差し替わると配布物に GPL の義務がかかり、Shiori 本体を MIT のまま
// 配れなくなる余地が生まれるため、URL とハッシュをピン留めして取り違えを防ぐ。
//
// 使い方: node scripts/fetch-ffmpeg.mjs [--force]
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, readdir, rm, writeFile, copyFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { BUILD } from './ffmpeg-build.mjs'

const execFileAsync = promisify(execFile)

const ZIP_URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2025-07-31-14-15/${BUILD}.zip`
const ZIP_SHA256 = 'e39d723adf6c4895eb4462a24e4ea8d729adb17578a399442ccf87149ca47aa7'
const EXE_SHA256 = '8a317ab4a3c645e20bc99585edc3e98f6e117d609aa0450b6a9342fa4e752947'

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RESOURCES = join(APP_ROOT, 'resources')
const EXE_PATH = join(RESOURCES, 'ffmpeg.exe')
const LICENSE_PATH = join(RESOURCES, 'ffmpeg-LICENSE.txt')

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function main() {
  const force = process.argv.includes('--force')

  // 既に正しいバイナリがあれば何もしない（npm install のたびに 92MB 落とさない）。
  if (!force && existsSync(EXE_PATH)) {
    if (await sha256(EXE_PATH) === EXE_SHA256) {
      console.log('[fetch-ffmpeg] ffmpeg.exe は最新です（スキップ）')
      return
    }
    console.log('[fetch-ffmpeg] 既存の ffmpeg.exe がピン留めしたビルドと一致しません。取得し直します')
  }

  await mkdir(RESOURCES, { recursive: true })
  const tmpDir = join(RESOURCES, '.tmp-ffmpeg')
  const zipPath = join(tmpDir, 'ffmpeg.zip')
  await rm(tmpDir, { recursive: true, force: true })
  await mkdir(tmpDir, { recursive: true })

  try {
    console.log(`[fetch-ffmpeg] ダウンロード中: ${BUILD}.zip (約110MB)`)
    const res = await fetch(ZIP_URL)
    if (!res.ok) throw new Error(`ダウンロードに失敗しました: HTTP ${res.status} ${ZIP_URL}`)
    await writeFile(zipPath, Buffer.from(await res.arrayBuffer()))

    const actual = await sha256(zipPath)
    if (actual !== ZIP_SHA256) {
      throw new Error(`zip のハッシュが一致しません。\n  期待値: ${ZIP_SHA256}\n  実際値: ${actual}`)
    }

    // Node に zip 展開の標準 API がないため PowerShell に委ねる（Shiori は Windows 専用）。
    //
    // **展開した後は決め打ちの場所を見ずに探す。** 2026-11-20 から GitHub Actions の windows-latest で、
    // Expand-Archive がエラーを出さずに終わるのに `<BUILD>/bin/ffmpeg.exe` が無く、CI もリリースも
    // npm ci で落ちていた（手元の PC では同じ手順が通る）。見つからなければ Windows 同梱の tar.exe
    // （zip を読める）でやり直し、それでも無ければ展開先の中身をエラーに書いて止める。
    // 取り出したファイルは下でハッシュを確かめるので、別のものが紛れ込むことはない。
    const outDir = join(tmpDir, 'out')
    console.log('[fetch-ffmpeg] 展開中')
    await execFileAsync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`
    ], { maxBuffer: 1024 * 1024 * 32 })
    let exe = await findFfmpegExe(outDir)
    if (!exe) {
      const tarExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      console.log(`[fetch-ffmpeg] Expand-Archive の展開先に ffmpeg.exe が無い（中身: ${await describeDir(outDir)}）。tar.exe でやり直します`)
      await rm(outDir, { recursive: true, force: true })
      await mkdir(outDir, { recursive: true })
      await execFileAsync(tarExe, ['-xf', zipPath, '-C', outDir], { maxBuffer: 1024 * 1024 * 32 })
      exe = await findFfmpegExe(outDir)
    }
    if (!exe) throw new Error(`展開した中に bin/ffmpeg.exe がありません（中身: ${await describeDir(outDir)}）`)

    const extracted = dirname(dirname(exe))
    await copyFile(exe, EXE_PATH)
    await copyFile(join(extracted, 'LICENSE.txt'), LICENSE_PATH)

    const exeHash = await sha256(EXE_PATH)
    if (exeHash !== EXE_SHA256) {
      throw new Error(`ffmpeg.exe のハッシュが一致しません。\n  期待値: ${EXE_SHA256}\n  実際値: ${exeHash}`)
    }
    console.log(`[fetch-ffmpeg] 完了: ${EXE_PATH}`)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

// 展開先の中から bin/ffmpeg.exe を探す。無ければ null。
async function findFfmpegExe(dir) {
  const entries = await readdir(dir, { recursive: true }).catch(() => [])
  const hit = entries.find((p) => /(^|[\\/])bin[\\/]ffmpeg\.exe$/i.test(p))
  return hit ? join(dir, hit) : null
}

// エラーに書く展開先の中身（先頭の数件と総数）。
async function describeDir(dir) {
  const entries = await readdir(dir, { recursive: true }).catch(() => null)
  if (entries === null) return '展開先が無い'
  return `${entries.length} 件: ${entries.slice(0, 8).join(', ') || '空'}`
}

main().catch((err) => {
  console.error(`[fetch-ffmpeg] ${err.message}`)
  process.exit(1)
})
