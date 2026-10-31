// frame-test/ を http://localhost で配る（make-frame-test-videos.mjs の再生ページ用）。
// Usage: node scripts/serve-frame-test.mjs [port=8790]
//
// file:// で開かないのは、拡張の content script が http://localhost にしか足していないため。
// Range に応じるのは、応じないと Chrome がシークできず、頭から再生し直すしかなくなるため。
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frame-test')
const port = Number(process.argv[2] ?? 8790)
const TYPES = { '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4' }

if (!existsSync(root)) {
  console.error(`${root} がありません。先に node scripts/make-frame-test-videos.mjs を実行してください。`)
  process.exit(1)
}

createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html'
  const file = normalize(join(root, name))
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end()
    return
  }
  const size = statSync(file).size
  const headers = { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2])
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
      return
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
    createReadStream(file, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'Content-Length': size })
  createReadStream(file).pipe(res)
}).listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}/`))
