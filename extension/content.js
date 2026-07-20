let settingsFps = 24
let settingsFpsAuto = true
// ホットキーのメインキー（例 "Alt+S" なら "S"）。Prime Video 等でのキー抑止（suppressCaptureKey）を
// 実際のキャプチャホットキーに追随させるため、main から settings メッセージで受け取る。
let settingsCaptureKey = 'S'

// shared/hotkey.ts の NAMED_KEYS と対になる、名前付きメインキーの KeyboardEvent.code。
const NAMED_CAPTURE_KEY_CODES = {
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', Return: 'Enter', Escape: 'Escape',
  Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight'
}
// event.key の綴りが正規化済みキー名と一致しないケースのみ個別マップする
// （それ以外の名前付きキーは event.key の綴りがそのまま一致する）。
const NAMED_CAPTURE_KEY_VALUES = { Space: ' ', Return: 'Enter', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' }
function isValidCaptureKey(k) {
  return /^[A-Za-z0-9]$/.test(k) || /^F([1-9]|1[0-9]|2[0-4])$/.test(k) || Object.prototype.hasOwnProperty.call(NAMED_CAPTURE_KEY_CODES, k)
}

// 自動検出時はフレーム間隔（秒, float）を直接保持し、整数fps丸めによる
// 23.976/29.97 などのドリフトを避ける
let measuredFrameDur = null
function getFrameSec() {
  if (settingsFpsAuto && measuredFrameDur) return measuredFrameDur
  return 1 / settingsFps
}

// rVFC で常時トラッキングする「現在表示中フレーム」の mediaTime（秒）。
// 再生中は毎フレーム更新され、一時停止した瞬間の値＝表示中フレームの開始時刻になる。
// フレームステップはこれを基準にするため、停止直後の1ステップ目から正確に1フレーム動ける。
let lastFrameTime = null

// 常時 rVFC ループ: lastFrameTime の追従と、再生中のフレーム間隔の実測を兼ねる
let frameTrackId = null
let frameTrackVideo = null
let frameDiffs = []
function stopFrameTracker() {
  if (frameTrackVideo && frameTrackId !== null) {
    try { frameTrackVideo.cancelVideoFrameCallback(frameTrackId) } catch {}
  }
  frameTrackId = null
  frameTrackVideo = null
  frameDiffs = []
}
function resetFrameTracking() {
  measuredFrameDur = null
  lastFrameTime = null
  frameDiffs = []
}
function startFrameTracker(video) {
  if (!video || !('requestVideoFrameCallback' in video)) return
  if (frameTrackVideo === video) return
  stopFrameTracker()
  frameTrackVideo = video
  let prev = null
  const onFrame = (_now, meta) => {
    if (frameTrackVideo !== video || !document.contains(video)) { stopFrameTracker(); return }
    lastFrameTime = meta.mediaTime
    // フレーム間隔は連続再生中のみ計測（ステップ中のシーク差分で汚さない）
    if (prev !== null && !video.paused) {
      const d = meta.mediaTime - prev
      if (d > 0.005 && d < 0.12) {
        frameDiffs.push(d)
        if (frameDiffs.length > 60) frameDiffs.shift()
        if (frameDiffs.length >= 12) {
          const sorted = [...frameDiffs].sort((a, b) => a - b)
          const median = sorted[Math.floor(sorted.length / 2)]
          const fps = 1 / median
          if (fps >= 10 && fps <= 120) measuredFrameDur = median
        }
      }
    }
    prev = meta.mediaTime
    frameTrackId = video.requestVideoFrameCallback(onFrame)
  }
  frameTrackId = video.requestVideoFrameCallback(onFrame)
}

// rVFC ベースの自己補正フレームステップ。
// 表示中フレームの mediaTime(lastFrameTime)を基準に、隣接フレーム表示区間の中央へシークする。
// 着地後 rVFC が返す実 mediaTime を lastFrameTime に反映するため、fps が多少不正確でも
// 1ステップ＝確実に1フレームになり、累積ドリフトが発生しない。
// Netflix は独自プレイヤーが <video> の状態と再生制御を管理しており、content script から
// currentTime 直書きや pause を行うと再生状態が崩れることがある。そのため Netflix だけは
// main world に注入したブリッジ(netflix-main.js)経由で、ページ側の通常の再生制御に寄せる。
// フレーム位置計算・rVFC 着地補正（読み取り）はそのまま流用できる。
function isNetflix() {
  return location.hostname.replace(/^www\./, '') === 'netflix.com'
}
function netflixCmd(type, value) {
  window.dispatchEvent(new CustomEvent('shiori-nflx-cmd', { detail: { type, value } }))
}
function pauseVideo(video) {
  if (isNetflix()) netflixCmd('pause')
  else { try { video.pause() } catch {} }
}
function seekVideo(video, timeSec) {
  let t = Math.max(0, timeSec)
  // 末尾付近での前方コマ送りは尺を超えた ms を内部 API に渡しうる（Netflix ブリッジ側で
  // 不定挙動になる報告あり）。duration が有限なら僅かに手前でクランプしておく。
  if (Number.isFinite(video.duration)) t = Math.max(0, Math.min(video.duration - 0.1, t))
  if (isNetflix()) netflixCmd('seek', Math.round(t * 1000))
  else video.currentTime = t
}

function stepFrame(video, dir) {
  const dt = getFrameSec()
  // lastFrameTime が現在位置から乖離していれば（外部シーク等）currentTime を基準にし直す
  const anchor = (lastFrameTime !== null && Math.abs(lastFrameTime - video.currentTime) <= dt * 1.5)
    ? lastFrameTime
    : video.currentTime
  const target = dir > 0 ? anchor + dt * 1.5 : anchor - dt * 0.5
  seekVideo(video, target)
  // 楽観更新（連打でシーク完了前に次キーが来ても進めるよう移動先フレーム開始を推定）。
  // rVFC 着地時に実測 mediaTime で上書き補正される。
  lastFrameTime = Math.max(0, anchor + dir * dt)
  if ('requestVideoFrameCallback' in video) {
    video.requestVideoFrameCallback((_now, meta) => {
      lastFrameTime = meta.mediaTime
      sendTimecode({ force: true })
    })
  } else {
    sendTimecode({ force: true })
  }
}

let port = null
let timecodeInterval = null
let ytNavPoll = null
let reconnectScheduled = false
let hiddenEls = []
let passiveHiddenEls = []
let restorePlayerUITimer = null
let passiveRestoreTimer = null
let hiddenWatchdogTimer = null
let suppressKeyTimer = null
const MAX_HIDDEN_ELEMENTS = 300
const DEFAULT_POST_CAPTURE_RESTORE_DELAY_MS = 2400
// post-capture が WS 切断・SW 再起動・main クラッシュ等で届かないと、隠したプレーヤー UI が
// 復元されずページリロードまで固着する。最後の砦として一定時間後に必ず強制復元する。正規フロー
// （pre→post→ホスト別遅延 最大3200ms＋キャプチャ往復）の最悪値より十分長く取り、誤発火を防ぐ。
const HIDDEN_UI_WATCHDOG_MS = 8000
const MAX_TITLE_LENGTH = 500
const MAX_URL_LENGTH = 2048
const MAX_REQUEST_ID_LENGTH = 80
const MAX_NOTICE_MESSAGE_LENGTH = 240
const TIMECODE_POLL_MS = 5000
const MIN_FORCED_SEND_INTERVAL_MS = 250
let lastPayloadKey = ''
let lastSentAt = 0
let observedVideo = null
let cachedTitle = ''
let noticeTimer = null

// DOM が組み直し中に document.title がサービス名だけになるケースを検出
const GENERIC_TITLE_PATTERNS = new Set([
  'youtube', 'abema', 'dmm tv', 'prime video', 'netflix',
  'disney+', 'dアニメストア', '再生', '動画再生', 'u-next', 'ニコニコ動画'
])

// [DIAG] 一時計測フラグ — タイトル欠け／話数欠けの原因切り分け用。調査後に削除する。
const SHIORI_DIAG = true
// [DIAG] getPageTitleCached の最新判定を記録し、request-timecode 応答時にまとめてログ出力する
let lastTitleDiag = null

function getPageTitleCached() {
  const fresh = getPageTitle()
  const cachedBefore = cachedTitle
  const isGeneric = !fresh || GENERIC_TITLE_PATTERNS.has(fresh.toLowerCase())
  if (fresh && !isGeneric) {
    // キャッシュがより詳細（fresh がキャッシュの先頭部分）なら上書きしない
    // 例: キャッシュ="作品名 S1 E1 話タイトル", fresh="作品名" → キャッシュ維持
    if (!cachedTitle || !cachedTitle.startsWith(fresh) || cachedTitle.length <= fresh.length) {
      cachedTitle = fresh
    }
  }
  // 元の3分岐と同じ優先順位を保ったまま、どの分岐で確定したか(branch)を記録する
  let out, branch
  if (isGeneric && cachedTitle) { out = cachedTitle; branch = 'generic->cache' }
  else if (cachedTitle && cachedTitle.startsWith(fresh) && cachedTitle.length > fresh.length) { out = cachedTitle; branch = 'prefix->cache' }
  else { out = fresh; branch = 'fresh' }
  if (SHIORI_DIAG) lastTitleDiag = { fresh, cachedBefore, cachedAfter: cachedTitle, isGeneric, branch, out }
  return out
}

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
    // Shorts（ytd-reel-video-renderer 配下）: 通常プレーヤーの ytp-* とは別系統の要素。
    // ytd-reel-player-overlay-renderer がタイトル・チャンネル名・ハッシュタグ・
    // いいね/コメント/共有/リミックス列をまとめて内包している。
    'ytd-reel-video-renderer .player-controls',
    'desktop-shorts-player-controls',
    'ytd-reel-player-overlay-renderer',
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
  // dアニメストア: 動作確認しながら1つずつ追加中。非ハッシュのセマンティックなクラス名。
  'animestore.docomo.ne.jp': [
    '.buttonArea',     // 下部コントロールバー（ボタン行＋スキップボタン）
    '.seekArea',       // シークバー
    '.pauseInfoWrap',  // 一時停止時の暗転オーバーレイ（情報テキスト含む）
    '.play',           // 一時停止時に中央表示される再生ボタンアイコン
  ],
}

// 録画中にマウスカーソルが動画へ写り込むのを防ぐ。
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

function hidePlayerUI() {
  restorePlayerUI()
  // 失敗・早期 return・post-capture 未達のいずれでも UI が固着しないよう、実際に隠す前に
  // 最後の砦の強制復元を仕込む（隠した要素が 0 でも restorePlayerUI は安全な no-op）。
  hiddenWatchdogTimer = setTimeout(() => {
    hiddenWatchdogTimer = null
    restorePlayerUI()
  }, HIDDEN_UI_WATCHDOG_MS)
  hideCursor()
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

function scheduleRestorePlayerUI() {
  if (restorePlayerUITimer) clearTimeout(restorePlayerUITimer)
  const host = location.hostname.replace(/^www\./, '')
  const delay = POST_CAPTURE_RESTORE_DELAY_BY_HOST[host] ?? DEFAULT_POST_CAPTURE_RESTORE_DELAY_MS
  restorePlayerUITimer = setTimeout(() => {
    restorePlayerUITimer = null
    restorePlayerUI({ deferPassive: host === 'abema.tv' })
  }, delay)
}

function showShioriNotice(level, message) {
  let host = document.getElementById('shiori-browser-notice')
  // フルスクリーン時、サイトによっては body 直下の要素を display:none で隠す CSS がある
  // (niconico 等)。動画の親要素内なら隠されないので、フルスクリーン時はそちらに追加する。
  const fsVideo = document.fullscreenElement ? document.fullscreenElement.querySelector('video') : null
  const noticeRoot = (fsVideo?.parentElement) || document.fullscreenElement || document.documentElement
  if (!host) {
    host = document.createElement('div')
    host.id = 'shiori-browser-notice'
    // サイト側のプレーヤーCSS（フルスクリーン時の全面レイヤー強制スタイル等）に
    // position/サイズを上書きされないよう !important で固定する
    // (例: Prime Video 全画面時、video-surface の親要素配下に追加すると
    //  画面全体に引き伸ばされて消える)
    const hostStyle = host.style
    hostStyle.setProperty('position', 'fixed', 'important')
    hostStyle.setProperty('left', '50%', 'important')
    hostStyle.setProperty('top', '28px', 'important')
    hostStyle.setProperty('right', 'auto', 'important')
    hostStyle.setProperty('bottom', 'auto', 'important')
    hostStyle.setProperty('width', 'auto', 'important')
    hostStyle.setProperty('height', 'auto', 'important')
    hostStyle.setProperty('transform', 'translateX(-50%)', 'important')
    hostStyle.setProperty('z-index', '2147483647', 'important')
    hostStyle.setProperty('pointer-events', 'none', 'important')
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = `
      .notice {
        max-width: min(560px, calc(100vw - 32px));
        box-sizing: border-box;
        padding: 9px 16px 9px 14px;
        border-radius: 8px;
        font: 600 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #fcfcfa;
        background: rgba(20, 24, 31, .98);
        border: 1px solid rgba(255, 255, 255, .18);
        border-left: 4px solid rgba(255, 255, 255, .4);
        box-shadow: 0 8px 22px rgba(0, 0, 0, .28), 0 0 0 1px rgba(0, 0, 0, .18);
        text-shadow: 0 1px 2px rgba(0, 0, 0, .5);
        word-break: break-word;
        opacity: 1;
        transform: translateY(0);
        transition: opacity .28s ease, transform .34s cubic-bezier(.22, 1, .36, 1);
      }
      .notice.hidden {
        opacity: 0;
        transform: translateY(-14px);
      }
      .success { border-left-color: #22c55e; }
      .warning { border-left-color: #eab308; }
      .error { border-left-color: #ef4444; }
    `
    const box = document.createElement('div')
    box.className = 'notice hidden'
    box.setAttribute('role', 'status')
    shadow.append(style, box)
  }
  if (host.parentElement !== noticeRoot) noticeRoot.appendChild(host)

  const box = host.shadowRoot?.querySelector('.notice')
  if (box) {
    box.classList.remove('info', 'success', 'warning', 'error')
    box.classList.add(level)
    box.textContent = message
    // 初期 hidden 状態を 2フレーム後に解除して、ぬるっと出現させる
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.remove('hidden')))
  } else {
    host.textContent = message
  }

  // 成功・情報通知は短めに自動消滅させ、警告・エラーは少し長めに残す
  const dismissAfter = level === 'success' || level === 'info' ? 1800 : 3600
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    noticeTimer = null
    if (!box) {
      host.remove()
      return
    }
    // フェードアウトさせてから除去。新しい通知が来て再表示された場合は除去しない
    box.classList.add('hidden')
    const remove = () => {
      if (box.classList.contains('hidden')) host.remove()
    }
    box.addEventListener('transitionend', remove, { once: true })
    setTimeout(remove, 450)
  }, dismissAfter)
}

// 表示中の通知を即座に消す（フェードなし）。キャプチャ直前に呼び、
// 通知がスクショに焼き込まれたり次の「保存しました」と重なるのを防ぐ。
function clearShioriNotice() {
  if (noticeTimer) {
    clearTimeout(noticeTimer)
    noticeTimer = null
  }
  document.getElementById('shiori-browser-notice')?.remove()
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

function clampNumber(value, fallback, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function getVideo() {
  const all = Array.from(document.querySelectorAll('video'))
  const vis = all.filter(v => {
    const r = v.getBoundingClientRect()
    return r.width > 50 && r.height > 50
      && r.bottom > 0 && r.right > 0
      && r.top < window.innerHeight && r.left < window.innerWidth
  })
  return (vis.length > 0 ? vis : all)
    .sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0] ?? null
}

// サービスによってはタブ名が汎用プレーヤー名になるため DOM を優先する
function getPageTitle() {
  const host = location.hostname.replace(/^www\./, '')

  // YouTube: 末尾の " - YouTube" を除去
  // Shorts はさらに末尾に "#shorts"（全角/半角）が付くことが多く、内容と無関係な
  // 装飾なので除去する（それ以外のハッシュタグは投稿者が意図した内容の一部として残す）
  if (host === 'youtube.com') {
    // 未読通知があると document.title の先頭に "(3) " 等の件数が付く。内容と無関係な
    // 装飾なので、タイムライン等のグルーピングキーに使われるタイトルからは除去する。
    const base = document.title.replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, '').trim() || document.title
    if (location.pathname.startsWith('/shorts/')) {
      const stripped = base.replace(/[#＃]shorts\s*$/i, '').trim()
      if (stripped) return stripped
    }
    return base
  }

  // niconico: 末尾の " - ニコニコ動画" を除去
  if (host === 'nicovideo.jp') {
    return document.title.replace(/ - ニコニコ動画$/, '').trim() || document.title
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
  }

  return document.title
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
    videoRect: contentRect ? { left: contentRect.left, top: contentRect.top, width: contentRect.width, height: contentRect.height } : null
  }
}

function buildPayload() {
  const target = detectVideoCaptureTarget()
  observeVideo(target.video)
  return {
    type: 'timecode',
    // アプリ側でバンドル済み拡張のバージョンと比較し、再読み込み待ちを検出する（UX-9）。
    version: chrome.runtime.getManifest().version,
    currentTime: target.currentTime,
    title: getPageTitleCached().slice(0, MAX_TITLE_LENGTH),
    url: window.location.href.slice(0, MAX_URL_LENGTH),
    focused: document.hasFocus(),
    windowLeft: window.screenLeft,
    windowTop: window.screenTop,
    windowWidth: window.outerWidth,
    windowHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    videoRect: target.videoRect,
    fullscreen: !!document.fullscreenElement
  }
}

function payloadKey(payload) {
  const rect = payload.videoRect
  return JSON.stringify({
    t: payload.currentTime == null ? null : Math.floor(payload.currentTime),
    title: payload.title,
    url: payload.url,
    focused: payload.focused,
    win: [payload.windowLeft, payload.windowTop, payload.windowWidth, payload.windowHeight],
    inner: [payload.innerWidth, payload.innerHeight],
    dpr: payload.devicePixelRatio,
    rect: rect ? [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)] : null
  })
}

function postTimecode(payload, { force = false, bypassThrottle = false } = {}) {
  if (!port) return
  const now = Date.now()
  if (force && !bypassThrottle && now - lastSentAt < MIN_FORCED_SEND_INTERVAL_MS) return
  const key = payloadKey(payload)
  if (!force && key === lastPayloadKey) return
  lastPayloadKey = key
  lastSentAt = now
  port.postMessage(payload)
}

const VIDEO_EVENTS = ['play', 'pause', 'seeked', 'loadedmetadata']
let observedHandler = null
let fpsMetaHandler = null
function observeVideo(video) {
  if (!video || video === observedVideo) return
  if (observedVideo && observedHandler) {
    for (const eventName of VIDEO_EVENTS) observedVideo.removeEventListener(eventName, observedHandler)
    if (fpsMetaHandler) observedVideo.removeEventListener('loadedmetadata', fpsMetaHandler)
  }
  observedVideo = video
  observedHandler = () => sendTimecode({ force: true })
  for (const eventName of VIDEO_EVENTS) {
    video.addEventListener(eventName, observedHandler, { passive: true })
  }
  // メディア差し替え時は実測フレーム情報をリセットし、トラッカーを張り直す
  fpsMetaHandler = () => { resetFrameTracking(); stopFrameTracker(); startFrameTracker(video) }
  video.addEventListener('loadedmetadata', fpsMetaHandler, { passive: true })
  resetFrameTracking()
  startFrameTracker(video)
}

// 定期送信 — 動画が再生中なら送信、フォーカスがなくて動画も止まっているタブはスキップ
function sendTimecode(options = {}) {
  if (!port) return
  const video = getVideo()
  if (!document.hasFocus() && (!video || video.paused)) return
  postTimecode(buildPayload(), options)
}

// Electron の request-timecode に応答 — フォーカス不問
// immediate=false（スクリーンショット用）: rAF を2回重ねて
//   1回目: スタイル変更がレイアウト・ペイントに反映されるフレームを消費
//   2回目: ペイント後に発火 → その時点でタイムコードを返す
// immediate=true（録画用）: rAF なしで即時応答（UI 変更がないため rAF 不要）
function sendTimecodeNow(requestId, immediate) {
  if (!port) return
  const payload = buildPayload()
  if (requestId != null) {
    payload.requestId = requestId
    // [DIAG] キャプチャ要求（request-timecode）到達時点のタイトル状態を payload に載せる。
    // main が userData/title-diag.log に書き出す。fresh=生DOM読み, branch=キャッシュ判定分岐。
    if (SHIORI_DIAG) {
      const diag = {
        host: location.hostname.replace(/^www\./, ''),
        hasVideo: !!getVideo(),
        docTitle: document.title,
        sentTitle: payload.title,
        ...(lastTitleDiag || {})
      }
      // [DIAG] クロップ見切れ調査: このタブの全<video>の実測rect・選択されたvideoRect・
      // ウィンドウ座標・フォーカス状態を添付する。vids の各要素は
      // [left, top, width, height, videoWidth, videoHeight, paused] の圧縮表現。
      diag.geo = {
        vids: [...document.querySelectorAll('video')].map((v) => {
          const r = v.getBoundingClientRect()
          return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), v.videoWidth, v.videoHeight, v.paused ? 1 : 0]
        }),
        sel: payload.videoRect
          ? [Math.round(payload.videoRect.left), Math.round(payload.videoRect.top), Math.round(payload.videoRect.width), Math.round(payload.videoRect.height)]
          : null,
        win: [payload.windowLeft, payload.windowTop, payload.windowWidth, payload.windowHeight, payload.innerWidth, payload.innerHeight],
        dpr: payload.devicePixelRatio,
        fs: payload.fullscreen ? 1 : 0,
        focus: document.hasFocus() ? 1 : 0
      }
      payload.diagJson = JSON.stringify(diag).slice(0, 2000)
      console.log('[Shiori][diag]', JSON.stringify({ reqId: requestId, ...diag }))
    }
    if (immediate) {
      postTimecode(payload, { force: true, bypassThrottle: true })
    } else {
      requestAnimationFrame(() => requestAnimationFrame(() => postTimecode(payload, { force: true, bypassThrottle: true })))
    }
  } else {
    postTimecode(payload, { force: true })
  }
}

// SW の WS が切れたとき、または SW 自体が死んだときにポートを張り直す
// これにより SW が再起動して WS も再接続される
function scheduleReconnect() {
  if (reconnectScheduled) return
  reconnectScheduled = true
  const dying = port
  port = null
  clearInterval(pingInterval)
  try { dying?.disconnect() } catch {}
  setTimeout(() => {
    reconnectScheduled = false
    connectPort()
  }, 1000)
}

function normalizePortMessage(msg) {
  if (!msg || typeof msg !== 'object') return null
  if (msg.type === 'ws-connected') return { type: 'ws-connected' }
  if (msg.type === 'ws-disconnected') return { type: 'ws-disconnected' }
  if (msg.type === 'pre-capture') return { type: 'pre-capture' }
  if (msg.type === 'post-capture') return { type: 'post-capture' }
  if (msg.type === 'notice') {
    const level = ['info', 'success', 'warning', 'error'].includes(msg.level) ? msg.level : 'info'
    const message = typeof msg.message === 'string' ? msg.message.slice(0, MAX_NOTICE_MESSAGE_LENGTH) : ''
    return message ? { type: 'notice', level, message } : null
  }
  if (msg.type === 'request-timecode') {
    return {
      type: 'request-timecode',
      requestId: typeof msg.requestId === 'string' ? msg.requestId.slice(0, MAX_REQUEST_ID_LENGTH) : undefined,
      immediate: msg.immediate === true
    }
  }
  if (msg.type === 'settings') {
    const rawKey = typeof msg.captureKey === 'string' ? msg.captureKey : ''
    return {
      type: 'settings',
      frameFps: clampNumber(Number(msg.frameFps), 24, 1, 240),
      frameFpsAuto: msg.frameFpsAuto !== false,
      captureKey: isValidCaptureKey(rawKey) ? rawKey : 'S'
    }
  }
  return null
}

// 動画が一時停止中かつタブ非フォーカスだと sendTimecode が送られず port/WS が無通信になり、
// Chrome が MV3 Service Worker をアイドル停止 → port 切断 → SW 再起動というチャーンが起きる。
// 無通信を防ぐため、接続中は一定間隔で ping を送って SW/WS 双方のアイドルタイマーを更新する。
const PING_INTERVAL_MS = 20000
let pingInterval = null

function connectPort() {
  if (port) return

  try {
    port = chrome.runtime.connect({ name: 'shiori' })
  } catch {
    return  // 拡張コンテキスト無効
  }

  clearInterval(pingInterval)
  pingInterval = setInterval(() => {
    try { port?.postMessage({ type: 'ping' }) } catch {}
  }, PING_INTERVAL_MS)

  port.onMessage.addListener((msg) => {
    const safeMsg = normalizePortMessage(msg)
    if (!safeMsg) return

    if (safeMsg.type === 'ws-connected') {
      console.log('[Shiori] connected')
      clearInterval(timecodeInterval)
      lastPayloadKey = ''
      timecodeInterval = setInterval(sendTimecode, TIMECODE_POLL_MS)
      sendTimecode({ force: true })
    } else if (safeMsg.type === 'ws-disconnected') {
      console.log('[Shiori] disconnected')
      clearInterval(timecodeInterval)
      scheduleReconnect()  // SW の WS が切れた → ポートを張り直して SW を再起動
    } else if (safeMsg.type === 'request-timecode') {
      sendTimecodeNow(safeMsg.requestId, safeMsg.immediate)
    } else if (safeMsg.type === 'settings') {
      settingsFps = safeMsg.frameFps
      settingsFpsAuto = safeMsg.frameFpsAuto
      settingsCaptureKey = safeMsg.captureKey
    } else if (safeMsg.type === 'pre-capture') {
      clearShioriNotice()
      hidePlayerUI()
      cleanVideoFrame()
    } else if (safeMsg.type === 'post-capture') {
      scheduleRestorePlayerUI()
    } else if (safeMsg.type === 'notice') {
      showShioriNotice(safeMsg.level, safeMsg.message)
    }
  })

  port.onDisconnect.addListener(() => {
    port = null
    clearInterval(timecodeInterval)
    clearInterval(pingInterval)
    scheduleReconnect()  // SW が死んだ → 同様に再接続
  })
}

let stepGuardTimer = null
function startStepGuard(video) {
  if (stepGuardTimer) clearInterval(stepGuardTimer)
  const deadline = performance.now() + 1000
  stepGuardTimer = setInterval(() => {
    if (performance.now() >= deadline || !document.contains(video)) {
      clearInterval(stepGuardTimer)
      stepGuardTimer = null
      return
    }
    pauseVideo(video)
  }, 50)
}

document.addEventListener('keydown', (e) => {
  if (!e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
  const target = e.target
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
  const video = getVideo()
  if (!video) return
  e.preventDefault()
  e.stopPropagation()
  pauseVideo(video)
  startFrameTracker(video)  // 初回接続前でも lastFrameTime を追従できるよう保証（冪等）
  stepFrame(video, e.key === 'ArrowRight' ? 1 : -1)
  startStepGuard(video)
}, true)

window.addEventListener('focus', () => sendTimecode({ force: true }))
window.addEventListener('pagehide', () => {
  clearInterval(timecodeInterval)
  clearInterval(ytNavPoll)
  clearInterval(pingInterval)
  restorePlayerUI()
})

// YouTube SPA ナビゲーション後、動画要素とタイトルが揃うまでポーリングして再送
document.addEventListener('yt-navigate-finish', () => {
  clearInterval(ytNavPoll)
  cachedTitle = '' // 前の動画のタイトルを新しい動画に持ち越さない
  let ticks = 0
  ytNavPoll = setInterval(() => {
    ticks++
    const video = getVideo()
    const titleReady = document.title && document.title !== 'YouTube'
    if ((video && titleReady) || ticks >= 50) {
      clearInterval(ytNavPoll)
      ytNavPoll = null
      sendTimecodeNow()
    }
  }, 100)
})

connectPort()
