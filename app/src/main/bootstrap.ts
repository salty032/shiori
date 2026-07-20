import { app, dialog, globalShortcut, protocol, Menu, shell, session } from 'electron'
import { extname, join } from 'path'
import { stat } from 'fs/promises'
import { createReadStream, mkdirSync } from 'fs'
import { Readable } from 'stream'
import { startWsServer, stopWsServer, onExtensionMessage, broadcastMessage, onWsClientConnect, setAllowedExtensionIds, onPortInUse, PORT as WS_PORT } from './ws-server'
import {
  registerHotkey, changeHotkey, onCaptureDone, setBrowserWindowPos, setVideoRect, setBrowserFullscreen,
  setPreCaptureHook, setPostCaptureHook, canCaptureVideo, setBlackFrameHook,
  runPreCaptureGuards, shouldSuppressBrowserTargetUpdate, SilentCaptureAbort
} from './capture'
import { initDb, getImage } from './db'
import { registerCapturedMedia } from './captured-media'
import type { MainFeature } from './feature'
import { loadSettings, saveSettings, flushSettings, consumeCorruptSettingsNotice, type Settings } from './settings'
import { activeTaskLabels } from './busy'
import { checkExtensionUpdate, installedExtensionPath, bundledExtPath, readVersion } from './extension-updater'
import { compareVersions } from './version'
import { migrateThumbnailsToOwnDir } from './migrate-thumbnails'
import { sweepOrphanFiles } from './sweep-orphans'
import { initAutoUpdater, quitAndInstallUpdate } from './updater'
import { resolveRealCapturePath, thumbPathFor } from './paths'
import { normalizeCaptureHotkey, captureHotkeyMainKey } from './hotkey'
import { createImageThumb } from './image-thumb'
import {
  getMainWindow, setQuitting,
  sendToRenderer, sendNotice, showMainWindow, isMainWindowFocused,
  handleTrusted, safeExternalUrl,
  createWindow
} from './windows'
import { createTray, rebuildTrayMenu } from './tray'
import { isStartupLaunch, isOpenAtLogin, setOpenAtLogin, migrateStartupArgs } from './startup'
import {
  getLastTimecode, getLastTimecodeAt, setLastTimecode,
  getLastFocusedTimecodeAt, markFocusedTimecodeNow
} from './timecode'
import { registerImageHandlers, backfillThumbnails } from './ipc-images'
import { registerDragHandlers, cleanupDragTempDir } from './ipc-drag'
import { registerTaggerHandlers } from './ipc-tagger'
import { registerShareHandlers } from './ipc-share'
import { registerImportHandlers } from './ipc-import'
import { optionalPositiveInteger } from './ipc-validation'
import { sendBrowserNotice } from './browser-notice'
import { decideVersionNotice } from './version-notice'
import { releaseNotesFor } from '../shared/releaseNotes'
import { CH } from '../shared/api'
import { waitForPreferredTimecode, type CaptureTimecode } from './timecode-request'
import { t } from './i18n'

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

  // app.whenReady() より前に登録する必要がある
  protocol.registerSchemesAsPrivileged([
    { scheme: 'capfile', privileges: { secure: true, standard: true, supportFetchAPI: true } }
  ])

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

    protocol.handle('capfile', async (request) => {
      const url = new URL(request.url)
      let filePath: string | null = null
      const idParam = url.searchParams.get('id')
      if (idParam) {
        const id = parseInt(idParam, 10)
        if (Number.isInteger(id) && id > 0) {
          const image = getImage(id)
          if (image) {
            const kind = url.searchParams.get('kind')
            const raw = kind === 'thumb' ? (image.thumb_path ?? image.filepath) : image.filepath
            filePath = await resolveRealCapturePath(raw)
          }
        }
      }
      if (!filePath) return new Response('Forbidden', { status: 403 })

      let size: number
      try {
        const info = await stat(filePath)
        if (!info.isFile()) return new Response('Not found', { status: 404 })
        size = info.size
      } catch {
        return new Response('Not found', { status: 404 })
      }

      // 動画(webm)を含む capfile プロトコル。
      const EXT_CONTENT_TYPE: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.webp': 'image/webp', '.gif': 'image/gif',
        '.webm': 'video/webm', '.mp4': 'video/mp4'
      }
      const contentType = EXT_CONTENT_TYPE[extname(filePath).toLowerCase()] ?? 'application/octet-stream'

      // 動画の <video> シークで Range リクエストが飛んでくるため 206/416 に対応する
      // （画像に対して送られても無害）。
      const rangeHeader = request.headers.get('Range')
      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
        if (match && (match[1] || match[2])) {
          let start: number
          let end: number
          if (!match[1]) {
            // サフィックス Range（bytes=-N、RFC 9110） 末尾 N バイトを返す
            const suffixLength = parseInt(match[2], 10)
            start = Number.isFinite(suffixLength) && suffixLength > 0 ? Math.max(0, size - suffixLength) : 0
            end = size - 1
          } else {
            start = parseInt(match[1], 10)
            end = match[2] ? parseInt(match[2], 10) : size - 1
          }
          if (!Number.isFinite(start) || start < 0) start = 0
          if (!Number.isFinite(end) || end >= size) end = size - 1
          if (start > end || start >= size) {
            return new Response('Range Not Satisfiable', {
              status: 416,
              headers: { 'Content-Range': `bytes */${size}` }
            })
          }
          const stream = createReadStream(filePath, { start, end })
          return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
            status: 206,
            headers: {
              'Content-Type': contentType,
              'Content-Length': String(end - start + 1),
              'Content-Range': `bytes ${start}-${end}/${size}`,
              'Accept-Ranges': 'bytes'
            }
          })
        }
      }

      const stream = createReadStream(filePath)
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes'
        }
      })
    })

    checkExtensionUpdate()
    // OS通知（checkExtensionUpdate）は起動直後の1回しか出ず見逃しやすいため、以後は
    // 拡張から届く timecode の version と比較し続け、設定画面に「再読み込みが必要」の
    // バッジを出せるようにする（UX-9）。
    const bundledExtVersion = readVersion(bundledExtPath())
    try {
      initDb()
    } catch (err) {
      // DB が開けないと以降の初期化（トレイ・ウィンドウ生成含む）が全て道連れになり、
      // UI が一切無いままロックだけ保持したプロセスが残ってしまう。安全側に倒し、
      // ユーザーに気付ける形で即座に終了する（再起動すれば直ることが多い一時的要因：
      // クラッシュ後の WAL 破損、AV/バックアップソフトによるファイルロック等）。
      console.error('[startup] initDb failed', err)
      dialog.showErrorBox(
        'Shiori',
        t('error.dbOpen')
      )
      app.quit()
      return
    }
    migrateThumbnailsToOwnDir().catch((err) => console.warn('[migrate-thumb] failed', err))
    // ファイル削除に失敗して DB から切り離された実ファイルの回収。ユーザーには見えず
    // 自分で消す手段もないので、アプリ側で黙って片付ける（非致命・バックグラウンド）。
    sweepOrphanFiles().catch((err) => console.warn('[sweep] failed', err))
    backfillThumbnails().catch((err) => console.warn('[thumbgen] backfill failed', err))
    const wsSettings = loadSettings()
    onWsClientConnect((send) => {
      const s = loadSettings()
      send({ type: 'settings', frameFps: s.frameFps ?? 24, frameFpsAuto: s.frameFpsAuto !== false, captureKey: captureHotkeyMainKey(s.captureHotkey) })
    })
    // listen 開始前に接続コールバックを登録し、起動直後の接続にも必ず設定を返す。
    startWsServer({ allowedExtensionIds: wsSettings.allowedExtensionIds })

    onExtensionMessage((msg) => {
      if (msg.type === 'timecode') {
        if (msg.focused) markFocusedTimecodeNow()
        // フォーカス中のタブを優先。フォーカスタイムコードが30秒以上届いていない場合は
        const accept = msg.focused || Date.now() - getLastFocusedTimecodeAt() > 30_000
        if (accept) {
          setLastTimecode({ title: msg.title, currentTime: msg.currentTime, url: msg.url ?? null })
        }
        if (!shouldSuppressBrowserTargetUpdate() && accept) {
          setBrowserWindowPos(msg.windowLeft, msg.windowTop, msg.windowWidth, msg.windowHeight, msg.innerWidth, msg.innerHeight)
          setVideoRect(msg.videoRect)
          setBrowserFullscreen(msg.fullscreen)
        }
        // バンドル版の方が新しければ「拡張の再読み込みが必要」（UX-9）。
        const versionMismatch = !!bundledExtVersion && !!msg.version && compareVersions(bundledExtVersion, msg.version) > 0
        sendToRenderer(CH.extensionTimecode, { ...msg, versionMismatch })
      }
    })

    registerImageHandlers()
    registerDragHandlers()
    registerTaggerHandlers()
    registerShareHandlers()
    registerImportHandlers()
    for (const feature of features) feature.registerIpc?.()

    handleTrusted(CH.shellOpenUrl, (_event, url: string) => {
      const safeUrl = safeExternalUrl(url)
      if (safeUrl) return shell.openExternal(safeUrl)
    })
    handleTrusted(CH.shellShowInFolder, async (_event, id: number) => {
      const imageId = optionalPositiveInteger(id)
      if (!imageId) return
      const image = getImage(imageId)
      if (!image) return
      const safePath = await resolveRealCapturePath(image.filepath)
      if (safePath) shell.showItemInFolder(safePath)
    })
    handleTrusted(CH.shellShowExtensionFolder, () => {
      shell.showItemInFolder(join(installedExtensionPath(), 'manifest.json'))
    })

    handleTrusted(CH.settingsGet, () => loadSettings())
    handleTrusted(CH.settingsSet, (_event, patch: Partial<Settings>) => {
      // renderer は変更したいキーだけを送る部分パッチ。ここで最新の保存値とマージすることで、
      // 「複数箇所が同時に別キーを変更すると片方が巻き戻る」レースを構造的になくす
      // （旧: renderer 側で全体オブジェクトを組み立てて送る方式だったため、読み込み待ちが必要だった）
      // captureHotkey はここでは無視する。実際の登録可否（グローバルショートカット競合）は
      // main 側の状態が真実であり、専用 IPC（CH.captureSetHotkey）を経由しないと
      // globalShortcut への登録が伴わない。この汎用口を素通しすると「設定ファイル上の値と
      // 実際に登録されているホットキーが食い違う」状態を作れてしまうため、ここで弾く。
      const { captureHotkey: _ignoredCaptureHotkey, ...safePatch } =
        (patch && typeof patch === 'object' ? patch : {}) as Partial<Settings>
      const prevLang = loadSettings().language
      const merged = { ...loadSettings(), ...safePatch }
      saveSettings(merged)
      const saved = loadSettings()
      // トレイメニューのラベルは生成時に文字列が焼き込まれるため、他の main 側文言と違い
      // 言語変更に自動では追随しない。言語が実際に変わったときだけ組み直す。
      if (saved.language !== prevLang) rebuildTrayMenu()
      setAllowedExtensionIds(saved.allowedExtensionIds)
      broadcastMessage({ type: 'settings', frameFps: saved.frameFps, frameFpsAuto: saved.frameFpsAuto, captureKey: captureHotkeyMainKey(saved.captureHotkey) })
    })
    handleTrusted(CH.captureSetHotkey, (_event, hotkey: string) => {
      const normalized = normalizeCaptureHotkey(hotkey)
      if (!normalized) return false
      const ok = changeHotkey(normalized, (m) => sendNotice('error', m))
      if (ok) {
        const updated = { ...loadSettings(), captureHotkey: normalized }
        saveSettings(updated)
        // content.js の Prime Video キー抑止がホットキー変更に追随するよう再送する
        broadcastMessage({ type: 'settings', frameFps: updated.frameFps, frameFpsAuto: updated.frameFpsAuto, captureKey: captureHotkeyMainKey(normalized) })
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

    onCaptureDone(async (imagePath, context) => {
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
          width: null,
          height: null,
          colors: null,
          memo: null,
          media_type: 'image',
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
    for (const feature of features) await feature.onReady?.()
    if (consumeCorruptSettingsNotice()) {
      sendNoticeWhenRendererReady('error', t('notice.settingsCorrupt'))
    }
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
      sendNoticeWhenRendererReady('error', t('notice.portInUse', { port: WS_PORT }))
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
    console.error('[startup] initialization failed', err)
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
