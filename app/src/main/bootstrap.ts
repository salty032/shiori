import { app, dialog, globalShortcut, protocol, Menu, shell, session } from 'electron'
import { extname, join } from 'path'
import { stat } from 'fs/promises'
import { createReadStream } from 'fs'
import { Readable } from 'stream'
import { startWsServer, stopWsServer, onExtensionMessage, broadcastMessage, onWsClientConnect, setAllowedExtensionIds, consumePortInUseNotice, PORT as WS_PORT } from './ws-server'
import {
  registerHotkey, changeHotkey, onCaptureDone, setBrowserWindowPos, setVideoRect, setBrowserFullscreen,
  setPreCaptureHook, setPostCaptureHook, canCaptureVideo,
  runPreCaptureGuards, shouldSuppressBrowserTargetUpdate, SilentCaptureAbort
} from './capture'
import { initDb, getImage } from './db'
import { registerCapturedMedia } from './captured-media'
import { loadSettings, saveSettings, consumeCorruptSettingsNotice, type Settings } from './settings'
import { checkExtensionUpdate, installedExtensionPath } from './extension-updater'
import { migrateThumbnailsToOwnDir } from './migrate-thumbnails'
import { initAutoUpdater } from './updater'
import { ensureModel, isModelDownloaded } from './tagger'
import { resolveRealCapturePath, thumbPathFor } from './paths'
import { normalizeCaptureHotkey, captureHotkeyMainKey } from './hotkey'
import { createImageThumb } from './image-thumb'
import {
  getMainWindow, setQuitting,
  sendToRenderer, sendNotice, showMainWindow, isMainWindowFocused,
  handleTrusted, safeExternalUrl,
  createWindow
} from './windows'
import { createTray } from './tray'
import {
  getLastTimecode, getLastTimecodeAt, setLastTimecode,
  getLastFocusedTimecodeAt, markFocusedTimecodeNow
} from './timecode'
import { registerImageHandlers, backfillThumbnails } from './ipc-images'
import { registerTaggerHandlers } from './ipc-tagger'
import { registerShareHandlers } from './ipc-share'
import { registerImportHandlers } from './ipc-import'
import { optionalPositiveInteger } from './ipc-validation'
import { sendBrowserNotice } from './browser-notice'
import { CH } from '../shared/api'

export function bootstrap(): void {
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
  app.enableSandbox()

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

  let pendingTimecode: Promise<{ title: string; currentTime: number | null; url: string | null } | null> | null = null
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

      // 画像専用ビルド。動画(video/webm・video/mp4)は扱わない。
      const EXT_CONTENT_TYPE: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.webp': 'image/webp', '.gif': 'image/gif'
      }
      const contentType = EXT_CONTENT_TYPE[extname(filePath).toLowerCase()] ?? 'application/octet-stream'

      // 画像専用ビルドでは Range を送るクライアントは基本無いが、HTTP レスポンスとしての
      // 正しさのため Range リクエストには 206/416 で応答できるようにしておく（画像でも無害）。
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
        'データベースを開けなかったため起動できませんでした。\n\n' +
          '他のプロセスがファイルをロックしていないか確認するか、PCを再起動してから再度お試しください。'
      )
      app.quit()
      return
    }
    migrateThumbnailsToOwnDir().catch((err) => console.warn('[migrate-thumb] failed', err))
    backfillThumbnails().catch((err) => console.warn('[thumbgen] backfill failed', err))
    const wsSettings = loadSettings()
    startWsServer({ allowedExtensionIds: wsSettings.allowedExtensionIds })
    onWsClientConnect((send) => {
      const s = loadSettings()
      send({ type: 'settings', frameFps: s.frameFps ?? 24, frameFpsAuto: s.frameFpsAuto !== false, captureKey: captureHotkeyMainKey(s.captureHotkey) })
    })

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
        sendToRenderer(CH.extensionTimecode, msg)
      }
    })

    registerImageHandlers()
    registerTaggerHandlers()
    registerShareHandlers()
    registerImportHandlers()

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
      const merged = { ...loadSettings(), ...safePatch }
      saveSettings(merged)
      const saved = loadSettings()
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

    handleTrusted(CH.startupGet, () => app.getLoginItemSettings().openAtLogin)
    handleTrusted(CH.startupSet, (_event, enabled: boolean) => {
      app.setLoginItemSettings({ openAtLogin: enabled === true })
    })

    handleTrusted(CH.extensionGetPath, () => installedExtensionPath())

    setPreCaptureHook(async () => {
      if (isMainWindowFocused()) throw new SilentCaptureAbort('Shiori window is focused')
      runPreCaptureGuards()
      // ここから先で pre-capture をブラウザへ送る。これより手前で throw したケース
      // （Shiori 前面・ガードでの中断）は送っていないので、postCaptureHook を空打ちさせない
      preCaptureSent = true
      // pre-capture を先に送り hidePlayerUI を実行させてから rAF をスケジュールする
      // こうすることで rAF（＝DOM描画済みの合図）が必ず hidePlayerUI の後に発火する
      const requestId = `${Date.now()}-${Math.random()}`
      pendingTimecode = new Promise((resolve) => {
        let off = (): void => {}
        const timer = setTimeout(() => {
          off()
          resolve(null)
        }, CAPTURE_TIMECODE_TIMEOUT_MS)
        off = onExtensionMessage((msg) => {
          if (msg.type === 'timecode' && msg.requestId === requestId) {
            clearTimeout(timer)
            off()
            resolve({ title: msg.title, currentTime: msg.currentTime, url: msg.url ?? null })
          }
        })
        broadcastMessage({ type: 'pre-capture' })
        broadcastMessage({ type: 'request-timecode', requestId })
      })
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
        sendBrowserNotice('warning', 'キャプチャ対象を検出できませんでした。対応サイトの動画ページを開き、Chrome 拡張機能が有効か確認してください。')
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
          thumb_path: thumbOk ? thumbPath : null
        },
        filePath: imagePath,
        thumbPath: thumbOk ? thumbPath : null,
        autoTag: { path: thumbOk ? thumbPath : imagePath, reportError: true }
      })
      if (!result.ok) {
        sendNotice('error', 'キャプチャの保存に失敗しました')
        // 保存失敗時はファイルを削除済み。capture:done の成功通知を出すと矛盾するため送らない
        return
      }

      if (loadSettings().captureNotify !== false) {
        sendBrowserNotice('success', 'キャプチャを保存しました')
      }
    })

    Menu.setApplicationMenu(null)
    createTray()
    createWindow(reclaimHotkeysIfFree)
    if (consumeCorruptSettingsNotice()) {
      // sendNotice は mainWindow 生成前だと無言で消えるため、初回描画後に送る
      getMainWindow()?.webContents.once('did-finish-load', () => {
        sendNotice('error', '設定ファイルが破損していたため、デフォルト設定で起動しました。')
      })
    }
    if (consumePortInUseNotice()) {
      // 他プロセスが WS ポートを LISTEN していると拡張と接続できない。原因が分からないまま
      // 「キャプチャ対象を検出できませんでした」に化けるのを防ぐため、明示的に案内する。
      getMainWindow()?.webContents.once('did-finish-load', () => {
        sendNotice('error', `ポート${WS_PORT}が他のアプリに使用されているため、ブラウザ拡張と接続できません。`)
      })
    }
    registerHotkey(loadSettings().captureHotkey, (message) => {
      sendBrowserNotice('error', message)
    })

    initAutoUpdater(getMainWindow)

    isModelDownloaded().then(async (downloaded) => {
      if (!downloaded) return
      try {
        await ensureModel()
        sendToRenderer(CH.taggerReady)
      } catch (err) {
        console.error('[tagger] auto-load failed', err)
      }
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

  app.on('before-quit', () => {
    setQuitting(true)
    globalShortcut.unregisterAll()
    stopWsServer()
  })
}
