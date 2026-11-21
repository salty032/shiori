import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { shortcutGroups } from './shortcuts'

// ショートカット一覧（shortcuts.ts）は手で書いた表で、キー処理から作られていない。
// キー処理に書いたキーは、その画面の組に載せるか、下の「載せない」表に理由付きで入れるかの
// どちらかにする。キーを足したのに一覧のことを考え忘れると、ここが落ちる。
//
// 読むのはキー処理に直接書いた比較（e.key === 'X' / case 'X' / e.code === 'X' / .key.toLowerCase() === 'x'）だけ。
// 表（SYMBOL_KEYS など）経由のキーは拾えない。

// t は鍵の名前をそのまま返す（組の名前で突き合わせるため）。
const groups = shortcutGroups(((key: string) => key) as Parameters<typeof shortcutGroups>[0], { capture: 'Alt+S', clip: 'Alt+D' })

// 載せない理由（shortcuts.ts の冒頭）。
const COMMON = 'どのアプリでも同じで、押せば結果が見て分かる'
const SAME_AS_VIEWER = 'ビューアの組に同じキーが載っている'
const SEEN_ON_SHEET = '押せば表の上で動くのが見える（2026-11-21 本人の判断）'

const SOURCES: { file: string; group: string; omit?: Record<string, string> }[] = [
  { file: 'hooks/useGlobalKeys.ts', group: 'shortcuts.group.global' },
  {
    file: 'hooks/useSelection.ts', group: 'shortcuts.group.global',
    omit: {
      '←': COMMON, '→': COMMON, '↑': COMMON, A: COMMON,
      PageUp: COMMON, PageDown: COMMON, Home: COMMON, End: COMMON, Enter: COMMON, Escape: COMMON
    }
  },
  { file: 'components/Viewer.tsx', group: 'shortcuts.group.viewer', omit: { Home: COMMON, End: COMMON } },
  {
    file: 'hooks/useTimesheet.ts', group: 'shortcuts.group.timesheet',
    omit: {
      Backspace: COMMON, Delete: COMMON, Escape: COMMON,
      '↑': SEEN_ON_SHEET, '↓': SEEN_ON_SHEET, '←': SEEN_ON_SHEET, '→': SEEN_ON_SHEET
    }
  },
  { file: 'video/VideoTrimmer.tsx', group: 'shortcuts.group.trim', omit: { Space: SAME_AS_VIEWER, M: SAME_AS_VIEWER, Escape: COMMON } },
]

const ARROWS: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' }

// キー処理に書いた 1 つのキーを、一覧の書き方へ揃える。
function normalizeImplKey(raw: string): string {
  if (raw === ' ') return 'Space'
  if (ARROWS[raw]) return ARROWS[raw]
  if (raw === '=') return '+' // ズームインは + と =（Shift 無しの同じキー）
  if (raw.length === 1) return raw.toUpperCase()
  return raw
}

// 一覧の keys（"Ctrl+Shift+Z / Ctrl+Y" など）を、キー 1 つずつに分ける。
function listedKeys(keys: string): string[] {
  if (keys === 'shortcuts.keys.doubleClick') return []
  // 区切りは前後に空白のある " / "（"/" だけのキーと見分ける）
  return keys.split(' / ').flatMap((part) => {
    if (part === '0-9') return [...'0123456789']
    return part.length > 1 ? part.split('+') : [part]
  }).map((k) => (k.length === 1 ? k.toUpperCase() : k))
}

function implKeys(file: string): string[] {
  const source = readFileSync(join(__dirname, file), 'utf8')
  const re = /(?:e|event)\.key === '([^']+)'|case '([^']*)'|(?:e|event)\.code === '([^']+)'|\.key\.toLowerCase\(\) === '([^']+)'/g
  const found = new Set<string>()
  for (const m of source.matchAll(re)) found.add(normalizeImplKey(m[1] ?? m[2] ?? m[3] ?? m[4]))
  return [...found]
}

function listedIn(group: string): Set<string> {
  return new Set(groups.find((g) => g.title === group)?.items.flatMap((i) => listedKeys(i.keys)) ?? [])
}

describe('ショートカット一覧とキー処理', () => {
  it.each(SOURCES)('$file のキーは、一覧の「$group」に載っているか、載せないと決めてある', ({ file, group, omit = {} }) => {
    const listed = listedIn(group)
    const keys = implKeys(file)
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.filter((k) => !listed.has(k) && !(k in omit))).toEqual([])
  })

  it.each(SOURCES.filter((s) => s.omit))('$file の「載せない」表に、もう無いキー・一覧に載っているキーが残っていない', ({ file, group, omit = {} }) => {
    const keys = new Set(implKeys(file))
    const listed = listedIn(group)
    expect(Object.keys(omit).filter((k) => !keys.has(k) || listed.has(k))).toEqual([])
  })

  it('組の名前はどれも別々（同じ名前の組に分かれて載ると、突き合わせが片方しか見ない）', () => {
    const titles = groups.map((g) => g.title)
    expect(new Set(titles).size).toBe(titles.length)
  })
})
