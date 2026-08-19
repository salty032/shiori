// extension/ が「そもそも読み込める形か」を verify で確かめる。
//
// なぜ要るか — extension/ はバンドラも型検査も通らない素の JS で、アプリ側の
// npm run verify（typecheck + test）は一度も見ていなかった。構文エラーや manifest の
// 書き間違いを含んだままビルドとリリースが最後まで通り、**壊れているのは配布後、
// 利用者のブラウザで初めて分かる**（しかも拡張が黙って動かないだけなので、
// アプリ側からは「拡張が接続されない」としか見えない）。
//
// web-ext lint（npm run ext:lint）はより広く見るがネットワークからの取得を伴うため、
// コミット前に毎回回す verify には入れていない。ここでは外部依存なしで確かめられる
// 「構文が通るか」「manifest が指すファイルが実在するか」だけを見る。
import { describe, expect, it } from 'vitest'
import { readdirSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { Script } from 'vm'
import { contentJs, backgroundJs, keyGuardJs, manifestJson } from './extension-source'

const EXTENSION_DIR = join(__dirname, '../../../../extension')

type Manifest = {
  background?: { service_worker?: string; scripts?: string[] }
  content_scripts?: Array<{ js: string[] }>
  permissions?: string[]
  icons?: Record<string, string>
}

// new Script() は評価せずパースだけ行う（node --check と同じ判定）。
// 拡張の JS は module ではない素の script なので、この解釈で正しい。
function parses(source: string): void {
  new Script(source)
}

describe('extension/ の JS が構文として読み込めるか', () => {
  it('content.js', () => expect(() => parses(contentJs)).not.toThrow())
  it('background.js', () => expect(() => parses(backgroundJs)).not.toThrow())
  it('key-guard.js', () => expect(() => parses(keyGuardJs)).not.toThrow())

  // 上の 3 本は extension-source.ts が名指しで読んでいる。あとから追加された JS
  // （netflix-main.js のような MAIN world 用スクリプト）が検査から漏れないよう、
  // ディレクトリを走査して全部見る。
  it('extension/ 直下の .js すべて', () => {
    const files = readdirSync(EXTENSION_DIR).filter((f) => f.endsWith('.js'))
    expect(files.length).toBeGreaterThanOrEqual(3)
    for (const file of files) {
      const source = readFileSync(join(EXTENSION_DIR, file), 'utf-8')
      expect(() => parses(source), `${file} の構文`).not.toThrow()
    }
  })
})

describe('manifest.json が指す先が実在するか', () => {
  const manifest = JSON.parse(manifestJson) as Manifest

  // manifest に書いたファイル名を打ち間違えても、ブラウザはそのスクリプトを
  // 黙って読まないだけ。画面には何も出ないまま機能だけが消える。
  it('background のスクリプト', () => {
    const files = [manifest.background?.service_worker, ...(manifest.background?.scripts ?? [])]
    for (const file of files.filter((f): f is string => !!f)) {
      expect(existsSync(join(EXTENSION_DIR, file)), `${file} が無い`).toBe(true)
    }
  })

  it('content_scripts の js', () => {
    const files = (manifest.content_scripts ?? []).flatMap((entry) => entry.js)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      expect(existsSync(join(EXTENSION_DIR, file)), `${file} が無い`).toBe(true)
    }
  })

  it('アイコン', () => {
    for (const file of Object.values(manifest.icons ?? {})) {
      expect(existsSync(join(EXTENSION_DIR, file)), `${file} が無い`).toBe(true)
    }
  })

  it('使っていない tabs 権限を要求しない', () => {
    // tabs.query で active/windowId とタブ ID を得るだけなら権限は不要。
    // tabs 権限は URL・title・favIconUrl 等の読み取りまで許すため要求しない。
    expect(manifest.permissions ?? []).not.toContain('tabs')
  })
})
