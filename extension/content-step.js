// ブラウザ側のコマ送り（, / .）。1 手ずつ下から詰めて隣のコマへ着地させる探索と、着いた位置の読み取り表示、
// シーク後にサイトが再生を再開してしまうのを抑える見張り。キーを受けるのは key-guard.js。

// コマ送り関連の再生制御。
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
// 実際にシークした時刻（クランプ・ms丸め後）を返す。呼び出し側はこれを比べて
// 「これ以上伸ばしても位置が変わらない」（尺の端）を検出する。
function seekVideo(video, timeSec) {
  let t = Math.max(0, timeSec)
  // 末尾付近での前方コマ送りは尺を超えた ms を内部 API に渡しうる（Netflix ブリッジ側で
  // 不定挙動になる報告あり）。duration が有限なら僅かに手前でクランプしておく。
  if (Number.isFinite(video.duration)) t = Math.max(0, Math.min(video.duration - 0.1, t))
  if (isNetflix()) {
    const ms = Math.round(t * 1000)
    netflixCmd('seek', ms)
    return ms / 1000
  }
  video.currentTime = t
  return t
}

// コマ送りの刻み（秒）。実測があればそれを使うが、これは**狙いを置く初手の位置決め**にしか
// 使わない。1コマ動いたかどうかは着地の実 mediaTime で決める（下記 planFrameStep）。
// まだ測れていないときの見当は 24fps（アニメの素材の多く）。外れても下から詰める回数が増えるだけ。
function getFrameSec() {
  if (measuredFrameDur) return measuredFrameDur
  return 1 / STEP_FALLBACK_FPS
}

// 前進の初手を「まだ同じコマの中」へ置く近道に使う値（秒）。無ければ null＝近道を使わない。
//
// **推定（1/STEP_FALLBACK_FPS）をここに使ってはいけない。** 見積もりが実際のコマ長より
// 長いと初手が次のコマへ入る。行き過ぎは着地の実 mediaTime で検出して捨てるので1手＝1コマ
// は保たれるが、**捨てる前の絵は画面に出てしまう**（進む→戻る→また進む、が見える。
// YouTube は 30/60fps が普通なので 24fps 既定のままだと毎手これになる）。実測が無いうちは
// 後退と同じく最小刻みで下から詰める。1手ぶんシークが数回増えるだけで、見え方は一直線。
//
// 実測の中でも**中央値ではなく一番短いコマ長**を採る。可変フレームレートの動画では中央値が
// 短いコマより長くなりうるので、そこから置いた初手は同じ理由で次のコマへ入る。
function getSeedFrameSec() {
  const observed = frameDiffs.length >= MIN_FRAME_SAMPLES ? Math.min(...frameDiffs) : null
  const known = [observed, measuredFrameDur, stepMeasuredDur].filter((v) => v)
  return known.length ? Math.min(...known) : null
}

// コマ送りの探索に使う定数。対応 fps の範囲（10〜120fps）は startFrameTracker が
// 実測値を採用する条件と揃えてある。
const STEP_PROBE_SEC = 1 / 120       // 上限120fpsのコマ長。これ以下しか進めないシークは必ず同じコマに留まる
const STEP_FALLBACK_FPS = 24         // コマ長をまだ測れていないときの見当（getFrameSec）
const STEP_MAX_FRAME_SEC = 1 / 10    // 下限10fpsのコマ長。ここまで伸ばして動かなければ諦める
const STEP_SAME_FRAME_SEC = 0.001    // mediaTime の変化がこれ未満なら同じコマ
const STEP_SEED_RATIO = 0.9          // 初手を見積もりコマ長の何割手前に置くか（実測の揺らぎ分の余裕）
const STEP_MAX_ATTEMPTS = 16         // 基準確定1 + 初手1 + STEP_PROBE_SEC 刻みで上限まで伸ばす回数
const STEP_LANDING_TIMEOUT_MS = 120  // seeked すら来ない場合の最後の砦
const STEP_SETTLE_FRAMES = 2         // seeked 後、新しい絵の提示を待つ描画フレーム数
const STEP_SEEK_START_MS = 40        // シークが始まった気配（seeking）を待つ上限。実測5msに対する余裕

// 【計測用】コマ送りが1手で実際にどこへ着いたかを Console にそのまま出す。
//
// なぜ要るか — 通知が来なかった区間の枚数（frameGaps）は、presentedFrames で裏が取れない
// 区間（ブラウザがそもそも描かなかったコマ）では、いまも前後の時刻を残りコマの間隔で割った
// 推定でしかない。1枚違うとそこから下のコマ番号が全部ずれるのに、そこには「3コマだ」と
// 言い切る根拠が無い（docs/ANIME-FRAMES.md「抜けの数え方」）。コマ送りは STEP_PROBE_SEC
// 刻みで下から詰めるのでデコーダーが出せるコマを飛び越さない＝**区間を1手ずつ辿って
// 止まった回数がそのまま枚数**になる。それを採るための出口。
//
// mediaTime は丸めない。3コマ(41.708ms刻み)と4コマ(33.4ms刻み)の判別は桁で決まるので、
// 画面表示（showStepReadout）のように読める桁へ落とすと答えが出せない。
//
// 画面には何も出さない。DevTools の Console を開いている間だけ見える。
function stepLog(line) {
  console.log('[Shiori step] ' + line)
}

// 1ステップの初期計画（純粋関数）。
//
// 「1コマ先の表示区間の中央」を一発で狙う方式は、見積もりが実際のコマ長より大きいと
// 黙ってコマを飛ばす（24fps 見積もりで 60fps 素材なら3コマ）。しかも着地は必ず狙い以内に
// 収まるので、飛んだことを着地値からは検出できない。そこで**必ず「下から」詰める**。
// 1刻みを対応上限120fpsのコマ長（STEP_PROBE_SEC）にすると、まだ同じコマに居る位置から
// 1刻み伸ばした先は最悪でも隣のコマ止まりになるため、素材の fps を知らないまま確実に
// 1コマだけ動ける。**実測のコマ長がある場合に限り**、初手をその少し手前へ置く「近道」で
// 詰める回数を減らす（通常2回で着地）。seedDur が null なら近道は使わない（getSeedFrameSec）。
//
// 後退はコマ先頭から僅かに戻せば必ず直前のコマなので、初手から最小刻みでよい（1回で着地）。
// 基準が実コマの先頭か分からないとき（外部シーク直後など）は、まず現在位置へシークして
// 表示中コマの先頭を確定させてから本番の1手に入る（resolving）。
function initialFrameStep(dir, base, dur, exact, seedDur) {
  if (!exact) return { dir, base, dur, seedDur, exact, resolving: true, seeded: false, offset: 0, attempt: 0, target: null }
  const shortcut = dir > 0 && seedDur > 0
  const seed = shortcut ? Math.min(Math.max(seedDur * STEP_SEED_RATIO, STEP_PROBE_SEC), STEP_MAX_FRAME_SEC) : STEP_PROBE_SEC
  return {
    dir, base, dur, seedDur, exact,
    resolving: false,
    // 初手が「同じコマ内」と保証できない置き方か。最小刻みまで縮んだ近道は保証できる側なので
    // 立てない（立てると、動いた着地を隣のコマだと分かっていながら捨ててしまう）。
    seeded: seed > STEP_PROBE_SEC,
    offset: seed * dir,
    attempt: 0,
    target: null
  }
}

// 着地した実 mediaTime から次の一手を決める（純粋関数）。landed=null は
// 「新しい絵が提示されなかった」＝同じコマのまま。
// frameDur は「隣り合うコマの間隔だと確定した実測値」（下から詰めた着地のときだけ返る）。
function planFrameStep(step, landed) {
  if (step.resolving) {
    if (landed === null) {
      // 表示中コマの先頭を確定できなかった。基準確定のシークは定義上いま表示しているコマの
      // 中へ着くので、**同じコマへのシークでは新しい絵が提示されない環境ではここが常に無反応
      // になる**（＝連打のたびに必ず通る道）。ここで打ち切ると押した1手が黙って消えるため、
      // 諦めずに現在位置から下から詰めて隣のコマへ入る。基準がコマ先頭とは限らないので
      // 着地差はコマ長の実測値には採らない（exact は false のまま）が、1刻みが最短コマ長
      // 以下である以上「1手＝ちょうど1コマ」は変わらない。
      return {
        done: false,
        frameDur: null,
        next: {
          ...step, resolving: false, seeded: false, exact: false,
          offset: STEP_PROBE_SEC * step.dir, attempt: step.attempt + 1
        }
      }
    }
    // 表示中コマの先頭が分かったので、そこを基準に取り直して本番の1手へ。
    const resolved = initialFrameStep(step.dir, landed, step.dur, true, step.seedDur)
    return { done: false, frameDur: null, next: { ...resolved, resolving: false, attempt: step.attempt + 1, target: step.target } }
  }
  const progress = landed === null ? 0 : (landed - step.base) * step.dir
  if (progress <= STEP_SAME_FRAME_SEC) {
    // まだ同じコマ。1刻みだけ伸ばす（伸ばし幅が最短コマ長以下なので隣を飛び越さない）。
    const width = Math.abs(step.offset) + STEP_PROBE_SEC
    if (width > STEP_MAX_FRAME_SEC || step.attempt + 1 >= STEP_MAX_ATTEMPTS) return { done: true, frameDur: null }
    return { done: false, frameDur: null, next: { ...step, seeded: false, offset: width * step.dir, attempt: step.attempt + 1 } }
  }
  if (step.seeded) {
    // 見積もりから置いた初手でいきなり動いた＝見積もりが実際のコマ長以上だった。
    // 隣のコマとは限らない（何コマ飛んだかは着地値からは分からない）ので、下から詰め直す。
    return { done: false, frameDur: null, next: { ...step, seeded: false, offset: STEP_PROBE_SEC * step.dir, attempt: step.attempt + 1 } }
  }
  // 下から詰めた末に動いた＝隣のコマ。基準が実コマの先頭なら差はそのままコマ長の実測値。
  return { done: true, frameDur: step.exact ? progress : null }
}

// rVFC ベースの自己補正フレームステップ。
// 表示中フレームの mediaTime(lastFrameTime)を基準に隣のコマへシークし、着地時に rVFC が
// 返す実 mediaTime で「本当に1コマだけ動いたか」を検証して、外れていれば同じステップの中で
// 詰め直す（initialFrameStep / planFrameStep）。fps の見積もりが外れていても
// 1ステップ＝確実に1コマになり、累積ドリフトも発生しない。
let stepSeq = 0
// 実行中アテンプトの後始末（着地待ちタイマーの解除と rVFC の取り消し）。**着地待ちタイマーを
// モジュール変数で共有してはいけない**：遅れて届いた古いステップの着地が、新しいステップの
// 張ったタイマーまで消してしまい、「同じコマへのシークでは rVFC が発火しない」環境で新しい
// 手が待ちっぱなしになる（連打すると1手が黙って不発になり、押した回数とコマ数が食い違う）。
// タイマーはアテンプトのローカルに持ち、追い越し時はこの関数経由で自分の分だけ畳む。
let abortStepAttempt = null

// 連打は**捨てずに溜める**。1手ずつ順に処理し、着地してから次の手に入る。
//
// かつては新しい手が古い手を追い越して畳んでいたため、押した回数と進んだコマ数が食い違った。
// しかも**絵が変わらないのが正常**（コマ打ち。docs/ANIME-FRAMES.md「1 枚の絵を複数コマに割り当てる」）なので、画面からは
// 「進んだが同じ絵」なのか「手が捨てられた」のか区別できず、止まったように見えていた。
// 溜めれば速くもなる：追い越しが無くなると基準が確定済みのまま次へ入れるので、
// 追い越しのたびに踏んでいた「基準を取り直す1シーク」が消える。
const MAX_PENDING_STEPS = 8   // 溜め込みの上限。超えたぶんは捨てて、捨てたことを画面に出す
let stepping = false
let pendingSteps = 0          // 待っている手（前進 +1 / 後退 -1 の差し引き）
let droppedSteps = 0          // 上限を超えて捨てた手（画面に出したら 0 に戻す）

// キー入力の入口。進行中なら待ち行列へ積むだけ。
function requestFrameStep(video, dir) {
  if (stepping) {
    // 行って戻れば同じコマなので差し引きでよい（←→ を混ぜても押した通りの位置に着く）。
    const next = pendingSteps + dir
    if (Math.abs(next) > MAX_PENDING_STEPS) droppedSteps++
    else pendingSteps = next
    showStepReadout(video)
    return
  }
  stepping = true
  stepStartedFrom = confirmedFrameTime
  stepFrame(video, dir)
  showStepReadout(video)
}

// 1手の終わり。**runStepAttempt からの出口はすべてここを通す**（どれか1つでも
// 素通りさせると stepping が立ったままになり、以降の入力が待ち行列で詰まる）。
function endStep(video) {
  sendTimecode({ force: true })
  if (pendingSteps !== 0) {
    const dir = pendingSteps > 0 ? 1 : -1
    pendingSteps -= dir
    stepStartedFrom = confirmedFrameTime
    stepFrame(video, dir)
    showStepReadout(video)
    return
  }
  stepping = false
  showStepReadout(video)
}

function stepFrame(video, dir) {
  const seq = ++stepSeq
  if (abortStepAttempt) abortStepAttempt()
  const dur = getFrameSec()
  // lastFrameTime が現在位置から乖離していれば（外部シーク等）currentTime を基準にし直す。
  const nearCurrent = lastFrameTime !== null && Math.abs(lastFrameTime - video.currentTime) <= dur * 1.5
  const base = nearCurrent ? lastFrameTime : video.currentTime
  // 楽観更新で入った推定値は実コマの先頭とは限らないので、currentTime へ落ちたときと同じく
  // 「先頭が未確定」として扱う（着地からコマ長を実測してよいのは先頭が確定しているときだけ）。
  const exact = nearCurrent && !lastFrameTimeEstimated
  stepLog((dir > 0 ? '前へ' : '後へ') + '  基準=' + base + (exact ? '(実測)' : '(未確定)'))
  // 楽観更新（連打でシーク完了前に次キーが来ても進めるよう移動先フレーム開始を推定）。
  // 着地時に実測 mediaTime で上書き補正される。推定値だと分かるよう印を付け、
  // これを基準にしたステップでは着地差をコマ長の実測値として採用しない。
  lastFrameTime = Math.max(0, base + dir * dur)
  lastFrameTimeEstimated = true
  runStepAttempt(video, seq, initialFrameStep(dir, base, dur, exact, getSeedFrameSec()))
}

function runStepAttempt(video, seq, step) {
  const target = seekVideo(video, step.base + step.offset)
  if (!('requestVideoFrameCallback' in video)) {
    endStep(video)
    return
  }
  // 尺の端でクランプされて前回と同じ位置になったら、これ以上伸ばしても動かない
  if (step.target !== null && Math.abs(target - step.target) < 1e-6) {
    stepLog('  試行' + (step.attempt + 1) + ' → ' + target + ' : シークが動かない（尺の端）')
    endStep(video)
    return
  }
  step.target = target
  let settled = false
  // 着地の presentedFrames（合成へ送られたコマの累積数）。stepLog に添えるためだけに持つ。
  let landedPresented = null
  let cbId = null
  let landingTimer = null
  let settleRaf = null
  let onSeeked = null
  let onSeeking = null
  let seekStartTimer = null
  const cleanup = () => {
    if (landingTimer !== null) { clearTimeout(landingTimer); landingTimer = null }
    if (seekStartTimer !== null) { clearTimeout(seekStartTimer); seekStartTimer = null }
    if (settleRaf !== null) { cancelAnimationFrame(settleRaf); settleRaf = null }
    if (onSeeked) { video.removeEventListener('seeked', onSeeked); onSeeked = null }
    if (onSeeking) { video.removeEventListener('seeking', onSeeking); onSeeking = null }
    if (cbId !== null) { try { video.cancelVideoFrameCallback(cbId) } catch {}; cbId = null }
    if (abortStepAttempt === abort) abortStepAttempt = null
  }
  // 追い越されたときの畳み方。cancelVideoFrameCallback は既に発火待ちのコールバックまでは
  // 止められないので、settled を立てて着地そのものを無効化する（後から届いても何もしない）。
  const abort = () => { settled = true; cleanup() }
  const onLand = (landed) => {
    if (settled) return
    settled = true
    cleanup()
    stepLog('  試行' + (step.attempt + 1) + ' → ' + target
      + (landed === null ? ' : 絵は出なかった' : ' : 着地 ' + landed + ' presented=' + landedPresented)
      + (seq !== stepSeq ? '（追い越されたので捨てる）' : ''))
    if (seq !== stepSeq) return  // 新しいステップに追い越された。この着地は捨てる
    if (landed !== null) { lastFrameTime = landed; lastFrameTimeEstimated = false; confirmedFrameTime = landed }
    const verdict = planFrameStep(step, landed)
    if (verdict.frameDur !== null
      && verdict.frameDur >= STEP_PROBE_SEC && verdict.frameDur <= STEP_MAX_FRAME_SEC) {
      // 探索で確定した隣接コマ間隔は実測値。近道の置き場所に使う。
      stepMeasuredDur = stepMeasuredDur === null ? verdict.frameDur : Math.min(stepMeasuredDur, verdict.frameDur)
      // 刻みの見積もりにも、再生中の中央値が入るまでの暫定として採る。
      if (measuredFrameDur === null) measuredFrameDur = verdict.frameDur
    }
    if (verdict.done) {
      stepLog('確定 ' + (landed === null ? '(動かなかった)' : landed))
      endStep(video)
      return
    }
    runStepAttempt(video, seq, verdict.next)
  }
  cbId = video.requestVideoFrameCallback((_now, meta) => {
    cbId = null
    landedPresented = meta.presentedFrames ?? null
    onLand(meta.mediaTime)
  })
  // 「新しい絵は出なかった」の判定を、固定待ち時間ではなく実イベントで出す。
  //
  // 前進の初手は狙って同じコマの中へ着けるため、同じコマへのシークで rVFC が発火しない
  // 環境では毎手この判定が要る（＝ここの速さがコマ送り全体の体感を決める）。必要なのは
  // 「シークが終わったのに新しい絵が来ない」の確認だけなので、seeked を待ってから描画
  // STEP_SETTLE_FRAMES 回ぶんだけ猶予を置く。新しい絵が出るなら seeked の直後の提示で
  // 来るので、これで取りこぼさずに数十msで結論が出る。
  //
  // 早合点しても壊れないことは刻み方が保証している：仮に本当は動いていたのに「動いて
  // いない」と判定しても、次に伸ばす幅は最短コマ長以下（STEP_PROBE_SEC）なので隣のコマを
  // 飛び越さない。遅れて届いた rVFC も次アテンプトの着地として実 mediaTime で評価される。
  const settleTick = () => {
    settleRaf = null
    if (settled) return
    if (--settleFramesLeft <= 0) { onLand(null); return }
    settleRaf = requestAnimationFrame(settleTick)
  }
  let settleFramesLeft = STEP_SETTLE_FRAMES
  onSeeked = () => {
    if (settled || settleRaf !== null) return
    settleRaf = requestAnimationFrame(settleTick)
  }
  video.addEventListener('seeked', onSeeked)

  // 要求したシークがそもそも始まらなかった場合は、待たずに「同じコマのまま」と結論する。
  //
  // Netflix は独自プレイヤー経由でシークするが、**同じコマの中への細かいシークを黙って
  // 捨てる**（実測：40ms のシークは位置が1msも動かず seeking も来ない。一方 500ms の
  // シークは seeking が 5ms で来て正確に着地する）。前進の初手は狙って同じコマ内へ置く
  // ため、Netflix では毎手これに当たり、最後の砦の 120ms をまるまる待っていた。
  //
  // seeking が来ないことに加えて video.seeking も見るのは、イベントの配送が一瞬詰まった
  // だけの場合に「無視された」と早合点しないため（シーク中なら状態は必ず true になる）。
  // 早合点しても刻み方が飛び越しを防ぐが、Netflix では進行中のシークに次を重ねることに
  // なり無駄が増えるので、状態でもう一段確かめる。
  onSeeking = () => {
    if (seekStartTimer !== null) { clearTimeout(seekStartTimer); seekStartTimer = null }
  }
  video.addEventListener('seeking', onSeeking)
  seekStartTimer = setTimeout(() => {
    seekStartTimer = null
    if (settled || video.seeking) return
    onLand(null)
  }, STEP_SEEK_START_MS)

  // seeked が来ない環境（シークは始まったが完了通知が届かない等）の最後の砦。
  landingTimer = setTimeout(() => { landingTimer = null; onLand(null) }, STEP_LANDING_TIMEOUT_MS)
  abortStepAttempt = abort
}

// ── コマ送りの読み取り表示 ───────────────────────────────────────
//
// **絵が変わらないのが正常**（コマ打ち）なので、押した手が通ったかどうかは画面の絵からは
// 判断できない。確定した再生位置（rVFC が返した実 mediaTime）と待ち数を映像の左下に出し、
// 「数字が動けば通った・動かなければ動いていない」を絵に頼らず読めるようにする。
//
// **撮影中は出さない。** キャプチャ範囲に入るので、出せば録画に焼き込まれる。
const STEP_READOUT_MS = 1200        // 最後の更新から消えるまで
let stepLabels = { blocked: '', dropped: '' }
let stepReadoutTimer = null

function formatMediaTime(sec) {
  const s = Math.max(0, sec)
  const m = Math.floor((s % 3600) / 60)
  const ss = (s % 60).toFixed(3).padStart(6, '0')
  const h = Math.floor(s / 3600)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function hideStepReadout() {
  if (stepReadoutTimer) { clearTimeout(stepReadoutTimer); stepReadoutTimer = null }
  document.getElementById('shiori-step-readout')?.remove()
}

function showStepReadout(video) {
  // 撮影中（UI を隠している間）と録画中は出さない
  if (hiddenWatchdogTimer || reportingFrames) { droppedSteps = 0; hideStepReadout(); return }
  if (confirmedFrameTime === null) return

  const moved = stepStartedFrom !== null && confirmedFrameTime !== stepStartedFrom
  const note = droppedSteps > 0
    ? stepLabels.dropped.replace('{count}', String(droppedSteps))
    : (!stepping && !moved ? stepLabels.blocked : '')
  droppedSteps = 0

  let host = document.getElementById('shiori-step-readout')
  // フルスクリーン時に body 直下が隠されるサイト（niconico 等）向けの置き場所は通知と同じ（content-notice.js）。
  const root = shioriOverlayRoot()
  if (!host) {
    host = document.createElement('div')
    host.id = 'shiori-step-readout'
    const s = host.style
    s.setProperty('position', 'fixed', 'important')
    s.setProperty('z-index', '2147483647', 'important')
    s.setProperty('pointer-events', 'none', 'important')
    s.setProperty('width', 'auto', 'important')
    s.setProperty('height', 'auto', 'important')
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = `
      .readout {
        display: flex;
        align-items: baseline;
        gap: 8px;
        padding: 6px 12px;
        border-radius: 8px;
        color: #fcfcfa;
        background: rgba(20, 24, 31, .92);
        border: 1px solid rgba(255, 255, 255, .16);
        box-shadow: 0 6px 16px rgba(0, 0, 0, .3);
        font: 600 15px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: nowrap;
      }
      .pending { color: #7dd3fc; font-size: 13px; }
      .note { color: #fbbf24; font-size: 12px; font-family: system-ui, sans-serif; }
    `
    const box = document.createElement('div')
    box.className = 'readout'
    shadow.append(style, box)
  }
  if (host.parentElement !== root) root.appendChild(host)

  // 映像の左下へ。動画が動く・大きさが変わるサイトがあるので毎回置き直す。
  const r = video.getBoundingClientRect()
  host.style.setProperty('left', `${Math.round(Math.max(8, r.left + 16))}px`, 'important')
  host.style.setProperty('top', `${Math.round(Math.min(window.innerHeight - 44, r.bottom - 52))}px`, 'important')

  const box = host.shadowRoot?.querySelector('.readout')
  if (box) {
    box.textContent = ''
    const time = document.createElement('span')
    time.textContent = formatMediaTime(confirmedFrameTime)
    box.append(time)
    if (pendingSteps !== 0) {
      const pending = document.createElement('span')
      pending.className = 'pending'
      pending.textContent = `${pendingSteps > 0 ? '+' : ''}${pendingSteps}`
      box.append(pending)
    }
    if (note) {
      const noteEl = document.createElement('span')
      noteEl.className = 'note'
      noteEl.textContent = note
      box.append(noteEl)
    }
  }

  if (stepReadoutTimer) clearTimeout(stepReadoutTimer)
  stepReadoutTimer = setTimeout(hideStepReadout, STEP_READOUT_MS)
}

// コマ送りのシーク後にサイト側が再生を再開してしまうことがあるので、1 秒だけ止め直す見張り。
let stepGuardTimer = null
let stepGuardRelease = null
function stopStepGuard() {
  if (stepGuardTimer) { clearInterval(stepGuardTimer); stepGuardTimer = null }
  if (stepGuardRelease) {
    document.removeEventListener('pointerdown', stepGuardRelease, true)
    document.removeEventListener('keydown', stepGuardRelease, true)
    stepGuardRelease = null
  }
}
function startStepGuard(video) {
  stopStepGuard()
  const deadline = performance.now() + 1000
  stepGuardTimer = setInterval(() => {
    if (performance.now() >= deadline || !document.contains(video)) { stopStepGuard(); return }
    pauseVideo(video)
  }, 50)
  // **人が再生しようとしたら見張りは即やめる。** 見張りは「サイトが勝手に再開した」場合の
  // ためのものなのに、押した本人の再生まで 50ms 以内に止め直していた。コマ送りの直後 1 秒だけ
  // 再生ボタンも Space も効かない状態になり、画面からは原因が読めない（アプリが固まったように
  // 見えるだけ）。クリックでもキーでも、人の操作が来た時点で見張りの役目は終わりとみなす。
  // コマ送りの連打（, / .）だけは解除の合図にしない——連打の途中で再開されては意味が無い。
  stepGuardRelease = (e) => {
    if (e.type === 'keydown' && (e.key === ',' || e.key === '.')) return
    stopStepGuard()
  }
  document.addEventListener('pointerdown', stepGuardRelease, true)
  document.addEventListener('keydown', stepGuardRelease, true)
}

// コマ送りは , / .（アプリのビューア・トリミング画面と同じキー。動画編集ソフトの慣習でもあり、
// 日本語配列では「、」「。」の位置がそのまま前コマ・次コマになる）。ブラウザとアプリで指を
// 使い分けずに済むよう、以前の Shift+←/→ から移した。
//
// **キーを受けるのはこのファイルではなく key-guard.js**（document_start 起動）。理由はそちらに
// 書いてある。ここはコマ送りの中身だけを提供し、動画が無ければ false を返してサイトに任せる。
// 同じ拡張のコンテンツスクリプトは同じ isolated world を共有するので、この代入がそのまま
// key-guard.js から見える。
window.__shioriFrameStepKey = (dir) => {
  const video = getVideo()
  if (!video) return false
  pauseVideo(video)
  startFrameTracker(video)  // 初回接続前でも lastFrameTime を追従できるよう保証（冪等）
  requestFrameStep(video, dir)
  startStepGuard(video)
  return true
}
