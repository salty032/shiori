// 配布する ffmpeg.exe に対応する FFmpeg のソース一式を落とす。
//
// なぜ要るか — 同梱している ffmpeg は LGPL v3 で、バイナリを配るなら**対応する
// ソースも渡せる状態にしておく必要がある**。NOTICE.md には「各リリースに添付して
// います」と書いてあるので、添付を忘れた時点で表記が嘘になる。手作業で毎回上げる
// 前提にすると必ず抜けるため、release.yml から呼んで Release へ添付する。
//
// 取るのはビルド名に埋まっているコミットちょうど（ffmpeg-build.mjs）。バイナリと
// 別のコミットを添付しても「ソースを渡した」ことにはならない。
//
// 使い方: node scripts/fetch-ffmpeg-source.mjs [--out <dir>]
import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { BUILD, commitFromBuild } from './ffmpeg-build.mjs'

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// github.com/FFmpeg/FFmpeg は git.ffmpeg.org の公式ミラー。ソース取得だけのために
// git を入れずに済む tar.gz を配ってくれるのでこちらを使う。
// **ハッシュはピン留めしない。** GitHub が生成する書庫は同じコミットでも将来
// 圧縮のされ方が変わりうるため、固定するとある日 CI が落ちて理由が分からなくなる。
// 中身の同一性はコミットハッシュ（URL 自体）が担保している。
const commit = commitFromBuild()
const SOURCE_URL = `https://github.com/FFmpeg/FFmpeg/archive/${commit}.tar.gz`

// 空・エラーページ・途中で切れた応答を「取れた」と扱わないための下限。
// FFmpeg のソースは 15MB 前後あるので、これを下回ったら中身が違う。
const MIN_BYTES = 5 * 1024 * 1024

function outDir() {
  const i = process.argv.indexOf('--out')
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : join(APP_ROOT, 'dist')
}

async function main() {
  const dest = join(outDir(), `${BUILD}-source.tar.gz`)

  console.log(`[ffmpeg-source] ダウンロード中: ${SOURCE_URL}`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) throw new Error(`ダウンロードに失敗しました: HTTP ${res.status} ${SOURCE_URL}`)

  const body = Buffer.from(await res.arrayBuffer())
  if (body.length < MIN_BYTES) {
    throw new Error(`受け取った書庫が小さすぎます（${body.length} バイト）。中身が違う可能性があります: ${SOURCE_URL}`)
  }
  // gzip のマジックナンバー。HTML のエラーページを掴んでいないかの確認。
  if (body[0] !== 0x1f || body[1] !== 0x8b) {
    throw new Error(`受け取った書庫が gzip ではありません: ${SOURCE_URL}`)
  }

  await mkdir(outDir(), { recursive: true })
  await writeFile(dest, body)
  console.log(`[ffmpeg-source] 完了: ${dest}（${(body.length / 1024 / 1024).toFixed(1)}MB）`)
}

main().catch((err) => {
  console.error(`[ffmpeg-source] ${err.message}`)
  process.exit(1)
})
