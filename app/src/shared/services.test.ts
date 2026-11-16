import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { SUPPORTED_SERVICES } from './services'

// 対応サービスの表（services.ts）と、拡張の manifest・デモ素材の目録スクリプトの対応。
// どちらも別の場所に手で書かれていて、片方に足し忘れても何も落ちない——拡張で撮れても
// サイドバーではホスト名のまま末尾に並ぶ、などの形で黙って食い違う。
const root = resolve(__dirname, '../../..')
const manifest = JSON.parse(readFileSync(resolve(root, 'extension/manifest.json'), 'utf8')) as {
  host_permissions: string[]
  content_scripts: { matches: string[] }[]
}
const hosts = SUPPORTED_SERVICES.flatMap((s) => s.hosts)

// manifest の match pattern（*://*.example.com/*）がホストを含むか。`*.` は本体のホストも含む（Chrome の決まり）。
function covered(patterns: string[], host: string): boolean {
  return patterns.some((p) => {
    const m = p.match(/^[^:]+:\/\/([^/]+)\//)
    if (!m) return false
    const h = m[1]
    if (h.startsWith('*.')) return host === h.slice(2) || host.endsWith(h.slice(1))
    return host === h
  })
}

describe('対応サービスの表と拡張の manifest', () => {
  it('表のホストは、拡張が接続できる範囲（host_permissions）に全部入っている', () => {
    for (const host of hosts) expect(covered(manifest.host_permissions, host), host).toBe(true)
  })

  it('表のホストは、どれかの content_scripts でページに入る範囲に入っている', () => {
    const all = manifest.content_scripts.flatMap((c) => c.matches)
    for (const host of hosts) expect(covered(all, host), host).toBe(true)
  })
})

describe('デモ素材の目録スクリプト', () => {
  it('表に無いホストを使っていない（使うとデモのサイドバーでホスト名のまま並ぶ）', () => {
    const script = readFileSync(resolve(root, 'app/scripts/build-demo-manifest.mjs'), 'utf8')
    const used = [...script.matchAll(/host: '([^']+)'/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(0)
    for (const host of used) expect(hosts, host).toContain(host)
  })
})
