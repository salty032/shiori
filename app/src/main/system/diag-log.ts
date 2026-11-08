// main の console 出力をファイルにも残す。**userData に目印のファイル（diag-log.on）がある PC だけ。**
//
// インストール版はコンソールが無く、録画ごとの診断（[capture-supply] など）がどこにも残らない。
// 2026-11-08、撮れる枚数が 30 枚/秒に落ちた録画が 3 本あったが、後から原因を追えなかった。
// 配布版の人の PC には書かない（目印は作らない限り無い）。
import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, type WriteStream } from 'fs'
import { join } from 'path'
import { format } from 'util'

const MARKER = 'diag-log.on'
// 超えたら 1 世代だけ残して作り直す（録画 1 本で数十行なので、数百本ぶん）。
const MAX_BYTES = 5 * 1024 * 1024

export function startDiagLogIfEnabled(): void {
  const dir = app.getPath('userData')
  if (!existsSync(join(dir, MARKER))) return
  let out: WriteStream
  try {
    const logDir = join(dir, 'logs')
    mkdirSync(logDir, { recursive: true })
    const file = join(logDir, 'main.log')
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, join(logDir, 'main.old.log'))
    } catch { /* まだ無い */ }
    out = createWriteStream(file, { flags: 'a' })
    out.on('error', () => { /* 書けなくてもアプリは止めない */ })
  } catch {
    return
  }
  const stamp = (): string => {
    const d = new Date()
    const p = (n: number, w = 2): string => String(n).padStart(w, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  }
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      original(...args)
      out.write(`${stamp()} ${level === 'log' || level === 'info' ? '' : `[${level}] `}${format(...args)}\n`)
    }
  }
  console.log(`[diag-log] Shiori ${app.getVersion()} started${process.argv.includes('--hidden') ? ' (--hidden)' : ''}`)
}
