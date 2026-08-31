import { app, dialog, globalShortcut, Menu, session } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { stopWsServer, broadcastMessage, onExtensionMessage, setAllowedExtensionIds, onPortInUse } from './browser/ws-server'
import { WS_PORTS } from '../shared/wire-limits'
import {
  registerHotkey, changeHotkey, onCaptureDone, setSourceVideoSize,
  setPreCaptureHook, setPostCaptureHook, canCaptureVideo, setBlackFrameHook,
  runPreCaptureGuards, SilentCaptureAbort
} from './capture/capture'
import { databasePath, consumeDbBackupFailure } from './db-schema'
import { registerCapturedMedia } from './capture/captured-media'
import type { MainFeature } from './feature'
import { loadSettings, saveSettings, flushSettings, consumeSettingsLoadProblem, onSettingsPersistFailed, stripDedicatedSettingKeys } from './system/settings'
import { activeTaskLabels } from './system/busy'
import { checkExtensionUpdate, installedExtensionPath } from './browser/extension-updater'
import { startExtensionBridge, browserStepLabels } from './browser/extension-bridge'
import { migrateThumbnailsToOwnDir } from './capture/migrate-thumbnails'
import { sweepOrphanFilesIfDue } from './capture/sweep-orphans'
import { initAutoUpdater, quitAndInstallUpdate } from './system/updater'
import { thumbPathFor } from './system/paths'
import { registerCapfileScheme, registerCapfileProtocol } from './system/capfile-protocol'
import { normalizeCaptureHotkey, captureHotkeyMainKey } from './browser/hotkey'
import { createImageThumb } from './capture/image-thumb'
import {
  getMainWindow, setQuitting,
  sendToRenderer, sendNotice, showMainWindow, isMainWindowFocused,
  handleTrusted,
  createWindow
} from './system/windows'
import { createTray, rebuildTrayMenu } from './system/tray'
import { isStartupLaunch, isOpenAtLogin, setOpenAtLogin, migrateStartupArgs } from './system/startup'
import { getLastTimecode, getLastTimecodeAt, setLastTimecode } from './browser/timecode'
import { registerImageHandlers, backfillThumbnails } from './ipc/ipc-images'
import { registerDragHandlers, cleanupDragTempDir } from './ipc/ipc-drag'
import { registerTaggerHandlers } from './ipc/ipc-tagger'
import { registerShareHandlers } from './ipc/ipc-share'
import { registerImportHandlers } from './ipc/ipc-import'
import { registerShellHandlers } from './ipc/ipc-shell'
import { sendBrowserNotice } from './browser/browser-notice'
import { recheckMarkedClips } from './video/verify-clip'
import { backfillFrameCounts } from './db-video-frames'
import { decideVersionNotice } from './system/version-notice'
import { releaseNotesFor } from '../shared/releaseNotes'
import { CH } from '../shared/api'
import { waitForPreferredTimecode, type CaptureTimecode } from './browser/timecode-request'
import { t } from './system/i18n'
import { describeStartupError } from './system/startup-error'
import { consumeRestoreMarker } from './system/db-maintenance'
import { openDatabaseOrRecover, backupDateLabel } from './system/db-startup'

// renderer への送信は mainWindow の初回描画前だと無言で消えるため、読み込み中なら描画後に送る。
// 既に読み込み済みなら did-finish-load はもう発火しないので、その場で送る（EADDRINUSE の
// ように到着タイミングが読めない通知は、once() だけに頼ると取りこぼす）。
function whenRendererReady(fn: () => void): void {
  const wc = getMainWindow()?.webContents
  if (!wc) return
  if (wc.isLoading()) wc.once('did-finish-load', fn)
  else fn()
}

function sendNoticeWhenRendererReady(level: 'info' | 'warning' | 'error', message: string): void {
  whenRendererReady(() => sendNotice(level, message))
}

// 更新を適用するとプロセスが終了するため、取り込み・書き出し・AIタグ付け等が
// 走っていると途中で止まる（DB は書けたところまで残るので破損はしないが、
// 「取り込み途中」「書き出し途中」の状態にはなる）。バナーは進行中でも押せるので、
// ここで引き止める。renderer に busy 状態を配らずに済むよう main 側で確認する。
async function confirmUpdateWhileBusy(): Promise<boolean> {
  const labels = activeTaskLabels()
  if (labels.length === 0) return true

  const options = {
    type: 'warning' as const,
    buttons: [t('dialog.updateBusy.proceed'), t('dialog.updateBusy.cancel')],
    defaultId: 1,
    cancelId: 1,
    title: t('dialog.updateBusy.title'),
    message: t('dialog.updateBusy.message', { tasks: labels.join(t('list.separator')) }),
    detail: t('dialog.updateBusy.detail')
  }
  const win = getMainWindow()
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  return response === 0
}

// ブラウザ側 , / . の読み取り表示に出す文言。**拡張は文言を持たない**（原本は ja.ts）ので
// settings メッセージに載せて配る。言語変更時も設定保存の再送に乗る。
export function bootstrap(features: MainFeature[] = []): void {
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
  app.enableSandbox()

  // 開発時は userData をインストール版から分離する。
  //
  // dev もパッケージ版も app 名が "Shiori" なので、既定では両者の userData が同じ
  // %APPDATA%\Shiori を指す。userData は直後の requestSingleInstanceLock が使う鍵でも
  // あるため、常駐中（openAtLogin）のインストール版がロックを握っていると、npm run dev
  // で起動した dev 版がロックを取れずに即 quit し、代わりにインストール版が
  // second-instance ハンドラで前面に出てくる。「dev したのに古い版が起動する」ように
  // 見える現象の正体がこれで、インストール版が常駐しているかどうかで再現が変わる。
  //
  // 分離すればロックも DB も設定も独立するので、常駐したまま dev を起動できる。
  // 開発中の操作で本番ライブラリを壊す心配も無くなる（代わりに dev 側のライブラリは空）。
  // setPath は必ず requestSingleInstanceLock より前で呼ぶこと。後ろだと鍵が既定パスの
  // ままロックが取られ、分離の意味が無くなる。
  if (!app.isPackaged) {
    const devUserData = join(app.getPath('appData'), `${app.getName()}-dev`)
    // setPath は存在しないディレクトリを渡すと throw するため、先に作っておく。
    mkdirSync(devUserData, { recursive: true })
    app.setPath('userData', devUserData)
    console.log('[Shiori][dev] userData:', devUserData)
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.setAppUserModelId('com.shiori.app')

  app.on('second-instance', () => {
    showMainWindow()
  })

  // capfile:// のスキーム宣言は app.whenReady() より前に済ませる必要がある
  registerCapfileScheme()

  const CAPTURE_TIMECODE_TIMEOUT_MS = 900
  const CAPTURE_FALLBACK_TIMECODE_MAX_AGE_MS = 1500

  let pendingTimecode: Promise<CaptureTimecode | null> | null = null
  // pre-capture を実際にブラウザへ送ったかどうかのフラグ。post-capture（UI復帰）を pre-capture と
  // 対称に送るための旗。Shiori 前面・ガードでの中断など pre-capture を送る前に中止した
  // ケースでは立てない。post-capture を空打ちせず、screenshot 直後の早期復帰と揃える
  let preCaptureSent = false

  // 前回の再取得試行も失敗していた場合は通知を抑止する。他アプリがホットキーを握っている間、
  // Shiori ⇔ ブラウザを行き来してウィンドウをフォーカスするたびに（focus イベント経由で
  // この関数が呼ばれる）同じ「登録できませんでした」エラーが視聴中ページへ繰り返し表示されるのを防ぐ。
  let reclaimNotifiedFailure = false
  function reclaimHotkeysIfFree(): void {
    const st = loadSettings()
    if (globalShortcut.isRegistered(st.captureHotkey)) return
    const ok = registerHotkey(st.captureHotkey, (m) => {
      if (!reclaimNotifiedFailure) sendBrowserNotice('error', m)
    })
    reclaimNotifiedFailure = !ok
  }

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)

    registerCapfileProtocol()

    checkExtensionUpdate()
    // DB が開けないと以降の初期化（トレイ・ウィンドウ生成含む）が全て道連れになり、
    // UI が一切無いままロックだけ保持したプロセスが残ってしまう。壊れているなら
    // 退避からの復元を出し、断られたか復元もできなければ、気付ける形で即座に終了する。
    if (!openDatabaseOrRecover()) {
      app.quit()
      return
    }
    migrateThumbnailsToOwnDir().catch((err) => console.warn('[migrate-thumb] failed', err))
    // ファイル削除に失敗して DB から切り離された実ファイルの回収。ユーザーには見えず
    // 自分で消す手段もないので、アプリ側で黙って片付ける（非致命・バックグラウンド）。
    backfillThumbnails().catch((err) => console.warn('[thumbgen] backfill failed', err))
    // 拡張との WebSocket と、そこから届く再生時刻・ウィンドウ位置の受け口。
    startExtensionBridge()

    registerImageHandlers()
    registerDragHandlers()
    registerTaggerHandlers()
    registerShareHandlers()
    registerImportHandlers()
    for (const feature of features) feature.registerIpc?.()

    registerShellHandlers()

    handleTrusted(CH.settingsGet, () => loadSettings())
    handleTrusted(CH.settingsSet, (_event, patch: unknown) => {
      // renderer は変更したいキーだけを送る部分パッチ。ここで最新の保存値とマージすることで、
      // 「複数箇所が同時に別キーを変更すると片方が巻き戻る」レースを構造的になくす
      // （旧: renderer 側で全体オブジェクトを組み立てて送る方式だったため、読み込み待ちが必要だった）
      // 保存するだけでは済まない項目（ホットキー・保存先・拡張の許可）は落とす。
      // 何をなぜ落とすかは settings.ts の DEDICATED_SETTING_KEYS に書いてある。
      const { safePatch, ignored } = stripDedicatedSettingKeys(patch)
      // 画面には出さない——今この口へ送っている画面は 1 つも無いので、出れば嘘になる。
      // 将来ここへ流す実装を書いたときに、ログで気づけるようにするためだけの 1 行。
      if (ignored.length > 0) console.warn('[settings] ignored keys that need their own IPC:', ignored.join(', '))
      const prevLang = loadSettings().language
      const merged = { ...loadSettings(), ...safePatch }
      saveSettings(merged)
      const saved = loadSettings()
      // トレイメニューのラベルは生成時に文字列が焼き込まれるため、他の main 側文言と違い
      // 言語変更に自動では追随しない。言語が実際に変わったときだけ組み直す。
      if (saved.language !== prevLang) rebuildTrayMenu()
      setAllowedExtensionIds(saved.allowedExtensionIds)
      broadcastMessage({ type: 'settings', frameFps: saved.frameFps, frameFpsAuto: saved.frameFpsAuto, captureKey: captureHotkeyMainKey(saved.captureHotkey), stepLabels: browserStepLabels() })
    })
    handleTrusted(CH.captureSetHotkey, (_event, hotkey: string) => {
      const normalized = normalizeCaptureHotkey(hotkey)
      if (!normalized) return false
      const ok = changeHotkey(normalized, (m) => sendNotice('error', m))
      if (ok) {
        const updated = { ...loadSettings(), captureHotkey: normalized }
        saveSettings(updated)
        // content.js の Prime Video キー抑止がホットキー変更に追随するよう再送する
        broadcastMessage({ type: 'settings', frameFps: updated.frameFps, frameFpsAuto: updated.frameFpsAuto, captureKey: captureHotkeyMainKey(normalized), stepLabels: browserStepLabels() })
      }
      return ok
    })

    handleTrusted(CH.startupGet, () => isOpenAtLogin())
    handleTrusted(CH.startupSet, (_event, enabled: boolean) => {
      setOpenAtLogin(enabled === true)
    })

    handleTrusted(CH.extensionGetPath, () => installedExtensionPath())
    handleTrusted(CH.appGetVersion, () => app.getVersion())

    setPreCaptureHook(async () => {
      if (isMainWindowFocused()) throw new SilentCaptureAbort('Shiori window is focused')
      runPreCaptureGuards()
      // ここから先で pre-capture をブラウザへ送る。これより手前で throw したケース
      // （Shiori 前面・ガードでの中断）は送っていないので、postCaptureHook を空打ちさせない
      preCaptureSent = true
      // pre-capture を先に送り hidePlayerUI を実行させてから rAF をスケジュールする
      // こうすることで rAF（＝DOM描画済みの合図）が必ず hidePlayerUI の後に発火する
      const requestId = `${Date.now()}-${Math.random()}`
      pendingTimecode = waitForPreferredTimecode(requestId, CAPTURE_TIMECODE_TIMEOUT_MS, onExtensionMessage)
      broadcastMessage({ type: 'pre-capture' })
      broadcastMessage({ type: 'request-timecode', requestId })
      // タイムコードは content.js の rAF 後に届く（＝DOM 描画済みの合図）
      // それを待ってから OS コンポジタ向けに 20ms マージンを取ってスクショ
      const latest = await pendingTimecode
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      pendingTimecode = null
      if (latest) {
        setLastTimecode(latest)
      }
      // 静止画の大きさの上限に使う映像の実寸は、**今の返事に入っていた値だけ**を渡す。
      // 返事が間に合わなかった撮影（下の fallback で続行するケース）では null になり、
      // capture 側は縮めない。古い値で縮めると、画質が上がった直後の絵を削ってしまう。
      setSourceVideoSize(latest?.videoSize ?? null)
      const tc = getLastTimecode()
      const timecodeAge = Date.now() - getLastTimecodeAt()
      const hasCaptureTimecode = latest !== null || timecodeAge <= CAPTURE_FALLBACK_TIMECODE_MAX_AGE_MS
      if (!tc || !hasCaptureTimecode || !canCaptureVideo()) {
        sendBrowserNotice('warning', t('notice.captureTargetNotFound'))
        throw new SilentCaptureAbort('No active browser video target')
      }
      return tc
    })

    setPostCaptureHook(() => {
      // pre-capture を実際に送ったときだけ復帰を送る。早期復帰（screenshot 直後）と重複しないようにする
      if (!preCaptureSent) return
      preCaptureSent = false
      broadcastMessage({ type: 'post-capture' })
    })

    // 真っ黒キャプチャの警告（UX-1）。保存自体は成功のまま続行し、原因（ブラウザの
    // ハードウェアアクセラレーション）に気付けるよう警告だけ添える。ブラウザのHWアクセラ
    // 設定が変わらない限り以後のキャプチャも黒のままになりうるため、連打を防ぐクールダウンを設ける。
    let lastBlackFrameNoticeAt = 0
    const BLACK_FRAME_RENOTIFY_MS = 5 * 60 * 1000
    setBlackFrameHook(() => {
      const now = Date.now()
      if (now - lastBlackFrameNoticeAt < BLACK_FRAME_RENOTIFY_MS) return
      lastBlackFrameNoticeAt = now
      sendBrowserNotice('warning', t('notice.captureBlackScreen'))
    })

    onCaptureDone(async (imagePath, context, size) => {
      const timecode = (context as { title: string; currentTime: number | null; url: string | null } | null) ?? getLastTimecode()

      const thumbPath = thumbPathFor(imagePath)
      let thumbOk = false
      try { await createImageThumb(imagePath, thumbPath); thumbOk = true } catch (err) {
        console.warn('[capture] createImageThumb failed', err)
      }

      const result = await registerCapturedMedia({
        insert: {
          filepath: imagePath,
          captured_at: Date.now(),
          title: timecode?.title || null,
          current_time: timecode?.currentTime ?? null,
          url: timecode?.url ?? null,
          // 切り出した時点の画素数（capture.ts が渡す）。動画クリップと同じく、
          // 「何ピクセルで撮ったか」は後から画面で読めないと画質の判断ができない。
          width: size?.width ?? null,
          height: size?.height ?? null,
          colors: null,
          memo: null,
          media_type: 'image',
          fps: null,
          duration: null,
          thumb_path: thumbOk ? thumbPath : null
        },
        filePath: imagePath,
        thumbPath: thumbOk ? thumbPath : null,
        autoTag: { path: thumbOk ? thumbPath : imagePath, reportError: true }
      })
      if (!result.ok) {
        sendNotice('error', t('notice.captureSaveFailed'))
        // 保存失敗時はファイルを削除済み。capture:done の成功通知を出すと矛盾するため送らない
        return
      }

      if (loadSettings().captureNotify !== false) {
        sendBrowserNotice('success', t('notice.captureSaved'))
      }
    })

    Menu.setApplicationMenu(null)
    migrateStartupArgs()
    createTray()
    createWindow(reclaimHotkeysIfFree, isStartupLaunch())
    // 起動直後は一覧・サムネ読み込みとディスクアクセスが競合するので、後追いの処理は待たせる。
    //
    // **秒数で当てずっぽうに待たず、画面の読み込みが終わった合図を待つ**（2026-08-31 に改めた）。
    // 固定の 30 秒は、速い環境では待ちすぎ・遅い環境では早すぎるという、理由と逆の効き方をする。
    // 待つ理由が「読み込みと取り合わない」ことなので、読み込みが終わるのを実際に待つのが
    // 理由そのままの形になる。**30 秒は保険としてだけ残す**——読み込みに失敗した起動では
    // 合図が来ず、待つだけでは後追いの処理が永久に走らない（DB の数え直しもここにある）。
    //
    // 合図のあとの猶予は、読み込みが終わってからサムネがディスクから届くぶん。
    // **軽い順に走らせる**（数え直しは DB を読むだけ／見直しはクリップ 1 本ごとに動画を
    // まるごとデコード／掃除はディスク走査）。
    const FOLLOWUP_GRACE_MS = 5_000
    const FOLLOWUP_MAX_WAIT_MS = 30_000
    let followUpsStarted = false
    const runFollowUps = (): void => {
      if (followUpsStarted) return
      followUpsStarted = true
      // 詳細パネルに出す枚数を、保存済みのコマ表から数え直す（db-video-frames.ts）。
      // **古い録画はここでしか埋まらない**——録画・トリミングの直後にしか書いていないので、
      // その頃に無かった項目（抜けの合計・ずれ）は空のままで、詳細パネルだけが黙る。
      try {
        const fixed = backfillFrameCounts()
        if (fixed > 0) console.log(`[frame-counts] recounted ${fixed} clip(s) from the stored frame tables`)
      } catch (err) {
        console.warn('[frame-counts] failed', err)
      }
      // 印の付いた表の見直し（verify-clip.ts の recheckMarkedClips）。
      // 判定を直したときに、印が付いたままのクリップを救うための後追い。**普段は DB を
      // 一瞥して終わり**で、実際に重くなるのは直すものがあるときだけ＝結果を待たれているとき。
      recheckMarkedClips().catch((err) => console.warn('[frame-recheck] failed', err))
      // 孤立ファイル掃除は緊急性がないため最後。sweepOrphanFilesIfDue 側で週1回までに間引く。
      sweepOrphanFilesIfDue().catch((err) => console.warn('[sweep] failed', err))
    }
    whenRendererReady(() => setTimeout(runFollowUps, FOLLOWUP_GRACE_MS))
    setTimeout(runFollowUps, FOLLOWUP_MAX_WAIT_MS)
    for (const feature of features) await feature.onReady?.()
    const settingsProblem = consumeSettingsLoadProblem()
    if (settingsProblem) {
      // 「壊れていた」と「読めなかった」で、この後ユーザーが取るべき行動が違う。
      // 前者は諦めて設定し直す、後者は**設定を変えずに原因を取り除けば元の設定が戻る**。
      sendNoticeWhenRendererReady('error',
        t(settingsProblem === 'corrupt' ? 'notice.settingsCorrupt' : 'notice.settingsUnreadable'))
    }
    // 戻したこと・退避が取れなかったことは、起動直後のダイアログだけだと読み飛ばされる。
    // 何が含まれていないのかを、画面にも残す。復元の直後は起動し直しているので、
    // メモリ上の変数ではなく目印ファイルから拾う。
    const restoredFrom = consumeRestoreMarker(databasePath())
    if (restoredFrom) {
      sendNoticeWhenRendererReady('warning', t('notice.dbRestored', { date: backupDateLabel(restoredFrom) }))
    }
    if (consumeDbBackupFailure()) {
      sendNoticeWhenRendererReady('warning', t('notice.dbBackupFailed'))
    }
    // 設定の保存は「セッション内は即確定・ディスクは非同期」なので、書き込みが最後まで
    // 通らなくても renderer の setSettings は成功で返る（そうしないと AV のロックで
    // 一時的に失敗するたびに UI が巻き戻る）。代わりに、諦めた時点でここから知らせる。
    onSettingsPersistFailed(() => {
      sendNoticeWhenRendererReady('error', t('notice.settingsPersistFailed'))
    })
    // 自動アップデートはサイレント適用（終了時インストール）だと再起動後に何の表示もなく、
    // 更新されたのか判別できない。前回起動時のバージョンを設定に記録しておき、変わっていたら
    // 一度だけ知らせる（RELEASE_NOTES にそのバージョンの文面があればお知らせモーダル、
    // 無ければ従来通りのトースト。初回起動＝previousRunVersion なしは記録のみで通知しない）。
    const currentVersion = app.getVersion()
    const previousRunVersion = loadSettings().lastRunVersion
    if (previousRunVersion !== currentVersion) {
      const notice = decideVersionNotice(previousRunVersion, currentVersion, releaseNotesFor(currentVersion, loadSettings().language))
      if (notice.kind === 'whatsNew') {
        whenRendererReady(() => sendToRenderer(CH.whatsNew, { version: notice.version, notes: notice.notes }))
      } else if (notice.kind === 'toast') {
        sendNoticeWhenRendererReady('info', notice.message)
      }
      saveSettings({ ...loadSettings(), lastRunVersion: currentVersion })
    }
    // 他プロセスが WS ポートを LISTEN していると拡張と接続できない。原因が分からないまま
    // 「キャプチャ対象を検出できませんでした」に化けるのを防ぐため、明示的に案内する。
    // EADDRINUSE は listen 後の非同期イベントで初めて分かるため、ここで購読しておく。
    onPortInUse(() => {
      // ここに来るのは候補を全部試して駄目だったときだけ（1 つ塞がっただけなら自動で隣へ移る）。
      sendNoticeWhenRendererReady('error', t('notice.portInUse', { ports: WS_PORTS.join(', ') }))
    })
    registerHotkey(loadSettings().captureHotkey, (message) => {
      sendBrowserNotice('error', message)
    })

    initAutoUpdater(getMainWindow)
    handleTrusted(CH.updaterQuitAndInstall, async () => {
      if (!(await confirmUpdateWhileBusy())) return
      await quitAndInstallUpdate()
    })

    app.on('activate', () => {
      showMainWindow()
    })
  }).catch((err) => {
    // ここへ来るのは initDb の後（＝DB は開けた）で、残りの準備のどこかが落ちたとき。
    // console にしか出さないと、使う人からは「ウィンドウが出ない」「トレイに居るのに
    // 何もできない」としか見えず、原因を確かめる手段が画面上に一つも無い。
    console.error('[startup] initialization failed', err)
    // 詳細はダイアログに1行だけ載せる（スタックは上の console に残す）。
    const detail = describeStartupError(err)
    const win = getMainWindow()
    const hasWindow = win !== null && !win.isDestroyed()
    try {
      // t() は settings 経由で言語を引く。settings 自体が原因で落ちている可能性もあるので、
      // 文言解決に失敗してもダイアログだけは必ず出す。
      let message: string
      try {
        message = t(hasWindow ? 'error.startupPartial' : 'error.startupFailed', { detail })
      } catch {
        message = `Shiori did not finish starting up.\n\n${detail}`
      }
      dialog.showErrorBox('Shiori', message)
    } catch (dialogErr) {
      console.error('[startup] failed to show the startup error dialog', dialogErr)
    }
    // ウィンドウが無ければ操作手段が一つも無いので、ロックだけ握ったプロセスを残さず終了する
    // （initDb 失敗時と同じ扱い）。ウィンドウがあるなら途中まで使えるので、勝手には落とさない。
    if (!hasWindow) app.quit()
  })

  app.on('window-all-closed', () => {
    // トレイに残す
  })

  let teardownDone = false

  app.on('before-quit', (event) => {
    setQuitting(true)
    // preventDefault → flush → app.quit() で再入するため、後片付けは初回だけ。
    if (teardownDone) return

    for (const feature of features) feature.onBeforeQuit?.()
    globalShortcut.unregisterAll()
    stopWsServer()
    // ドラッグ用の複製は次回ドラッグ時にも作り直されるが、終了時に残すと temp が
    // 溜まり続けるため掃除する（失敗しても致命的ではない）。
    cleanupDragTempDir()

    // saveSettings は永続化を待たずに返るので、キューが残ったまま終了すると最後の
    // 設定変更が巻き戻る。before-quit は非同期を待ってくれないため、一度 quit を
    // 止めてフラッシュしてから quit し直す。トレイ終了・ウィンドウ終了・アップデート
    // 適用のすべてがこの経路を通るので、ここ1箇所で全終了経路をカバーできる。
    event.preventDefault()
    flushSettings().finally(() => {
      teardownDone = true
      app.quit()
    })
  })
}
