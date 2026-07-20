// 同梱する ffmpeg.exe（LGPL ビルド）を取得する。
//
// ffmpeg は 92MB あるためリポジトリには含めず、セットアップ時にここで降らせる
// （以前 ffmpeg-static が node_modules に置いていたのと同じ扱い）。
// バイナリは LGPL ビルドで固定する。GPL ビルドに差し替わると Shiori 本体（proprietary）の
// ライセンスと衝突しうるため、URL とハッシュをピン留めして取り違えを防ぐ。
//
// 使い方: node scripts/fetch-ffmpeg.mjs [--force]
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, rm, writeFile, copyFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const BUILD = 'ffmpeg-n6.1.2-192-g78690eba61-win64-lgpl-6.1'
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
    console.log('[fetch-ffmpeg] 展開中')
    await execFileAsync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmpDir}' -Force`
    ], { maxBuffer: 1024 * 1024 * 32 })

    const extracted = join(tmpDir, BUILD)
    await copyFile(join(extracted, 'bin', 'ffmpeg.exe'), EXE_PATH)
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

main().catch((err) => {
  console.error(`[fetch-ffmpeg] ${err.message}`)
  process.exit(1)
})
