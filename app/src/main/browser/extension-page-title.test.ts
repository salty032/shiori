import { describe, expect, it } from 'vitest'
import { contentJs, extractFunction } from './extension-source'

// extension/content.js の「タブ名・DOM から作品名を取り出す」規則（getPageTitle）の回帰テスト。
//
// **ここは拡張の中でも間違いが画面に出る側**（CLAUDE.md）。セレクターと違って、外した規則は
// そのまま作品名として一覧・タイムライン・書き出しに残る。怖いのは「取れない」ことではなく
// **作品ごとに結果がブレる**ことで、削り過ぎは画面から気づけない。
//
// 使っているタブ名は**すべて content.js のコメントに実物として残っているもの**。推測で作った
// 入力は 1 つも入れていない（実機で見ていない形を通しても、通ったこと自体に意味が無い）。
//
// 読み込みと切り出しは extension-source.ts（content.js は import できないため）。
// location / document / getVideo はスタブを注入して評価する。

type NodeMap = Record<string, FakeNode | FakeNode[]>

interface FakeNode {
  textContent: string | null
  className?: string
  parentElement?: FakeNode | null
  shadowRoot?: FakeNode
  getAttribute(name: string): string | null
  querySelector(sel: string): FakeNode | null
  querySelectorAll(sel: string): FakeNode[]
}

function query(nodes: NodeMap) {
  return {
    querySelector(sel: string): FakeNode | null {
      const hit = nodes[sel]
      if (!hit) return null
      return Array.isArray(hit) ? hit[0] ?? null : hit
    },
    querySelectorAll(sel: string): FakeNode[] {
      const hit = nodes[sel]
      if (!hit) return []
      return Array.isArray(hit) ? hit : [hit]
    },
  }
}

function el(
  text: string | null,
  opts: { nodes?: NodeMap; attrs?: Record<string, string>; className?: string; shadowRoot?: NodeMap } = {}
): FakeNode {
  return {
    textContent: text,
    className: opts.className,
    parentElement: null,
    shadowRoot: opts.shadowRoot ? el(null, { nodes: opts.shadowRoot }) : undefined,
    getAttribute: (name: string) => opts.attrs?.[name] ?? null,
    ...query(opts.nodes ?? {}),
  }
}

const src = `
${extractFunction(contentJs, 'stripBilibiliTabName')}
${extractFunction(contentJs, 'getPageTitle')}
return getPageTitle
`
// eslint-disable-next-line no-new-func
const makeGetPageTitle = new Function('location', 'document', 'getVideo', src) as
  (location: unknown, document: unknown, getVideo: () => FakeNode | null) => () => string

function title(env: { host: string; path?: string; tab?: string; nodes?: NodeMap; video?: FakeNode | null }): string {
  const doc = { title: env.tab ?? '', ...query(env.nodes ?? {}) }
  return makeGetPageTitle(
    { hostname: env.host, pathname: env.path ?? '/' },
    doc,
    () => env.video ?? null
  )()
}

describe('YouTube / niconico - 末尾のサイト名だけ落とす', () => {
  it('" - YouTube" を落とす', () => {
    expect(title({ host: 'youtube.com', tab: 'ワルプルギスの廻天 本予告 - YouTube' })).toBe('ワルプルギスの廻天 本予告')
  })

  // 未読通知の件数はタブ名の先頭に付く。内容と無関係なのに、付いた瞬間だけ別の作品として
  // グルーピングされてしまう。
  it('未読通知の件数を落とす', () => {
    expect(title({ host: 'youtube.com', tab: '(3) ワルプルギスの廻天 本予告 - YouTube' })).toBe('ワルプルギスの廻天 本予告')
  })

  it('" - ニコニコ動画" を落とす', () => {
    expect(title({ host: 'nicovideo.jp', tab: 'テスト動画 - ニコニコ動画' })).toBe('テスト動画')
  })
})

// **.com と .tv はタブ名の形が全く違う。** .tv は投稿動画が主体で、飾りに見える部分も
// 投稿者の表記なので末尾のサイト名しか削らない。
describe('bilibili.tv - サイト名だけ落とし、本体は一切切らない', () => {
  it('『』や但し書きを残す', () => {
    const tab = '『 DUBBING & SUBBING ENGLISH 幼女戦記 』 Youjo Senki 1st Season episode 12 - BiliBili'
    expect(title({ host: 'bilibili.tv', tab }))
      .toBe('『 DUBBING & SUBBING ENGLISH 幼女戦記 』 Youjo Senki 1st Season episode 12')
  })
})

// 投稿動画のページは h1 に「動画全体の名前」、タブ名に「いま見ているパートの名前」が入る。
describe('bilibili.com /video/ - h1（全体）とタブ名（パート）を突き合わせる', () => {
  const at = (h1: string, tab: string): string =>
    title({ host: 'bilibili.com', path: '/video/BV1XY411o7Cv/', tab, nodes: { h1: el(h1) } })

  it('分割投稿は「全体 + パート」にする', () => {
    expect(at('3分钟学会 视频选集 视频合集 视频列表 分p怎么弄', '手机端添加分p_哔哩哔哩_bilibili'))
      .toBe('3分钟学会 视频选集 视频合集 视频列表 分p怎么弄 手机端添加分p')
  })

  it('分割していない動画は 1 つ分になる', () => {
    expect(at('原神 MMD 优菈 Eula_', '原神 MMD 优菈 Eula__哔哩哔哩_bilibili')).toBe('原神 MMD 优菈 Eula_')
  })

  // 言語違いを並べる投稿など、パート名が全体の名前を丸ごと含む形がある。そのまま繋ぐと
  // 同じ文字が 2 回出るので、含む側＝詳しい方だけを使う。
  it('パート名が全体を含むなら、パート名だけを使う', () => {
    expect(at('《原神》奥黛塔角色PV——「柔雪的幻象」', '英-《原神》奥黛塔角色PV——「柔雪的幻象」_哔哩哔哩_bilibili'))
      .toBe('英-《原神》奥黛塔角色PV——「柔雪的幻象」')
  })

  it('全体がパート名を含むなら、全体だけを使う', () => {
    expect(at('英-《原神》奥黛塔角色PV——「柔雪的幻象」', '《原神》奥黛塔角色PV——「柔雪的幻象」_哔哩哔哩_bilibili'))
      .toBe('英-《原神》奥黛塔角色PV——「柔雪的幻象」')
  })
})

// 公式ページは「作品名-ジャンル-(収録範囲)-宣伝文句-サイト名」。飾りの語は数え上げられない
// （ジャンルは無数にある）ので、最初の `-` より前を作品名とする。
describe('bilibili.com 公式ページ - 最初の「-」より前が作品名', () => {
  const at = (tab: string, nodes?: NodeMap): string => title({ host: 'bilibili.com', path: '/bangumi/play/x', tab, nodes })

  it('国创（ジャンル）以降を落とす', () => {
    expect(at('记忆管理局-国创-高清独家在线观看-bilibili-哔哩哔哩')).toBe('记忆管理局')
  })

  it('収録範囲や宣伝文句が増えても同じ切り方で通る', () => {
    expect(at('妖神记之黑狱篇-国创-全集-高清正版在线观看-bilibili-哔哩哔哩')).toBe('妖神记之黑狱篇')
  })

  // **語の一覧を数え上げる形になったら負け筋**（`国创` は消えるが `番剧` は残る、が起きる）。
  // 飾りの語を 1 つも知らずに済んでいることを、ジャンル違いで確かめる。
  it('ジャンルが番剧に変わっても、作品名の側は変わらない', () => {
    expect(at('Re：从零开始的异世界生活 第二季 前半-番剧-全集-高清正版在线观看-bilibili-哔哩哔哩'))
      .toBe('Re：从零开始的异世界生活 第二季 前半')
  })

  // 再生中の行から話数を取る。タブ名にも `第N集` が付くので、二重にならないよう落とす。
  it('再生中の話がある場合は「作品名 + 話数」にし、タブ名側の第N集は落とす', () => {
    const nodes = { '[class*="episodeRowActive"] [class*="rowTitle"]': el('第2话 陀螺，记忆层，管理员们') }
    expect(at('记忆管理局第2集-国创-高清独家在线观看-bilibili-哔哩哔哩', nodes))
      .toBe('记忆管理局 第2话 陀螺，记忆层，管理员们')
  })
})

// 投稿動画は**末尾のサイト名だけ落とし、前は一切切らない。**
describe('bilibili.com 投稿動画 - 前を切ると実在するタイトルが壊れる', () => {
  const at = (tab: string): string => title({ host: 'bilibili.com', path: '/list/x', tab })

  it('サイト名だけ落とす', () => {
    expect(at('“原神进入大回忆时代”_哔哩哔哩_bilibili')).toBe('“原神进入大回忆时代”')
  })

  it('サイト名に顔文字が挟まっていても落とす', () => {
    expect(at('2020 LG NanoCell 8K HDR 60fps_哔哩哔哩 (゜-゜)つロ 干杯~-bilibili')).toBe('2020 LG NanoCell 8K HDR 60fps')
  })

  // ここが本題。中国語のタブ名でも英語のタイトルは普通に混ざるので、半角 `-` は
  // 作品名の一部でありうる。公式ページと同じ切り方をすると "Spider" になる。
  it('作品名に含まれる半角ハイフンで切らない', () => {
    expect(at('Spider-Man: No Way Home (2021)_哔哩哔哩_bilibili')).toBe('Spider-Man: No Way Home (2021)')
  })

  it('区切りに見える半角ハイフンでも切らない', () => {
    expect(at('张少林 - SpiderMan（Official MV）_哔哩哔哩_bilibili')).toBe('张少林 - SpiderMan（Official MV）')
  })

  // 落とせないものの記録。タグを落とすには「最後の `_` より後ろ」を切るしかないが、
  // 作品名に `_` が入っている場合と区別がつかない。**タグが残るのは画面で見えるが、
  // 作品名が切れるのは見えない**ので、残す方を選んでいる。
  it('末尾がサイト名でなくタグだけの形は、タグが残る（承知のうえ）', () => {
    expect(at('原神新角色PV_游戏热门视频')).toBe('原神新角色PV_游戏热门视频')
  })
})

// タブ名が作品名を含まないサービスは、**document.title へ落としてはいけない。**
// 落とすとプレーヤー名や宣伝文句がそのまま作品名として記録される。空を返してキャッシュへ。
describe('タブ名が作品名でないサービス - 空を返して記録させない', () => {
  it('DMM TV: 作品名は「｜」以前', () => {
    expect(title({ host: 'tv.dmm.com', tab: '葬送のフリーレン｜アニメ・ドラマの動画配信ならDMM TV' })).toBe('葬送のフリーレン')
  })

  it('DMM TV: プロモ文字列に切り替わったら空', () => {
    expect(title({ host: 'tv.dmm.com', tab: 'DMM TV非常識コスパ｜アニメ・ドラマの動画配信ならDMM TV' })).toBe('')
  })

  it('DMM TV: 区切りが無ければ空', () => {
    expect(title({ host: 'tv.dmm.com', tab: '読み込み中' })).toBe('')
  })

  it('U-NEXT: h2 と h3 を繋ぐ', () => {
    const nodes = {
      'h2[class*="styles__Title"]': el('葬送のフリーレン'),
      'h3[class*="styles__SubTitle"]': el('第1話 冒険の終わり'),
    }
    expect(title({ host: 'video.unext.jp', tab: '再生 | U-NEXT', nodes })).toBe('葬送のフリーレン 第1話 冒険の終わり')
  })

  it('U-NEXT: DOM が取れなければ空（タブ名は常に「再生 | U-NEXT」）', () => {
    expect(title({ host: 'video.unext.jp', tab: '再生 | U-NEXT' })).toBe('')
  })
})

describe('タブ名が固定のサービス - DOM から組み立てる', () => {
  // Netflix はスクレイピング除けに 1 文字ごとゼロ幅文字を挿入する。残すと同じ話でも
  // 文字列が一致せず、別の作品として並ぶ。
  it('Netflix: ゼロ幅文字を除いてシリーズ名と話数を繋ぐ', () => {
    const root = el('', {
      nodes: {
        h4: el('葬﻿送​のフリーレン'),
        span: [el('エピソード1: '), el('冒‍険の終わり')],
      },
    })
    expect(title({ host: 'netflix.com', tab: 'Netflix', nodes: { '[data-uia="video-title"]': root } }))
      .toBe('葬送のフリーレン エピソード1: 冒険の終わり')
  })

  it('dアニメストア: シリーズ名・話数・サブタイトルを繋ぐ', () => {
    const nodes = { '.backInfoTxt1': el('葬送のフリーレン'), '.backInfoTxt2': el('#1'), '.backInfoTxt3': el('冒険の終わり') }
    expect(title({ host: 'animestore.docomo.ne.jp', tab: '動画再生', nodes })).toBe('葬送のフリーレン #1 冒険の終わり')
  })

  it('ABEMA: シリーズ名と話数タイトルを繋ぐ', () => {
    const nodes = {
      '[class*="com-video-EpisodeTitle__series-info"]': el('葬送のフリーレン'),
      '[class*="com-video-EpisodeTitle__episode-title"]': el('第1話 冒険の終わり'),
    }
    expect(title({ host: 'abema.tv', tab: '無料で見る | ABEMA', nodes })).toBe('葬送のフリーレン 第1話 冒険の終わり')
  })

  it('ABEMA: DOM が取れなければタブ名の「 | 」以前へ落ちる', () => {
    expect(title({ host: 'abema.tv', tab: '葬送のフリーレン | ABEMA' })).toBe('葬送のフリーレン')
  })

  it('Disney+: Shadow DOM からタイトルとサブタイトルを繋ぐ', () => {
    const bug = el(null, {
      shadowRoot: { '.title-field': el('葬送のフリーレン'), '.subtitle-field': el('S1:E1 冒険の終わり') },
    })
    expect(title({ host: 'disneyplus.com', tab: 'Disney+', nodes: { 'title-bug': bug } }))
      .toBe('葬送のフリーレン S1:E1 冒険の終わり')
  })

  // 複数プレーヤーが同時に存在しうるので、再生中の video から親をたどって範囲を絞る。
  it('Prime Video: 再生中のプレーヤーの中からシリーズ名と話数を取る', () => {
    const container = el(null, {
      className: 'atvwebplayersdk-player-container',
      nodes: {
        '[class*="atvwebplayersdk-title-text"]': el('葬送のフリーレン'),
        '[class*="atvwebplayersdk-episode-info"]': el('シーズン1 エピソード1'),
      },
    })
    const video = el(null, {})
    video.parentElement = container
    expect(title({ host: 'primevideo.com', tab: 'Prime Video', video })).toBe('葬送のフリーレン シーズン1 エピソード1')
  })

  it('Prime Video: DOM が取れなければタブ名から定型句を落とす', () => {
    expect(title({ host: 'amazon.co.jp', tab: 'Amazon.co.jp: 葬送のフリーレンを観る | Prime Video' })).toBe('葬送のフリーレン')
  })
})

it('知らないホストではタブ名をそのまま使う', () => {
  expect(title({ host: 'example.com', tab: '何かのページ' })).toBe('何かのページ')
})
