import { describe, expect, it } from 'vitest'
import { cleanTitle, siteName, formatTime, buildTimeline, computeGridLayout, thumbSrc, splitHighlight } from './utils'
import { parseSearchQuery, buildImageQuery } from './stores/imageQuery'
import type { ImageRow } from './types'

// utils.ts はレンダラー純粋関数なので Electron 依存なし
describe('cleanTitle', () => {
  it('マッチするパターンを除去', () => {
    expect(cleanTitle('映画 - Netflix', [' - Netflix'])).toBe('映画')
  })
  it('lastIndexOf: 最後の出現を除去', () => {
    expect(cleanTitle('A - Netflix - Netflix', [' - Netflix'])).toBe('A - Netflix')
  })
  it('パターンなし: そのまま返す', () => {
    expect(cleanTitle('映画', [' - Netflix'])).toBe('映画')
  })
  it('null タイトル → —', () => {
    expect(cleanTitle(null, [' - Netflix'])).toBe('—')
  })
  it('空パターン配列: そのまま返す', () => {
    expect(cleanTitle('映画', [])).toBe('映画')
  })
  it('空パターン文字列はスキップ', () => {
    expect(cleanTitle('映画', ['', ' - Netflix'])).toBe('映画')
  })
  it('先頭マッチは除去しない (idx > 0 条件)', () => {
    // " - Netflix" が idx=0 なら除去されない
    expect(cleanTitle(' - Netflix映画', [' - Netflix'])).toBe(' - Netflix映画')
  })
})

describe('splitHighlight', () => {
  it('クエリが空ならそのまま非マッチの1要素', () => {
    expect(splitHighlight('こんにちは', '')).toEqual([{ text: 'こんにちは', match: false }])
  })
  it('大文字小文字を無視して部分一致をハイライト', () => {
    expect(splitHighlight('Hello World', 'world')).toEqual([
      { text: 'Hello ', match: false },
      { text: 'World', match: true },
    ])
  })
  it('複数回出現する場合は全てハイライト', () => {
    expect(splitHighlight('猫と猫', '猫')).toEqual([
      { text: '猫', match: true },
      { text: 'と', match: false },
      { text: '猫', match: true },
    ])
  })
  it('一致しない場合は全体を非マッチで返す', () => {
    expect(splitHighlight('こんにちは', 'xyz')).toEqual([{ text: 'こんにちは', match: false }])
  })
})

describe('siteName', () => {
  it('YouTube', () => expect(siteName('https://www.youtube.com/watch?v=xxx')).toBe('YouTube'))
  it('ABEMA', () => expect(siteName('https://abema.tv/video/episode/xxx')).toBe('ABEMA'))
  it('不明なホスト: ホスト名をそのまま返す', () => expect(siteName('https://example.com')).toBe('example.com'))
  it('www. を除去', () => expect(siteName('https://www.example.com')).toBe('example.com'))
  it('null → null', () => expect(siteName(null)).toBeNull())
  it('不正 URL → null', () => expect(siteName('not-a-url')).toBeNull())
  it('dアニメストア', () => expect(siteName('https://animestore.co.jp/xxx')).toBe('dアニメストア'))
  it('Prime Video (amazon.co.jp)', () => expect(siteName('https://www.amazon.co.jp/video/xxx')).toBe('Prime Video'))
})

describe('formatTime', () => {
  it('0 → 0:00', () => expect(formatTime(0)).toBe('0:00'))
  it('90 → 1:30', () => expect(formatTime(90)).toBe('1:30'))
  it('59 → 0:59', () => expect(formatTime(59)).toBe('0:59'))
  it('3600 → 1:00:00', () => expect(formatTime(3600)).toBe('1:00:00'))
  it('3661 → 1:01:01', () => expect(formatTime(3661)).toBe('1:01:01'))
  it('null → —', () => expect(formatTime(null)).toBe('—'))
  it('小数点は切り捨て: 90.9 → 1:30', () => expect(formatTime(90.9)).toBe('1:30'))
})

describe('computeGridLayout', () => {
  it('幅0以下: 1列・最小幅をそのまま使う', () => {
    expect(computeGridLayout(0, 160, 10)).toEqual({ columns: 1, cellWidth: 160, cellHeight: 160 * 9 / 16 })
  })
  it('ぴったり収まる幅: gapを含めて列数を算出', () => {
    // 160*3 + 10*2 = 500
    expect(computeGridLayout(500, 160, 10)).toMatchObject({ columns: 3, cellWidth: 160 })
  })
  it('余りが出る幅: セル幅をコンテナいっぱいに伸ばす', () => {
    const { columns, cellWidth } = computeGridLayout(550, 160, 10)
    expect(columns).toBe(3)
    expect(cellWidth).toBeCloseTo((550 - 10 * 2) / 3)
  })
  it('1列にも満たない幅: 最低1列を保証', () => {
    expect(computeGridLayout(50, 160, 10).columns).toBe(1)
  })
  it('cellHeight は 16:9 比でセル幅から算出', () => {
    const { cellWidth, cellHeight } = computeGridLayout(500, 160, 10)
    expect(cellHeight).toBeCloseTo(cellWidth * 9 / 16)
  })
})

describe('parseSearchQuery', () => {
  it('tag: 条件を通常検索から分離', () => {
    expect(parseSearchQuery('tag:夕焼け タイトル')).toMatchObject({
      q: 'タイトル',
      tags: ['夕焼け'],
    })
  })

  it('日付条件とタグ条件を同時に扱う', () => {
    const parsed = parseSearchQuery('from:2024-01 to:2024-03 tag:close_up メモ')
    expect(parsed.q).toBe('メモ')
    expect(parsed.tags).toEqual(['close_up'])
    expect(parsed.fromDate).not.toBeNull()
    expect(parsed.toDate).not.toBeNull()
  })

  it('重複タグをまとめる', () => {
    expect(parseSearchQuery('tag:sky tag:sky').tags).toEqual(['sky'])
  })

  it('site: を通常検索から分離', () => {
    expect(parseSearchQuery('site:netflix 名場面')).toMatchObject({
      q: '名場面',
      site: 'netflix',
    })
  })

  // 日付境界（ローカルタイムゾーン非依存にするため new Date で期待値を構築）
  it('from:YYYY-MM-DD は当日0時（包含下限）', () => {
    expect(parseSearchQuery('from:2024-03-15').fromDate).toBe(new Date(2024, 2, 15).getTime())
  })
  it('to:YYYY-MM-DD は翌日0時（排他上限）', () => {
    expect(parseSearchQuery('to:2024-03-15').toDate).toBe(new Date(2024, 2, 16).getTime())
  })
  it('存在しない日付(2/30)は無効', () => {
    expect(parseSearchQuery('from:2024-02-30').fromDate).toBeNull()
  })
  it('from:YYYY は年初', () => {
    expect(parseSearchQuery('from:2024').fromDate).toBe(new Date(2024, 0, 1).getTime())
  })
  it('to:YYYY は翌年年初（排他）', () => {
    expect(parseSearchQuery('to:2024').toDate).toBe(new Date(2025, 0, 1).getTime())
  })
  it('to:YYYY-MM は翌月1日（排他）', () => {
    expect(parseSearchQuery('to:2024-03').toDate).toBe(new Date(2024, 3, 1).getTime())
  })
  it('2桁年は無効（4桁年のみ受理）', () => {
    expect(parseSearchQuery('from:24').fromDate).toBeNull()
  })
  it('プレフィックスのみなら q は undefined', () => {
    expect(parseSearchQuery('tag:a from:2024').q).toBeUndefined()
  })
})

describe('buildImageQuery', () => {
  const base = { search: '', tagFilters: [] as string[], tagMode: 'and' as const }

  it('選択タグと検索内タグをマージ（重複排除）', () => {
    const q = buildImageQuery({ ...base, search: 'tag:sky', tagFilters: ['sea', 'sky'] })
    expect(new Set(q.tags)).toEqual(new Set(['sea', 'sky']))
  })
  it('タグが無ければ tags は undefined', () => {
    expect(buildImageQuery(base).tags).toBeUndefined()
  })
  it('from→after・to→toDate にマップ（to は翌月1日＝排他上限）', () => {
    const q = buildImageQuery({ ...base, search: 'from:2024-01 to:2024-02' })
    expect(q.after).toBe(new Date(2024, 0, 1).getTime())
    expect(q.toDate).toBe(new Date(2024, 2, 1).getTime())
  })

  it('検索内 site をクエリにマップする', () => {
    const q = buildImageQuery({ ...base, search: 'site:netflix clip' })
    expect(q.site).toBe('netflix')
    expect(q.search).toBe('clip')
  })
})

function makeRow(overrides: Partial<ImageRow>): ImageRow {
  return {
    id: 1, filepath: '/a.png', captured_at: 1000, title: null, current_time: null,
    url: null, colors: null, memo: null,
    thumb_path: null, source: 'capture',
    ...overrides,
  }
}

describe('thumbSrc', () => {
  it('thumb_path があれば kind=thumb', () => {
    expect(thumbSrc(makeRow({ thumb_path: '/t.jpg' }))).toBe('capfile://img?id=1&kind=thumb')
  })
  it('thumb_path が null なら kind=media', () => {
    expect(thumbSrc(makeRow({ thumb_path: null }))).toBe('capfile://img?id=1&kind=media')
  })
})

describe('buildTimeline', () => {
  it('空配列 → グループなし', () => {
    const { groups, ordered } = buildTimeline([], [])
    expect(groups).toHaveLength(0)
    expect(ordered).toHaveLength(0)
  })

  it('同タイトルをグループ化', () => {
    const rows = [
      makeRow({ id: 1, title: '作品A', captured_at: 1000 }),
      makeRow({ id: 2, title: '作品A', captured_at: 2000 }),
    ]
    const { groups } = buildTimeline(rows, [])
    expect(groups).toHaveLength(1)
    expect(groups[0].items).toHaveLength(2)
  })

  it('別タイトルは別グループ', () => {
    const rows = [
      makeRow({ id: 1, title: '作品A', captured_at: 1000 }),
      makeRow({ id: 2, title: '作品B', captured_at: 2000 }),
    ]
    const { groups } = buildTimeline(rows, [])
    expect(groups).toHaveLength(2)
  })

  it('グループは最新 captured_at 順に並ぶ', () => {
    const rows = [
      makeRow({ id: 1, title: '作品A', captured_at: 1000 }),
      makeRow({ id: 2, title: '作品B', captured_at: 3000 }),
      makeRow({ id: 3, title: '作品A', captured_at: 2000 }),
    ]
    const { groups } = buildTimeline(rows, [])
    expect(groups[0].key).toBe('作品B') // 最新が先頭
    expect(groups[1].key).toBe('作品A')
  })

  it('グループ内は current_time 昇順', () => {
    const rows = [
      makeRow({ id: 1, title: '作品A', current_time: 30, captured_at: 1000 }),
      makeRow({ id: 2, title: '作品A', current_time: 10, captured_at: 2000 }),
      makeRow({ id: 3, title: '作品A', current_time: 20, captured_at: 1500 }),
    ]
    const { groups } = buildTimeline(rows, [])
    const times = groups[0].items.map((i) => i.img.current_time)
    expect(times).toEqual([10, 20, 30])
  })

  it('current_time が null の行は末尾', () => {
    const rows = [
      makeRow({ id: 1, title: '作品A', current_time: null, captured_at: 1000 }),
      makeRow({ id: 2, title: '作品A', current_time: 10, captured_at: 2000 }),
    ]
    const { groups } = buildTimeline(rows, [])
    expect(groups[0].items[0].img.current_time).toBe(10)
    expect(groups[0].items[1].img.current_time).toBeNull()
  })

  it('titleStrip を適用してグループキーを生成', () => {
    const rows = [
      makeRow({ id: 1, title: '作品A - Netflix', captured_at: 1000 }),
      makeRow({ id: 2, title: '作品A - Netflix', captured_at: 2000 }),
    ]
    const { groups } = buildTimeline(rows, [' - Netflix'])
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('作品A')
  })

  it('flatIndex は ordered 配列内の正しいインデックスを指す', () => {
    const rows = [
      makeRow({ id: 1, title: '作品A', captured_at: 1000 }),
      makeRow({ id: 2, title: '作品B', captured_at: 2000 }),
    ]
    const { groups, ordered } = buildTimeline(rows, [])
    for (const group of groups) {
      for (const item of group.items) {
        expect(ordered[item.flatIndex]).toBe(item.img)
      }
    }
  })
})
