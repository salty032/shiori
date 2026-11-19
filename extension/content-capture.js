// 撮影・録画の間だけプレーヤーの UI・カーソル・枠線を隠して戻す部分、録画の「準備中」表示、
// 撮る範囲（映像が実際に映っている矩形）の検出。

// キャプチャ中にアニメーション起因でUIが再出現するサービスのコンテナセレクター
// hidePlayerUI 時に該当スコープ配下のアニメーション・トランジションを一時停止する
const FREEZE_SCOPE = {
  'tv.dmm.com': '#vodWrapper',
}

const POST_CAPTURE_RESTORE_DELAY_BY_HOST = {
  'youtube.com': 2800,
  'netflix.com': 2400,
  'tv.dmm.com': 2800,
  'abema.tv': 2200,
  'nicovideo.jp': 1600,
  'video.unext.jp': 2400,
  'animestore.docomo.ne.jp': 3200,
  'disneyplus.com': 2600,
  'amazon.co.jp': 2600,
  'primevideo.com': 2600,
}

const ABEMA_PASSIVE_FEEDBACK_SELECTORS = [
  '[class*="com-vod-VODScreen-player-feedback"]',
  '[class*="com-playback-PlayerFeedback"]',
  '[class*="com-playback-PlayerFeedback__symbol"]',
]
const ABEMA_PASSIVE_RESTORE_POLL_MS = 50
const ABEMA_PASSIVE_RESTORE_MAX_MS = 3000
const SUPPRESS_CAPTURE_KEY_MS = 600
const SUPPRESS_CAPTURE_KEY_HOSTS = new Set([
  'amazon.co.jp',
  'primevideo.com',
])

// bilibili.com の実機で採取したクラス名。`.tv` とは全くの別物なので混ぜない。
// 採取したページは投稿動画（`/video/`）。公式ページ（番剧）で追加のUIが出るなら、
// 見えたものだけをここへ足す。
//
// 消さないものと理由:
//   - 弾幕（`bpx-player-row-dm-wrap` / `bpx-player-adv-dm-wrap` / `bpx-player-bas-dm-wrap` /
//     `bpx-player-cmd-dm-wrap` / `bpx-player-dm-mask-wrap` / `bili-danmaku-x-*` / `bas-danmaku`）
//     — ニコニコと同じくプレーヤー側の設定で消す
//   - 字幕（`bpx-player-subtitle-wrap`）— 他サービスでも字幕は消していない
//   - `bpx-player-context-area` と無名の全画面 div — 中身ごと消えるので使わない
const BILIBILI_COM_PLAYER_UI = [
  '.bpx-player-control-wrap',  // 下部コントロールバー（シークバー・再生・音量・画質）
  '.bpx-player-control-mask',  // その背後の黒いグラデーション
  '.bpx-player-top-wrap',      // 上部のタイトル帯
  // 右下 [64x64 @1036,512] に出る bilibili のアイコン。**一時停止すると出る**ので、
  // コマ送り中は出っぱなしになる（撮るのは止めている間なので必ず写る）。
  // 一度これを外したらキャプチャに写り込んだ。
  '.bpx-player-state-wrap',
  // 採取では他にも出たが、常時は写らないので入れていない。写り込んだら足す:
  //   .bpx-player-toast-wrap（「登录 免费享高清视频…」等の通知・一瞬）
  //   .bpx-player-pbp（高能进度条。コントロールバーの**すぐ上の別要素**［1134x28 @0,555］
  //     なので、上のバーを消しても細い横棒として残りうる）
]

// **これは bilibili.tv（Bstation）のもの。bilibili.com では1つも当たらない**（実機で確認済み）。
// .com は別のプレーヤーで、クラス名の系統から違う。共用しようとして失敗した経緯があるので、
// .com の分が採れても**この配列へ混ぜない**こと。
//
// `player-mobile-play-mask` は覆い本体・一時停止アイコン・送り戻しのアイコンが同じ接頭辞で
// 並ぶので部分一致でまとめて拾う。
//
// `ip-toast` は 10秒送り/戻しの表示と、速度・画質変更時の通知。左右に 72x72 が同じ高さで
// 対になって出る（`--left` / `--right`）ことと、採取中に実際その操作をしていたことで確定。
// `--top` は上中央の小さな通知。向きの違いが同じ接頭辞に並ぶので部分一致で拾う。
const BILIBILI_TV_PLAYER_UI = [
  '.player-mobile-control-bar',        // 下部コントロールバー（再生・時間・画質・速度）
  '[class*="player-mobile-play-mask"]', // 一時停止時の覆い＋中央の再生/一時停止アイコン
  '[class*="ip-toast"]',               // 10秒送り/戻しの表示・速度/画質変更の通知
  '.ip-watermark',                     // 右上の BiliBili ロゴ
]

// サービスごとに非表示にするプレーヤーUI要素のセレクター
// 配列 → inline opacity:0、オブジェクト {hide} → <style> タグで opacity:0 注入（React 再レンダリング対策）
const SERVICE_PLAYER_UI = {
  'youtube.com': [
    '.html5-video-player .ytp-chrome-controls',
    '.html5-video-player .ytp-progress-bar-container',
    '.html5-video-player .ytp-bezel',
    '.html5-video-player .ytp-seek-overlay',
    '.html5-video-player .ytp-fullscreen-metadata',
    '.html5-video-player .ytp-overlay-bottom-right',
    '.html5-video-player .ytp-fullscreen-grid-buttons-container',
    '.html5-video-player .ytp-chrome-top-buttons',
    '.html5-video-player .ytp-playlist-menu-button',
    // Shorts（/shorts/）は対応外。ytp-* とは別系統の要素を個別に持つ必要があり、
    // 投稿者が書いた #shorts を削るかどうかの判断も抱える割に、この用途では使わない。
    // 対応外なので Shorts のプレーヤーUIはキャプチャに写り込む（写るのは見れば分かる）。
  ],
  'tv.dmm.com': [
    '[class*="top-controller-overlay"]',
    '[class*="player-bottom-controller"]',
    '[class*="player-switch-display"]',
  ],
  'video.unext.jp': [
    '[class*="styles__UIContainer"]',
    '[class*="styles__Overlay"]',
    '[class*="styles__GradationTop"]',
    '[class*="styles__GradationBottom"]',
    '[class*="ControlHint__"]',
  ],
  'abema.tv': [
    '[class*="com-vod-VideoControlBar"]',
    '[class*="com-vod-VODScreen__video-control-bg"]',
  ],
  'nicovideo.jp': [
    '[class*="bottom_0"][class*="left_0"][class*="right_0"][class*="trs-prop_[opacity]"]',
    '[class*="pos_absolute"][class*="inset_0"][class*="jc_center"][class*="ai_center"][class*="pointer-events_none"]',
  ],
  'amazon.co.jp': {
    hide: ['[class*="atvwebplayersdk-player-container"]>*:not([class*="atvwebplayersdk-video-surface"])'],
  },
  'primevideo.com': {
    hide: ['[class*="atvwebplayersdk-player-container"]>*:not([class*="atvwebplayersdk-video-surface"])'],
  },
  // Disney+: 旧 .overlay__controls はDOM刷新で消滅。現在は Web Components 化されており、
  // ホスト要素(light DOM)は残るが中身は open/closed shadow のため <style> 注入方式で
  // ホストごと隠す。実際にキャプチャに写り込むものだけを確認しながら1つずつ追加中。
  'disneyplus.com': {
    hide: [
      'ratings-overlay',
      'main-app-controls-overlay',  // 下部コントロールバー（シークバー・再生/一時停止・スキップ等）
      'title-overlay',  // 左上のタイトル・話数表示
    ],
  },
  // Netflix: emotion の難読クラス(default-ltr-iqcdef-cache-*)はビルド毎に変わるため使わず、
  // 安定したセマンティッククラスのみ。動作確認しながら1つずつ追加中。
  // Prime と同じく <style> タグ注入方式（React 再レンダリングで inline style が
  // 消されるのを防ぐ）。難読クラス(default-ltr-iqcdef-cache-*)は不使用。
  'netflix.com': {
    hide: [
      '.watch-video--bottom-controls-container',  // 下部コントロール全体のコンテナ
      '.control-medium',  // 上部の戻るボタン・旗マーク等のコントロールボタン
      '.playback-notification',  // 中央の再生/一時停止・10秒戻し/送りボタン
      '.watch-video--back-container',  // 上部グラデ（左半分）＋戻るボタン
      '.watch-video--flag-container',  // 上部グラデ（右半分）＋旗マーク
      '.watch-video--evidence-overlay-container',  // 放置/一時停止時の作品情報オーバーレイ
      '.advisory-background',  // レーティング表示(+12等)の左上グラデーション背景
    ],
  },
  // Bilibili .com: 中身は BILIBILI_COM_PLAYER_UI を参照。
  'bilibili.com': BILIBILI_COM_PLAYER_UI,
  // Bilibili .tv（Bstation）: 実機で採取したクラス名。`bpx-player-*` ではなく
  // `player-mobile-*` / `bstar-player__*` 系。中身は BILIBILI_TV_PLAYER_UI を参照。
  //
  // 消さないものと理由:
  //   - `player-mobile-danmaku-container`（弾幕）— ニコニコと同じくプレーヤー側の設定で消す
  //   - `player-mobile-ass-subtitle` / `player-mobile-subtitle`（字幕）— 他サービスでも
  //     字幕は消していない（Netflix 等も同様）。消すならここへ足す
  //   - `player-mobile-display`（表示層のまとめ役）— 中身ごと消えるので使わない
  //   - `bstar-player__main-bg`（映像の背面）— 映像に隠れて写らない
  'bilibili.tv': BILIBILI_TV_PLAYER_UI,
  // dアニメストア: 動作確認しながら1つずつ追加中。非ハッシュのセマンティックなクラス名。
  'animestore.docomo.ne.jp': [
    '.buttonArea',     // 下部コントロールバー（ボタン行＋スキップボタン）
    '.seekArea',       // シークバー
    '.pauseInfoWrap',  // 一時停止時の暗転オーバーレイ（情報テキスト含む）
    '.play',           // 一時停止時に中央表示される再生ボタンアイコン
  ],
}

// Netflix の広告つきプランは、一時停止すると数秒で「一時停止広告」を動画全面に重ねる。
// 実機で採取（2026-11-07）：外枠 `[data-uia="depp-pause-ad"]`（1699x956@0,0 で全面）の中に
// 不透明な背景・商品画像・「広告」バッジ・作品パネルと再生ボタンが全部入っている。動画は下に
// 止まったコマのまま残っていて、外枠を display:none にするだけで見えるようになった。
// 中身のクラス名は難読（default-ltr-*-cache-*）なので使わず、外枠 1 個だけを指す。
//
// 広告を消すと、その下にもう 1 枚「ご覧になっている作品」の半透明の作品情報
// （`.watch-video--evidence-overlay-container`）が出る。これも外枠を display:none にして
// 消えることを実機で確認（2026-11-07）。撮影時の SERVICE_PLAYER_UI にも入っているが、
// あちらは撮影の瞬間だけなので、ここで常時にも当てる。
//
// 撮影の瞬間だけでなく**常に**消す（止めて眺めている間も邪魔、という本人の判断）。
// 広告は一時停止のたびに作り直されるので、要素ではなく <style> で当てる。restorePlayerUI が
// 撮影の後始末で外す data-shiori-visrule 等とは別の属性にして、撮影の前後で外れないようにする。
function hideNetflixPauseAd() {
  if (!isNetflix() || document.querySelector('style[data-shiori-netflix-pause-ad]')) return
  const styleEl = document.createElement('style')
  styleEl.setAttribute('data-shiori-netflix-pause-ad', '1')
  styleEl.textContent = '[data-uia="depp-pause-ad"],.watch-video--evidence-overlay-container{display:none!important}'
  document.head.appendChild(styleEl)
}

// 録画中にマウスカーソルが動画へ写り込むのを防ぐ。hidePlayerUI から video:true の
// pre-capture のときだけ呼ばれる（スクショは desktopCapturer のサムネイル取得で
// そもそもカーソルが写らないため、消す必要も効果もない）。
//
// 画面キャプチャ側では消せない。カーソルはキャプチャ経路がフレームへ合成するもので、
// getDisplayMedia の cursor:'never' 制約は Chromium が未実装のため黙って無視される
// （crbug 41456762）。スクショが desktopCapturer のサムネイル取得でカーソル抜きなのに
// 動画だけ写るのはこのため。
//
// 代わりにページ側で OS カーソル自体を消す。ポインタ配下の要素が cursor:none なら
// システムカーソルが空になり、キャプチャ経路には合成すべき絵が存在しなくなる。
// 録画対象は「ブラウザ内の video 要素の矩形」なので、写り込みうる位置＝このページ上であり
// これで実用上ふさがる。
//
// プレーヤーは mousemove のたびに自前の cursor を再設定してくるため、個別要素への
// inline 指定（applyTemporaryStyle）では上書きし返される。全要素へ !important で当てる
// <style> 一枚にすることで、MAX_HIDDEN_ELEMENTS の上限とも無関係になる。
// 撤去は restorePlayerUI の data-shiori-* 一括削除（ウォッチドッグ経由も含む）に任せる。
function hideCursor() {
  const styleEl = document.createElement('style')
  styleEl.setAttribute('data-shiori-nocursor', '1')
  styleEl.textContent = '*,*::before,*::after{cursor:none!important}'
  document.head.appendChild(styleEl)
}

// 隠すはずの UI がページに 1 つも見つからなかったことをアプリへ知らせる（ページの作りが変わったことに
// 本人が気づくため。アプリは診断の目印のある PC でだけログに残す：ext-diag.ts）。ページを開いている間に 1 回。
let playerUiMissingReported = false
function reportPlayerUiMissing(host) {
  if (playerUiMissingReported || !port) return
  playerUiMissingReported = true
  try { port.postMessage({ type: 'player-ui-missing', host }) } catch {}
}

function hidePlayerUI(holdMs, isVideo) {
  restorePlayerUI()
  hideStepReadout()   // コマ送りの読み取り表示は撮影範囲に入る。合図が来たら即消す
  // 失敗・早期 return・post-capture 未達のいずれでも UI が固着しないよう、実際に隠す前に
  // 最後の砦の強制復元を仕込む（隠した要素が 0 でも restorePlayerUI は安全な no-op）。
  // 録画の後始末（コマ通知・準備中の表示）も post-capture でしか片付かないので、ここで
  // 一緒に片付ける。アプリが録画中に落ちると、準備中の表示が映像の上に残り続け、
  // コマ送りの読み取り表示も「録画中」扱いのまま出なくなっていた。holdMs は録画の長さ＋
  // 余裕なので、続いている録画のコマ通知をここで切ることはない。
  hiddenWatchdogTimer = setTimeout(() => {
    hiddenWatchdogTimer = null
    restorePlayerUI()
    stopFrameReporting()
    hideArmingOverlay()
  }, holdMs || HIDDEN_UI_WATCHDOG_MS)
  if (isVideo) hideCursor()
  const host = location.hostname.replace(/^www\./, '')
  startSuppressCaptureKey(host)
  const entry = SERVICE_PLAYER_UI[host]

  if (entry) {
    if (Array.isArray(entry)) {
      // opacity:0 方式 — 子要素の visibility:visible による上書きを防ぐ
      // 複数セレクターが同一要素にマッチした場合、2回目以降はスキップして
      // applyTemporaryStyle が「変更後の値」を元の値として保存するのを防ぐ
      const processed = new Set()
      for (const sel of entry) {
        for (const el of document.querySelectorAll(sel)) {
          if (processed.has(el)) continue
          processed.add(el)
          if (!applyTemporaryStyle(el, 'opacity', '0')) return
          applyTemporaryStyle(el, 'pointer-events', 'none')
        }
      }
      if (processed.size === 0) reportPlayerUiMissing(host)
    } else {
      // <style> タグで注入（React 再レンダリングで inline style が消されるのを防ぐ）
      // transition/animation も止めて、UIがフェードで消える途中が写り込むのを防ぐ
      // （inline 方式の applyTemporaryStyle と同等のフェード停止を <style> 側でも担保）
      const rules = [
        ...(entry.hide || []).map(sel => `${sel}{opacity:0!important;pointer-events:none!important;transition:none!important;animation:none!important}`),
      ]
      if (rules.length > 0) {
        const styleEl = document.createElement('style')
        styleEl.setAttribute('data-shiori-visrule', '1')
        styleEl.textContent = rules.join('')
        document.head.appendChild(styleEl)
      }
      if ((entry.hide || []).length > 0 && !(entry.hide || []).some((sel) => document.querySelector(sel))) {
        reportPlayerUiMissing(host)
      }
    }
  } else {
    // 未対応サービス: 動画 rect と重なる absolute/fixed 要素を opacity:0 で非表示。
    // document 全体の querySelectorAll('*') は重いページでキャプチャ猶予（~300ms）を
    // 超えうるため、動画を内包するプレーヤーらしいコンテナ配下のみに走査範囲を絞る。
    // プレーヤーUIは通常このコンテナのサブツリーに存在する。
    const video = getVideo()
    if (!video) return
    const vr = video.getBoundingClientRect()

    // 動画とほぼ同サイズ（面積比 ≤ 3 倍）の祖先まで遡り、それを走査ルートにする
    const vArea = Math.max(1, vr.width * vr.height)
    let root = video.parentElement
    for (let el = video.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.getBoundingClientRect().width * el.getBoundingClientRect().height <= vArea * 3) root = el
      else break
    }
    const scope = root ?? document.body

    for (const el of scope.querySelectorAll('*')) {
      if (el === video || el.contains(video)) continue
      const pos = getComputedStyle(el).position
      if (pos !== 'absolute' && pos !== 'fixed') continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.left < vr.right && r.right > vr.left && r.top < vr.bottom && r.bottom > vr.top) {
        if (!applyTemporaryStyle(el, 'opacity', '0')) return
        applyTemporaryStyle(el, 'pointer-events', 'none')
      }
    }
  }

  // アニメーション起因でUIが再出現するサービス向け: スコープ内のアニメーションを一時停止
  const freezeScope = FREEZE_SCOPE[host]
  if (freezeScope && document.querySelector(freezeScope)) {
    const styleEl = document.createElement('style')
    styleEl.setAttribute('data-shiori-freeze', '1')
    styleEl.textContent = `${freezeScope} * { animation-play-state: paused !important; animation-duration: 0s !important; transition-duration: 0s !important; }`
    document.head.appendChild(styleEl)
  }

  hideAbemaFeedbackPassively(host)
}

function startSuppressCaptureKey(host) {
  if (!SUPPRESS_CAPTURE_KEY_HOSTS.has(host)) return
  if (suppressKeyTimer) clearTimeout(suppressKeyTimer)
  document.addEventListener('keydown', suppressCaptureKey, true)
  document.addEventListener('keyup', suppressCaptureKey, true)
  document.addEventListener('keypress', suppressCaptureKey, true)
  suppressKeyTimer = setTimeout(stopSuppressCaptureKey, SUPPRESS_CAPTURE_KEY_MS)
}

function stopSuppressCaptureKey() {
  if (suppressKeyTimer) {
    clearTimeout(suppressKeyTimer)
    suppressKeyTimer = null
  }
  document.removeEventListener('keydown', suppressCaptureKey, true)
  document.removeEventListener('keyup', suppressCaptureKey, true)
  document.removeEventListener('keypress', suppressCaptureKey, true)
}

function suppressCaptureKey(event) {
  const key = settingsCaptureKey
  const expectedCode = /^[A-Za-z]$/.test(key) ? `Key${key.toUpperCase()}`
    : /^[0-9]$/.test(key) ? `Digit${key}`
    : /^F([1-9]|1[0-9]|2[0-4])$/.test(key) ? key
    : NAMED_CAPTURE_KEY_CODES[key] ?? null
  const matchesCode = expectedCode !== null && event.code === expectedCode
  const expectedKeyValue = NAMED_CAPTURE_KEY_VALUES[key] ?? key
  const matchesKey = String(event.key || '').toLowerCase() === expectedKeyValue.toLowerCase()
  if (!matchesCode && !matchesKey) return
  event.preventDefault()
  event.stopImmediatePropagation()
}

function applyTemporaryStyle(el, prop, value) {
  if (hiddenEls.length >= MAX_HIDDEN_ELEMENTS) return false
  hiddenEls.push([
    el,
    prop,
    el.style.getPropertyValue(prop),
    el.style.transition,
    el.style.animation,
    el.style.getPropertyPriority(prop)
  ])
  el.style.transition = 'none'
  el.style.animation = 'none'
  el.style.setProperty(prop, value, 'important')
  return true
}

function hideAbemaFeedbackPassively(host) {
  if (host !== 'abema.tv') return
  for (const sel of ABEMA_PASSIVE_FEEDBACK_SELECTORS) {
    for (const el of document.querySelectorAll(sel)) {
      applyPassiveTemporaryStyle(el, 'opacity', '0')
      applyPassiveTemporaryStyle(el, 'pointer-events', 'none')
    }
  }
}

function applyPassiveTemporaryStyle(el, prop, value) {
  if (passiveHiddenEls.some(([savedEl, savedProp]) => savedEl === el && savedProp === prop)) {
    el.style.setProperty(prop, value, 'important')
    return true
  }
  if (passiveHiddenEls.length >= MAX_HIDDEN_ELEMENTS) return false
  passiveHiddenEls.push([
    el,
    prop,
    el.style.getPropertyValue(prop),
    el.style.getPropertyPriority(prop)
  ])
  el.style.setProperty(prop, value, 'important')
  return true
}

function restorePassiveHiddenEls() {
  if (passiveRestoreTimer) {
    clearTimeout(passiveRestoreTimer)
    passiveRestoreTimer = null
  }
  for (const [el, prop, saved, priority] of [...passiveHiddenEls].reverse()) {
    el.style.removeProperty(prop)
    if (saved) el.style.setProperty(prop, saved, priority || '')
  }
  passiveHiddenEls = []
}

function isAbemaFeedbackShown() {
  return [...document.querySelectorAll('[class*="com-vod-VODScreen-player-feedback"]')]
    .some((el) => String(el.className || '').includes('player-feedback--shown'))
}

function schedulePassiveRestoreWhenStable() {
  if (passiveRestoreTimer) clearTimeout(passiveRestoreTimer)
  const deadline = performance.now() + ABEMA_PASSIVE_RESTORE_MAX_MS
  const tick = () => {
    if (!isAbemaFeedbackShown() || performance.now() >= deadline) {
      restorePassiveHiddenEls()
      return
    }
    passiveRestoreTimer = setTimeout(tick, ABEMA_PASSIVE_RESTORE_POLL_MS)
  }
  tick()
}

function restorePlayerUI(options = {}) {
  if (restorePlayerUITimer) {
    clearTimeout(restorePlayerUITimer)
    restorePlayerUITimer = null
  }
  if (hiddenWatchdogTimer) {
    clearTimeout(hiddenWatchdogTimer)
    hiddenWatchdogTimer = null
  }
  stopSuppressCaptureKey()
  document.querySelectorAll('style[data-shiori-freeze], style[data-shiori-visrule], style[data-shiori-nocursor]').forEach(el => el.remove())
  for (const [el, prop, saved, trans, anim, priority] of [...hiddenEls].reverse()) {
    el.style.removeProperty(prop)
    if (saved) el.style.setProperty(prop, saved, priority || '')
    el.style.transition = trans
    el.style.animation = anim ?? ''
  }
  hiddenEls = []
  if (options.deferPassive) {
    schedulePassiveRestoreWhenStable()
  } else {
    restorePassiveHiddenEls()
  }
}

// 復帰までの待ち時間。**クリップ録画だけは待たない。**
//
// ホスト別の待ちはスクリーンショット用に調整された値で、撮影の完了時刻がはっきりしない
// スクショ側では意味がある。一方クリップの合図は「録画が実際に止まった後」（MediaRecorder 停止・
// ストリーム解放の後。app/src/main/video/recording.ts の releaseCaptureUi）にしか来ないので、
// ここで待っても UI が最後のフレームに写り込む余地は無く、**停止から数秒 UI が戻らないだけ**に
// なる。動画は意図して撮るぶん撮った直後に確認したくなるため、その数秒が操作の妨げになる。
function restoreDelayFor(host, immediate) {
  if (immediate) return 0
  return POST_CAPTURE_RESTORE_DELAY_BY_HOST[host] ?? DEFAULT_POST_CAPTURE_RESTORE_DELAY_MS
}

function scheduleRestorePlayerUI(immediate) {
  if (restorePlayerUITimer) clearTimeout(restorePlayerUITimer)
  const host = location.hostname.replace(/^www\./, '')
  const delay = restoreDelayFor(host, immediate)
  restorePlayerUITimer = setTimeout(() => {
    restorePlayerUITimer = null
    restorePlayerUI({ deferPassive: host === 'abema.tv' })
  }, delay)
}

// 録画の「準備中」表示。**記録が始まる前にだけ出し、始まる前に消す**ので録画には写らない。
//
// 出す理由：画面キャプチャの立ち上がりでページがコマを描き落とすため、落ち着くまで記録を
// 始めない作りにした（app 側の waitForSteadyFrames）。その待ち時間が無言だと「押したのに
// 始まらない」になるし、**消えた瞬間が記録開始の合図**にもなる。
//
// 映像の中央に置く。枠の外に出す案は、全画面再生だと外側が無いので出せない。
// 中央なら全画面でも普通に見える（記録前なので汚さない）。
let armingHost = null
function showArmingOverlay(text) {
  hideArmingOverlay()
  const video = getVideo()
  const rect = video?.getBoundingClientRect()
  // 映像が見つからないときは画面中央へ。出さないより出した方がよい（押したことは伝わる）。
  const cx = rect && rect.width > 0 ? rect.left + rect.width / 2 : window.innerWidth / 2
  const cy = rect && rect.height > 0 ? rect.top + rect.height / 2 : window.innerHeight / 2
  const root = (document.fullscreenElement) || document.documentElement
  const host = document.createElement('div')
  host.id = 'shiori-clip-arming'
  const st = host.style
  st.setProperty('position', 'fixed', 'important')
  st.setProperty('left', `${Math.round(cx)}px`, 'important')
  st.setProperty('top', `${Math.round(cy)}px`, 'important')
  st.setProperty('transform', 'translate(-50%, -50%)', 'important')
  st.setProperty('z-index', '2147483647', 'important')
  st.setProperty('pointer-events', 'none', 'important')
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = `
    .box {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 22px; border-radius: 999px;
      font: 600 15px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #fcfcfa; white-space: nowrap;
      background: rgba(12, 15, 20, .88);
      border: 1px solid rgba(255, 255, 255, .16);
      box-shadow: 0 10px 30px rgba(0, 0, 0, .45);
    }
    .dot {
      width: 11px; height: 11px; border-radius: 50%;
      background: #ef4444;
      animation: pulse 1s ease-in-out infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .25 } }
  `
  const box = document.createElement('div')
  box.className = 'box'
  const dot = document.createElement('span')
  dot.className = 'dot'
  const label = document.createElement('span')
  // 文言は app 側（ja.ts が原本）から届く。届いていなければ丸だけ出す —— 拡張が
  // 日本語を持つと、英語表示の人にだけ日本語が出て、こちらからは気づけない。
  label.textContent = text || ''
  box.append(dot, label)
  shadow.append(style, box)
  root.appendChild(host)
  armingHost = host
}

function hideArmingOverlay() {
  if (armingHost) {
    armingHost.remove()
    armingHost = null
  }
  // 全画面へ入る/出る等でホストが取り残された場合の保険（id で拾って消す）。
  document.querySelectorAll('#shiori-clip-arming').forEach((el) => el.remove())
}

function cleanVideoFrame() {
  const video = getVideo()
  if (!video) return
  for (let el = video; el && el !== document.documentElement; el = el.parentElement) {
    const style = getComputedStyle(el)
    if (style.borderRadius !== '0px' && !applyTemporaryStyle(el, 'border-radius', '0')) return
    if (style.outlineStyle !== 'none') applyTemporaryStyle(el, 'outline', 'none')
    if (style.boxShadow !== 'none') applyTemporaryStyle(el, 'box-shadow', 'none')
    if (style.borderTopStyle !== 'none') applyTemporaryStyle(el, 'border-top-color', 'transparent')
    if (style.borderBottomStyle !== 'none') applyTemporaryStyle(el, 'border-bottom-color', 'transparent')
    if (style.borderLeftStyle !== 'none') applyTemporaryStyle(el, 'border-left-color', 'transparent')
    if (style.borderRightStyle !== 'none') applyTemporaryStyle(el, 'border-right-color', 'transparent')
  }
}

// 動画要素の枠内で実際に映像が表示されている領域を返す。
// プレーヤーの縦横比と映像の縦横比が違う場合（letterbox/pillarbox）、
// 黒帯を除いた映像部分だけを返す。objectFit が cover/fill なら枠全体を使う。
function videoContentRect(video, rect) {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return rect
  const fit = getComputedStyle(video).objectFit
  if (fit === 'cover' || fit === 'fill') return rect
  const containerRatio = rect.width / rect.height
  const videoRatio = vw / vh
  if (Math.abs(containerRatio - videoRatio) < 0.01) return rect
  if (videoRatio > containerRatio) {
    // 映像が横長すぎる → 上下に黒帯
    const h = rect.width / videoRatio
    return { left: rect.left, top: rect.top + (rect.height - h) / 2, width: rect.width, height: h }
  } else {
    // 映像が縦長すぎる → 左右に黒帯（dアニメ等で発生）
    const w = rect.height * videoRatio
    return { left: rect.left + (rect.width - w) / 2, top: rect.top, width: w, height: rect.height }
  }
}

function primeVideoSurfaceRect(video) {
  const host = location.hostname.replace(/^www\./, '')
  if (host !== 'amazon.co.jp' && host !== 'primevideo.com') return null
  if (video?.videoWidth > 0 && video?.videoHeight > 0) return null
  const surfaces = Array.from(document.querySelectorAll('[class*="atvwebplayersdk-video-surface"]'))
    .map(surface => surface.getBoundingClientRect())
    .filter(rect => rect.width > 10 && rect.height > 10)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))
  return surfaces[0] ?? null
}

function isFullscreenVideoRect(video, rect) {
  if (!video || !rect) return false
  return rect.left <= 2 && rect.top <= 2
    && rect.right >= window.innerWidth - 2
    && rect.bottom >= window.innerHeight - 2
}

function captureRectForVideo(video, rect) {
  const surfaceRect = primeVideoSurfaceRect(video)
  const baseRect = surfaceRect ?? rect
  // Prime Video: 全画面時に HTML 側のコンテナ矩形と実際の表示域がずれる場合がある。
  // surfaceRect が実際の描画域より小さいため、ビューポート全体を使う。
  if (surfaceRect && document.fullscreenElement && video && !video.videoWidth) {
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
  }
  const fullscreenFallback =
    isFullscreenVideoRect(video, baseRect) &&
    (baseRect.width <= 10 || baseRect.height <= 10)
  const playerRect = fullscreenFallback
    ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
    : baseRect
  return videoContentRect(video, playerRect)
}

// 汎用動画キャプチャの最小モデル。
// manifest の matches は広げず、既存サービス上の挙動も変えない。未対応サイトへ展開する場合は、
// まずこの検出結果（可視 video + 映像実表示 rect + currentTime）を使う。
function detectVideoCaptureTarget() {
  const video = getVideo()
  const rect = video ? video.getBoundingClientRect() : null
  const contentRect = video && rect ? captureRectForVideo(video, rect) : null
  return {
    video,
    currentTime: video ? video.currentTime : null,
    videoRect: contentRect ? { left: contentRect.left, top: contentRect.top, width: contentRect.width, height: contentRect.height } : null,
    // 映像そのものの画素数（画面上の表示サイズではない）。**静止画を無駄に大きく保存しないため
    // だけに送る。** 4K 画面で 1080p の配信を全画面にすると、画面上の映像は高さ 2160 だが
    // videoHeight は 1080 のまま——差のぶんはブラウザが引き伸ばした水増しで、そこを削っても
    // 本物の細かさは減らない。
    //
    // 配信は途中で画質が切り替わる（回線が細ると勝手に落ちる）ので、この値は**送るたびに
    // 測り直す**。アプリ側は撮る直前の返事に入っていた値だけを使う（古い値で縮めると、
    // 本当に 1080p の絵を 480p まで削ってしまう）。
    // メタデータ読み込み前は 0 になるため、そのときは null（＝アプリ側は縮めない）。
    videoSize: video && video.videoWidth > 0 && video.videoHeight > 0
      ? { width: video.videoWidth, height: video.videoHeight }
      : null
  }
}
