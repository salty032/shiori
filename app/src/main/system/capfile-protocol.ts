import { protocol } from 'electron'
import { extname } from 'path'
import { stat } from 'fs/promises'
import { createReadStream } from 'fs'
import { Readable } from 'stream'
import { getImage } from '../db'
import { resolveRealCapturePath } from './paths'

// renderer が撮影済みのファイルを読むための独自プロトコル（`capfile://`）。
//
// **DB に載っている画像・動画だけを、id 経由でしか渡さない。** renderer からパスを直接
// 受け取らないのは、任意のローカルファイルを読める口になるため。id → DB → 実パスの順で
// 引き直し、`resolveRealCapturePath` が captures 配下かどうかまで確かめる。
//
// bootstrap から呼ぶのは 2 回で、**片方だけだと黙って画像が出なくなる**。
// - `registerCapfileScheme()` … `app.whenReady()` より**前**（Electron の決まり）
// - `registerCapfileProtocol()` … `app.whenReady()` の**後**

/** capfile:// を特権スキームとして宣言する。`app.whenReady()` より前に呼ぶこと。 */
export function registerCapfileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'capfile', privileges: { secure: true, standard: true, supportFetchAPI: true } }
  ])
}

// 動画(webm)を含む capfile プロトコル。
const EXT_CONTENT_TYPE: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.webm': 'video/webm', '.mp4': 'video/mp4'
}

/** id で指定された撮影済みファイルの実パスを引く。DB に無ければ null。 */
async function resolveRequestedFile(url: URL): Promise<string | null> {
  const idParam = url.searchParams.get('id')
  if (!idParam) return null
  const id = parseInt(idParam, 10)
  if (!Number.isInteger(id) || id <= 0) return null
  const image = getImage(id)
  if (!image) return null
  const kind = url.searchParams.get('kind')
  const raw = kind === 'thumb' ? (image.thumb_path ?? image.filepath) : image.filepath
  return await resolveRealCapturePath(raw)
}

/**
 * Range ヘッダを解釈して返す範囲を決める。範囲として解釈できなければ null
 * （呼び出し側は全体を返す）。
 */
function parseRange(rangeHeader: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!match || (!match[1] && !match[2])) return null
  let start: number
  let end: number
  if (!match[1]) {
    // サフィックス Range（bytes=-N、RFC 9110） 末尾 N バイトを返す
    const suffixLength = parseInt(match[2], 10)
    start = Number.isFinite(suffixLength) && suffixLength > 0 ? Math.max(0, size - suffixLength) : 0
    end = size - 1
  } else {
    start = parseInt(match[1], 10)
    end = match[2] ? parseInt(match[2], 10) : size - 1
  }
  if (!Number.isFinite(start) || start < 0) start = 0
  if (!Number.isFinite(end) || end >= size) end = size - 1
  return { start, end }
}

/** capfile:// の応答を組み立てる。`app.whenReady()` の後に呼ぶこと。 */
export function registerCapfileProtocol(): void {
  protocol.handle('capfile', async (request) => {
    const filePath = await resolveRequestedFile(new URL(request.url))
    if (!filePath) return new Response('Forbidden', { status: 403 })

    let size: number
    try {
      const info = await stat(filePath)
      if (!info.isFile()) return new Response('Not found', { status: 404 })
      size = info.size
    } catch {
      return new Response('Not found', { status: 404 })
    }

    const contentType = EXT_CONTENT_TYPE[extname(filePath).toLowerCase()] ?? 'application/octet-stream'

    // 動画の <video> シークで Range リクエストが飛んでくるため 206/416 に対応する
    // （画像に対して送られても無害）。
    const rangeHeader = request.headers.get('Range')
    if (rangeHeader) {
      const range = parseRange(rangeHeader, size)
      if (range) {
        const { start, end } = range
        if (start > end || start >= size) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${size}` }
          })
        }
        const stream = createReadStream(filePath, { start, end })
        return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes'
          }
        })
      }
    }

    const stream = createReadStream(filePath)
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes'
      }
    })
  })
}
