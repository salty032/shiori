// 素材のコマを追う部分（rVFC で「いまどのコマが出ているか」を測る）と、録画中にアプリへ送るコマ通知。
// 拡張の content_scripts は manifest.json の順に同じ isolated world で読み込まれ、関数と変数を共有する
// （分ける前は content.js 1 本だった。読み込んだ瞬間に動く処理は content.js の末尾に置く）。

// 自動検出時はフレーム間隔（秒, float）を直接保持し、整数fps丸めによる
// 23.976/29.97 などのドリフトを避ける
let measuredFrameDur = null
// コマ送りの探索が「隣り合うコマの間隔」として確定させた実測値。再生中の実測（上）が
// 溜まっていない場面（読み込み直後・一時停止のまま操作）でも、1手目の探索で必ず埋まる。
// **設定の自動判定が OFF でも保持する**：これは推定ではなく実測なので、近道の置き場所
// （getSeedFrameSec）には使ってよい。手で fps を指定している間ずっと最小刻みから詰め直す
// のを避けるため。刻みの見積もり（getFrameSec）には設定どおり反映しない。
let stepMeasuredDur = null

// 実測フレーム間隔を採用するのに要るサンプル数。中央値を取るので外れ値1つは無害な一方、
// 溜まるまでは推定値（1/settingsFps, 既定24）で動くため、60fps 素材だと刻みが 2.5 倍になる。
// 少ないほどその窓が短くなる（3サンプル＝24fpsで0.125秒・60fpsで0.05秒の再生）。
const MIN_FRAME_SAMPLES = 3

// rVFC で常時トラッキングする「現在表示中フレーム」の mediaTime（秒）。
// 再生中は毎フレーム更新され、一時停止した瞬間の値＝表示中フレームの開始時刻になる。
// フレームステップはこれを基準にするため、停止直後の1ステップ目から正確に1フレーム動ける。
let lastFrameTime = null
// lastFrameTime が rVFC の実測ではなくコマ送りの楽観更新（推定）で入った値か。
// 推定値は実コマの先頭とは限らないため、コマ長の実測にも着地判定にも使わない。
let lastFrameTimeEstimated = false
// **rVFC が実際に返した最後の mediaTime。画面の読み取り表示に出してよい唯一の値。**
// lastFrameTime はコマ送り中だけ楽観更新（推定）で上書きされるため、そのまま出すと
// 「押したが動かなかった」ときにも数字が動いてしまい、動いた証拠として使えない。
let confirmedFrameTime = null
// いま進行中の1手が始まった時点の confirmedFrameTime（終わりに動いたかを比べる）。
let stepStartedFrom = null

// 常時 rVFC ループ: lastFrameTime の追従と、再生中のフレーム間隔の実測を兼ねる
let frameTrackId = null
let frameTrackVideo = null
let frameDiffs = []
function stopFrameTracker() {
  if (frameTrackVideo && frameTrackId !== null) {
    try { frameTrackVideo.cancelVideoFrameCallback(frameTrackId) } catch {}
    // 録画中にここで止まる＝その瞬間からコマ通知が途切れる。黙って穴を開けると、
    // フレーム表が録画の途中で終わり「後半だけ素材のコマと対応しないクリップ」になる
    // （main 側は範囲外として静かに落とすだけで、ユーザーには何も見えない）。
    if (reportingFrames) reportFrameGap()
  }
  frameTrackId = null
  frameTrackVideo = null
  frameDiffs = []
}
function resetFrameTracking() {
  measuredFrameDur = null
  stepMeasuredDur = null
  lastFrameTime = null
  lastFrameTimeEstimated = false
  confirmedFrameTime = null
  // 待ち行列は前の動画のもの。進行中の1手（stepping）は自分で終わって片付くので触らない。
  pendingSteps = 0
  droppedSteps = 0
  frameDiffs = []
}
function startFrameTracker(video) {
  if (!video || !('requestVideoFrameCallback' in video)) return
  if (frameTrackVideo === video) return
  stopFrameTracker()
  frameTrackVideo = video
  let prev = null
  const onFrame = (now, meta) => {
    if (frameTrackVideo !== video || !document.contains(video)) { stopFrameTracker(); return }
    lastFrameTime = meta.mediaTime
    lastFrameTimeEstimated = false
    confirmedFrameTime = meta.mediaTime
    reportFrame(now, meta, video)
    // フレーム間隔は連続再生中のみ計測（ステップ中のシーク差分で汚さない）
    if (prev !== null && !video.paused) {
      const d = meta.mediaTime - prev
      if (d > 0.005 && d < 0.12) {
        frameDiffs.push(d)
        if (frameDiffs.length > 60) frameDiffs.shift()
        if (frameDiffs.length >= MIN_FRAME_SAMPLES) {
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

// 録画中だけ、素材のコマが1つ進むたびに main へ通知する。
//
// この通知が必要な理由：録画側（recorder.ts）が rVFC を回しているのは「画面キャプチャ
// ストリーム」の video であって、その mediaTime はキャプチャ側の時計なので、素材の絵が
// 同じでも必ず別の値になる。結果、素材が 24fps でも 37fps 分のフレームが記録され、
// コマ送りが素材のコマと対応しない。素材の実コマを知っているのはこちら側だけ。
//
// 送るのは素材自身のタイムライン上の時刻(mediaTime)と、そのコマが画面に出る絶対時刻。
// expectedDisplayTime は「実際に表示される時刻」で、コールバック実行時刻(now)より
// 素材の提示タイミングに近いため優先する。epoch 基準に直すことで、別プロセスである
// main 側の時計と比較できるようにする。
//
// 原点は録画を始めた時点の `Date.now() - performance.now()`。**performance.timeOrigin は使わない。**
// timeOrigin はページを開いた時刻で固定され、その後に Windows が時計を補正するとその幅だけずれる。
// アプリのレコーダー（frame-sink.ts）も録画ごとに同じ取り方をしており、片側だけずれると
// 表の全行がずれて、撮れているコマを撮り逃しと数える（2026-11-02 実測：時計の補正 1.86 秒で 158 コマ）。
let reportingFrames = false
let epochBase = 0
// ==== ここから自動生成: frame-watchdog ====
// 以下は app/src/shared/wire-limits.ts が原本。**手で書き換えない**（verify が落とす）。
// 直すときは wire-limits.ts を変えてから app/ で `npm run ext:limits` を実行する。
// 録画中だけ回す復帰用のウォッチドッグ間隔（ミリ秒）。
//
// rVFC ループは <video> が差し替わる（広告挿入・画質切替）と自分で止まる。復帰が
// タイムコードの定期送信（TIMECODE_POLL_MS）の中の observeVideo 頼みだと、
// **最大 5 秒コマ通知が途切れる**——30 秒クリップなら 1/6 が対応不明になる。録画中だけは
// 短い間隔で生存を確かめる（startFrameTracker は冪等なので、回っていれば何もしない）。
const FRAME_WATCHDOG_MS = 500
// ==== ここまで自動生成: frame-watchdog ====
let frameWatchdog = null
function startFrameReporting() {
  epochBase = Date.now() - performance.now()
  reportingFrames = true
  const video = getVideo()
  if (video) startFrameTracker(video)   // 冪等。録画開始時にループが止まっていても確実に回す
  clearInterval(frameWatchdog)
  frameWatchdog = setInterval(() => {
    const v = getVideo()
    if (v) startFrameTracker(v)
  }, FRAME_WATCHDOG_MS)
}
function stopFrameReporting() {
  reportingFrames = false
  clearInterval(frameWatchdog)
  frameWatchdog = null
}
// コマ通知が途切れたことを 1 回知らせる。**穴が空いたこと自体は隠さない** — 通知が
// 届かなかった区間のコマは、撮り逃しですらなく最初から表に存在しないため、
// 枚数からも割合からも見えない。
function reportFrameGap() {
  if (!port) return
  try { port.postMessage({ type: 'frame-gap' }) } catch {}
}
// presentedFrames は rVFC が返す「合成へ送られたコマの累積数」。**通知が飛んでも、この数は
// 飛んだぶんだけ増えている。** 前後の差から 1 を引けば、通知が来なかったコマ数が推定ではなく
// 実数で出る（app 側 frameGaps）。
//
// 従来は「前後の mediaTime の差 ÷ 間隔の中央値」で数えていた。これは**欠けた区間の刻みが
// 残っている区間と同じ**という仮定の上に乗っており、欠けたコマからは検算できない。1 枚
// 違うだけで、その下のコマ番号が全部ずれる（タイムシートは通し番号を記録している）。
//
// **この値で分かるのは「合成へ送られた」ぶんだけ。** ブラウザがそもそも描かなかったコマは
// ここにも入らないので、その場合は従来の割り算に落ちる。ただし**どちらだったかは区別できる**
// ——差が増えていれば「映っていたが通知が落ちた」で枚数は確定、増えていなければ
// 「そもそも描かれていない」で枚数は推定のまま。app 側はこの区別を measured として持つ（frameGaps）。
//
// 古いブラウザ・古い実装では undefined になりうるので、その場合は送らない（app 側は
// 従来の数え方へ落ちる）。旧版の拡張から届く通知も同じ扱いになる。
//
// thumb はそのコマの絵を 32x32 の白黒（1024 バイト、base64）に縮めたもの。app は録画の画像と絵で照合して、
// どの画像がこのコマかを決める（時刻だけだと、絵が切り替わる境目で隣のコマの画像を選ぶ）。
// DRM の動画は真っ黒にしか読めないので送らない（app は時刻だけで決める）。
let thumbCanvas = null
function frameThumb(video) {
  try {
    const frame = new VideoFrame(video)
    try {
      thumbCanvas ??= new OffscreenCanvas(THUMB_SIZE, THUMB_SIZE)
      const g = thumbCanvas.getContext('2d', { willReadFrequently: true })
      g.drawImage(frame, 0, 0, THUMB_SIZE, THUMB_SIZE)
      const rgba = g.getImageData(0, 0, THUMB_SIZE, THUMB_SIZE).data
      const gray = new Uint8Array(THUMB_SIZE * THUMB_SIZE)
      let lit = 0
      for (let i = 0; i < gray.length; i++) {
        gray[i] = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2])
        if (gray[i] > 8) lit++
      }
      if (lit === 0) return null
      return btoa(String.fromCharCode(...gray))
    } finally {
      frame.close()
    }
  } catch {
    return null
  }
}
function reportFrame(now, meta, video) {
  if (!reportingFrames || !port) return
  const display = Number.isFinite(meta.expectedDisplayTime) ? meta.expectedDisplayTime : now
  try {
    const msg = { type: 'frame', mediaTime: meta.mediaTime, displayAt: epochBase + display }
    const thumb = frameThumb(video)
    if (thumb) msg.thumb = thumb
    if (Number.isFinite(meta.presentedFrames)) msg.presentedFrames = meta.presentedFrames
    // 表示予定の時刻（expectedDisplayTime）は 60Hz の画面で書き換えの刻みと合わなかった。どの時刻が
    // 実際に画面へ出た時刻に近いかを比べるため、合成へ回した時刻とコールバックの時刻も送る（診断用）。
    if (Number.isFinite(meta.presentationTime)) msg.presentedAt = epochBase + meta.presentationTime
    if (Number.isFinite(now)) msg.calledAt = epochBase + now
    port.postMessage(msg)
  } catch {
    reportingFrames = false   // 拡張コンテキスト無効化。次の録画で張り直る
  }
}
