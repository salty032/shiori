// タブ名から作品名を読み取る部分（サービスごとの規則と、読めなかったときに前の名前で埋めない仕組み）。

let cachedTitle = ''
let cachedTitleUrl = ''

// DOM が組み直し中に document.title がサービス名だけになるケースを検出
const GENERIC_TITLE_PATTERNS = new Set([
  'youtube', 'abema', 'dmm tv', 'prime video', 'netflix',
  'disney+', 'dアニメストア', '再生', '動画再生', 'u-next', 'ニコニコ動画', 'bilibili', '哔哩哔哩'
])

// 覚えたタイトルは「そのアドレスで読んだもの」として扱い、アドレスが変わったら捨てる。
// 配信サービスの多くは話を切り替えてもページを読み込み直さない（SPA）ため、捨てないと
// cachedTitle だけが前の話のまま残る。切り替え直後は「まだ作品名が読めない一瞬」が
// あるので、そこで撮ると前の話の名前がそれらしい顔で入り、後から気づけない。
// タイトル無しの方がまだ良い（研究用途では、黙って間違っているのが最悪）。
//
// hash は同じ話の中でプレーヤーが書き換えることがあるため無視する。逆に query は
// 話の識別子そのものを載せるサービス（dアニメの partId、YouTube の v）があるので見る。
function currentTitleScope() {
  return `${location.origin}${location.pathname}${location.search}`
}

function getPageTitleCached() {
  const scope = currentTitleScope()
  if (scope !== cachedTitleUrl) {
    cachedTitle = ''
    cachedTitleUrl = scope
  }
  const fresh = getPageTitle()
  const isGeneric = !fresh || GENERIC_TITLE_PATTERNS.has(fresh.toLowerCase())
  if (fresh && !isGeneric) {
    // キャッシュがより詳細（fresh がキャッシュの先頭部分）なら上書きしない
    // 例: キャッシュ="作品名 S1 E1 話タイトル", fresh="作品名" → キャッシュ維持
    if (!cachedTitle || !cachedTitle.startsWith(fresh) || cachedTitle.length <= fresh.length) {
      cachedTitle = fresh
    }
  }
  if (isGeneric && cachedTitle) return cachedTitle
  if (cachedTitle && cachedTitle.startsWith(fresh) && cachedTitle.length > fresh.length) return cachedTitle
  return fresh
}

// bilibili.com の投稿動画のタブ名から、末尾のサイト名だけ落とす。
// `_哔哩哔哩_bilibili` のほか `_哔哩哔哩 (゜-゜)つロ 干杯~-bilibili` の形もあるため、
// `_哔哩哔哩` から末尾の `bilibili` までをまとめて落とす。**前は一切切らない**——
// 作品名に半角 `-` / `_` が入る実例があり（`Spider-Man: No Way Home (2021)`、
// `张少林 - SpiderMan（Official MV）`、末尾が `_` の `原神 MMD 优菈 Eula_`）、
// 「最初の区切りより前」で切ると黙って壊れる。
// サイト名で終わらない形（`…_游戏热门视频` のようにタグだけ）は落とせないので素通しする。
function stripBilibiliTabName(tabName) {
  const stripped = tabName.replace(/_哔哩哔哩.*bilibili\s*$/i, '').trim()
  return stripped && stripped !== tabName ? stripped : ''
}

// サービスによってはタブ名が汎用プレーヤー名になるため DOM を優先する
function getPageTitle() {
  const host = location.hostname.replace(/^www\./, '')

  // YouTube: 末尾の " - YouTube" を除去。ハッシュタグは投稿者が意図した内容の一部として残す
  // （Shorts の #shorts だけ削っていたが、Shorts 自体を対応外にしたのでやめた）。
  if (host === 'youtube.com') {
    // 未読通知があると document.title の先頭に "(3) " 等の件数が付く。内容と無関係な
    // 装飾なので、タイムライン等のグルーピングキーに使われるタイトルからは除去する。
    return document.title.replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, '').trim() || document.title
  }

  // niconico: 末尾の " - ニコニコ動画" を除去
  if (host === 'nicovideo.jp') {
    return document.title.replace(/ - ニコニコ動画$/, '').trim() || document.title
  }

  // Bilibili: タブ名に作品名が入るので、末尾のサイト名と定型句だけ削る（YouTube / niconico と
  // 同じ形）。作品名の本体は推測で削らない——`.tv` は投稿動画が主体で、装飾に見える部分
  // （『』や "DUBBING & SUBBING ENGLISH" のような但し書き）も投稿者が意図した表記のため。
  //
  // **.com と .tv はタブ名の形が全く違う**ので分ける。
  //   .tv:  『 DUBBING & SUBBING ENGLISH 幼女戦記 』 Youjo Senki 1st Season episode 12 - BiliBili
  //   .com: 记忆管理局-国创-高清独家在线观看-bilibili-哔哩哔哩
  if (host === 'bilibili.tv') {
    return document.title.replace(/\s*-\s*bilibili\s*$/i, '').trim() || document.title
  }
  if (host === 'bilibili.com') {
    // 投稿動画のページ（`/video/`）は h1 に**動画全体の名前**を持ち、タブ名には**いま見て
    // いるパートの名前**が入る。分割投稿（分P）だと両者が食い違うので、両方を使って
    // 「作品名 + 話数」にする（他サービスと同じ形）。実物で確認:
    //   /video/BV1XY411o7Cv/?p=2
    //     h1  = 3分钟学会 视频选集 视频合集 视频列表 分p怎么弄   ← 全体
    //     タブ = 手机端添加分p_哔哩哔哩_bilibili               ← パート（2/3）
    //   分割していない動画は両者が一致するので、そのまま1つ分になる:
    //     h1 = Spider-Man: No Way Home (2021) / タブ = 同じ + サイト名
    //     h1 = 原神 MMD 优菈 Eula_（末尾の `_` まで一致）
    //
    // h1 を信じるのは `/video/` のときだけにする。**「公式かどうか」を当てているのではなく、
    // 「実物で h1 の中身を確認できたページか」で分けている。** 公式ページ（番剧）に h1 は
    // 無いことを実機で確認済みだが、他のページ種別（ランキング等）の h1 が何かは見ていない。
    if (location.pathname.startsWith('/video/')) {
      for (const heading of document.querySelectorAll('h1')) {
        const series = heading.textContent?.trim()
        if (!series) continue
        const part = stripBilibiliTabName(document.title)
        if (!part || part === series) return series
        // パート名が全体の名前を丸ごと含む形の分Pがある（言語違いを並べる投稿など。
        // 全体「《原神》奥黛塔角色PV——「柔雪的幻象」」に対しパートが
        // 「英-《原神》奥黛塔角色PV——「柔雪的幻象」」）。そのまま繋ぐと同じ文字が2回出るので、
        // 含む側＝詳しい方だけを使う。
        if (part.includes(series)) return part
        if (series.includes(part)) return series
        return `${series} ${part}`
      }
    }

    // ここから下は h1 を使えないページ用。タブ名は2種類あり、種類ごとに安全な切り方を使う。
    //
    // 【公式ページ】末尾が `-bilibili-哔哩哔哩`。「作品名-ジャンル-(収録範囲)-宣伝文句-サイト名」
    // という並びで、飾りの語は数え上げられない（ジャンルは無数にある）ので**最初の `-` より前**を
    // 作品名とする。
    //   记忆管理局-国创-高清独家在线观看-bilibili-哔哩哔哩              → 记忆管理局
    //   妖神记之黑狱篇-国创-全集-高清正版在线观看-bilibili-哔哩哔哩      → 妖神记之黑狱篇
    //   Re：从零开始的异世界生活 第二季 前半-番剧-全集-…-bilibili-哔哩哔哩 → Re：从零开始的异世界生活 第二季 前半
    //
    // 【投稿動画】末尾が `_哔哩哔哩…bilibili`。**末尾のサイト名だけ落とし、前は一切切らない。**
    //   “原神进入大回忆时代”_哔哩哔哩_bilibili                        → “原神进入大回忆时代”
    //   2020 LG NanoCell 8K HDR 60fps_哔哩哔哩 (゜-゜)つロ 干杯~-bilibili → 2020 LG NanoCell 8K HDR 60fps
    //
    // **投稿動画側で「最初の `-` / `_` より前」をやってはいけない。** 実在するタイトルが壊れる:
    //   Spider-Man: No Way Home (2021)_哔哩哔哩_bilibili   → "Spider" になる
    //   张少林 - SpiderMan（Official MV）_哔哩哔哩_bilibili  → "张少林" になる
    // 中国語のタブ名でも英語のタイトルは普通に混ざるので、半角 `-` は作品名の一部でありうる。
    //
    // 落とせないもの: 末尾がサイト名でなくタグだけの形（`…_游戏热门视频`）。タグを落とすには
    // 「最後の `_` より後ろ」を切るしかないが、それは作品名に `_` が入っている場合と区別が
    // つかない。タグが残るのは画面で見えるが、作品名が切れるのは見えないので、残す方を選ぶ。
    const title = document.title
    if (/-bilibili-哔哩哔哩\s*$/i.test(title)) {
      // 番剧（公式）は右のエピソード一覧で、再生中の行に `Active` が付く。そこから
      // 話数＋話タイトルを取り、他サービスと同じ「作品名 + 話数」にする。
      //   button.PlayerEpisodePanel_episodeRow__X_Ee2.PlayerEpisodePanel_episodeRowActive__5CIAY
      //     └ span.PlayerEpisodePanel_rowTitle__tUWZG  "第1话 在世界末日前回到过去吧"
      // 末尾の `__X_Ee2` はビルドごとに変わるので、変わらない部分だけで指す
      // （U-NEXT の `styles__Title`、ABEMA の `com-video-EpisodeTitle__` と同じ方針）。
      //
      // **行そのものではなく中の `rowTitle` を取る。** 行には `限免`（期間限定無料）等の
      // バッジが子要素として入っており、行の textContent だと
      // 「第2话 陀螺，记忆层，管理员们限免」のようにバッジまで作品名に混ざる。
      const episode = document.querySelector('[class*="episodeRowActive"] [class*="rowTitle"]')?.textContent?.trim()
      // タブ名は話によって変わる。1話目は `记忆管理局`、2話目は `记忆管理局第2集` のように
      // 話数が付く。`episode` 側と二重になるので、末尾の `第N集` は落とす。
      const series = (title.split('-')[0].trim() || title).replace(/第\d+集\s*$/, '').trim()
      return episode ? `${series} ${episode}` : series || title
    }
    return stripBilibiliTabName(title) || title
  }

  // Disney+: 左上タイトル表示の Shadow DOM から作品名 + 話数・サブタイトルを取得
  if (host === 'disneyplus.com') {
    const root = document.querySelector('title-bug')?.shadowRoot
    const title = root?.querySelector('.title-field')?.textContent?.trim()
    const sub = root?.querySelector('.subtitle-field')?.textContent?.trim()
    if (title) return sub ? `${title} ${sub}` : title
    return document.title.replace(/\s*\|\s*Disney\+.*$/, '').trim() || document.title
  }

  // DMM TV: 「タイトル｜アニメ・ドラマの動画配信ならDMM TV」→ 「｜」以前を取得
  // 最大化時などに「DMM TV非常識コスパ｜...」系のプロモ文字列に切り替わる場合は
  // 「DMM TV」で始まるため空文字を返してキャッシュにフォールバックさせる
  if (host === 'tv.dmm.com') {
    if (!document.title.includes('｜')) return ''
    const candidate = document.title.split('｜')[0].replace(/\s*\([^)]+\)\s*$/, '').trim()
    if (!candidate || /^DMM\s*TV/i.test(candidate)) return ''
    return candidate
  }

  // Prime Video: 再生中の video 要素から最も近い player-container を特定し、
  // その中のタイトル・エピソード情報を取得する（複数プレーヤーが同時存在する場合の誤取得を防ぐ）
  if (host === 'amazon.co.jp' || host === 'primevideo.com') {
    let scope = getVideo()
    while (scope && !scope.className?.includes?.('atvwebplayersdk-player-container')) {
      scope = scope.parentElement
    }
    const root = scope || document
    const series  = root.querySelector('[class*="atvwebplayersdk-title-text"]')?.textContent?.trim()
    const episode = root.querySelector('[class*="atvwebplayersdk-episode-info"]')?.textContent?.trim()
    if (series && episode) return `${series} ${episode}`
    if (series || episode) return series || episode
    // タブ名がサイト名で始まるなら、作品のページではなくサイト共通のタブ名なので付けない。
    // 実例：「Prime Video：映画、TV番組、スポーツ番組、ライブTVを視聴できます」がそのまま作品名に入った
    // （2026-10-31。プレーヤーから作品名を読めなかったとき）。作品のページは「Amazon.co.jp: 作品名を観る | Prime Video」で
    // サイト名が末尾に来る。代償：作品名が「Prime Video」で始まる作品は空になる。
    if (/^prime\s*video/i.test(document.title.trim())) return ''
    return document.title.replace(/^Amazon\.co\.jp:\s*/, '').replace(/\s*\|\s*Prime Video$/, '').replace(/を観る$/, '').trim() || document.title
  }

  // ABEMA: DOM から「シリーズ名 + 話数タイトル」を取得
  if (host === 'abema.tv') {
    const series  = document.querySelector('[class*="com-video-EpisodeTitle__series-info"]')?.textContent?.trim()
    const episode = document.querySelector('[class*="com-video-EpisodeTitle__episode-title"]')?.textContent?.trim()
    if (series && episode) return `${series} ${episode}`
    if (series || episode) return (series || episode)
    return document.title.split(' | ')[0].replace(/\s*\([^)]+\)\s*$/, '').trim() || document.title
  }

  // Netflix: document.title が「Netflix」固定のため DOM (data-uia="video-title") から取得。
  // 構造は <h4>シリーズ名</h4><span>エピソードN: </span><span>話タイトル</span>。
  // span 内に Netflix がスクレイピング除けで1文字ごとに挿入するゼロ幅文字(U+FEFF等)を除去する。
  if (host === 'netflix.com') {
    const root = document.querySelector('[data-uia="video-title"]')
    if (root) {
      const strip = (s) => (s || '').replace(/[\uFEFF\u200B\u200C\u200D\u2060]/g, '').trim()
      const series = strip(root.querySelector('h4')?.textContent)
      const rest = [...root.querySelectorAll('span')].map((sp) => strip(sp.textContent)).filter(Boolean).join(' ')
      const parts = [series, rest].filter(Boolean)
      if (parts.length) return parts.join(' ')
      const plain = strip(root.textContent)
      if (plain) return plain
    }
  }

  // dアニメストア: document.title が「動画再生」固定のため DOM から取得
  // backInfoTxt1=シリーズ名、backInfoTxt2=話数(#12)、backInfoTxt3=サブタイトル
  if (host === 'animestore.docomo.ne.jp') {
    const series  = document.querySelector('.backInfoTxt1')?.textContent?.trim()
    const epNum   = document.querySelector('.backInfoTxt2')?.textContent?.trim()
    const epTitle = document.querySelector('.backInfoTxt3')?.textContent?.trim()
    const parts = [series, epNum, epTitle].filter(Boolean)
    if (parts.length) return parts.join(' ')
  }

  // U-NEXT: タブ名が常に「再生 | U-NEXT」固定
  // h2=作品名、h3=話数・サブタイトル を結合して返す
  if (host === 'video.unext.jp') {
    const title = document.querySelector('h2[class*="styles__Title"]')?.textContent?.trim()
    const sub   = document.querySelector('h3[class*="styles__SubTitle"]')?.textContent?.trim()
    if (title) return sub ? `${title} ${sub}` : title
    const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim()
    if (og && og.length > 1) return og
    // タブ名は常に「再生 | U-NEXT」で作品名を含まない。document.title へ落とすと
    // それがそのまま作品名として記録されるため、DMM TV と同じく空を返す。
    return ''
  }

  return document.title
}
