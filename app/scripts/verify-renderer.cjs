// Render the real UI in a hidden Electron window, using generated media and the demo API.
// No installed-app data, browser extension, or streaming service is accessed.
const { spawnSync, execFileSync } = require('node:child_process')
const { createServer } = require('node:http')
const { readFileSync, mkdtempSync, unlinkSync, rmdirSync } = require('node:fs')
const { join, resolve, extname } = require('node:path')
const { tmpdir } = require('node:os')

if (!process.versions.electron) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}

const { app, BrowserWindow } = require('electron')
const base = resolve(__dirname, '..')
const mediaDir = mkdtempSync(join(tmpdir(), 'shiori-renderer-'))
const mediaPath = join(mediaDir, 'clip.webm')
app.setPath('userData', mediaDir)
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
let server
let win

async function run() {
  execFileSync(join(base, 'resources', 'ffmpeg.exe'), [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24',
    '-t', '1', '-c:v', 'libvpx-vp9', mediaPath,
  ], { windowsHide: true })
  const manifest = { items: [{ file: 'clip.webm', mediaType: 'video', title: 'Renderer smoke clip',
    host: 'example.test', url: null, currentTime: 0, capturedAt: 1000, duration: 1, fps: 24,
    memo: '', tags: [] }] }
  const root = join(base, 'dist-web')
  server = createServer((req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname
      if (path === '/shiori/manifest.json') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(manifest)); return
      }
      if (path === '/shiori/clip.webm') {
        // 途中から読む要求（Range）に応える。応えないと Chromium はシークできず、コマ送りが 0 秒に戻る。
        const body = readFileSync(mediaPath)
        res.setHeader('Content-Type', 'video/webm')
        res.setHeader('Accept-Ranges', 'bytes')
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
        if (range) {
          const start = range[1] ? Number(range[1]) : 0
          const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
          res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${body.length}` })
          res.end(body.subarray(start, end + 1)); return
        }
        res.end(body); return
      }
      const relative = decodeURIComponent(path.replace(/^\/shiori\//, '')) || 'index.html'
      const target = resolve(root, relative)
      if (!target.startsWith(root + require('node:path').sep)) { res.writeHead(403).end(); return }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
      res.setHeader('Content-Type', types[extname(target)] ?? 'application/octet-stream')
      res.end(readFileSync(target))
    } catch { res.writeHead(404).end() }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  await app.whenReady()
  win = new BrowserWindow({ show: false, width: 1280, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const errors = []
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
  await win.loadURL(`http://127.0.0.1:${server.address().port}/shiori/`)
  async function evaluate(code) {
    try { return await win.webContents.executeJavaScript(code) } catch (error) { throw new Error(`${error.message}
  in: ${code.slice(0, 200)}`) }
  }
  async function until(code) {
    const limit = Date.now() + 10000
    while (!(await evaluate(code))) {
      if (Date.now() > limit) throw new Error(`Timed out: ${code}`)
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  }
  await until(`Boolean(document.querySelector('[data-img-id="1"]'))`)
  await new Promise((resolve) => setTimeout(resolve, 500))
  await evaluate(`document.querySelector('[data-img-id="1"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await until(`Boolean(document.querySelector('video'))`)
  await evaluate(`document.querySelector('video').volume = 0.5`)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))`)
  await until(`Math.abs(document.querySelector('video').volume - 0.55) < 0.001`)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`)
  await until(`Math.abs(document.querySelector('video').volume - 0.5) < 0.001`)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await new Promise((resolve) => setTimeout(resolve, 180))
  async function click(label) {
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(label)})
      if (!button) throw new Error('Button missing: ' + ${JSON.stringify(label)})
      button.click()
    })()`)
  }
  async function mouseClick(selector) {
    const { x, y } = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  }
  await checkFrameStepping(evaluate, until, click, mouseClick)
  await evaluate(`void (window.api.getStorageInfo = async () => ({
    captureDir: 'renderer-smoke', captureBytes: 0, thumbnailBytes: 0, dbBytes: 0,
    modelBytes: 0, imageCount: 0, videoCount: 1
  }))`)
  await click('設定')
  await until(`Boolean(document.querySelector('[data-modal]'))`)
  await click('データ')
  await until(`document.body.textContent.includes('ライブラリをエクスポート...')`)
  await evaluate(`void (window.api.shareExport = () => new Promise(resolve => { window.finishSmokeExport = resolve }))`)
  await click('ライブラリをエクスポート...')
  await until(`document.body.textContent.includes('エクスポート中...')`)
  await click('情報')
  await evaluate(`window.finishSmokeExport({ canceled: false, count: 1 })`)
  await click('データ')
  await until(`document.body.textContent.includes('1枚をエクスポート')`)
  if (errors.length) throw new Error(errors.join('\n'))
  console.log('Electron renderer: video volume keys, frame stepping and settings tab lifecycle passed.')
}

// コマ送りを、ビューアとトリミング画面の実画面で押して確かめる。2 つは同じ計算（frameStep.ts）を使い、
// 違うのは抜けで止まるかだけ。ビューアは抜けでも止まって番号に数え、トリミング画面は絵のある行だけを
// 渡る（抜けから切っても ffmpeg は手前の絵を捨て、表の引き継ぎもずれる。docs/SPEC.md「切り出し」）。
//
// 表は 24fps・1 秒の動画（全 24 枚）に対する作り物。6 行目は撮り逃し（5 行目と同じ絵・同じ時刻）、
// 10 行目（9 枚目）の後ろに 2 コマの抜けがあることにする（10・11 枚目は表に出てこない）。
// 押すたびに、映すためにシークした先が何枚目かを記録する（シーク先は各コマの真ん中）。
async function checkFrameStepping(evaluate, until, click, mouseClick) {
  const rows = [0, 1, 2, 3, 4, 5, 5, 6, 7, 8, 9, ...Array.from({ length: 12 }, (_, i) => 12 + i)]
  await evaluate(`void (window.api.getClipFrames = async () => ({
    pts: ${JSON.stringify(rows)}.map(f => f / 24),
    dur: ${JSON.stringify(rows)}.map(() => 1 / 24),
    sourceBased: true,
    quality: ${JSON.stringify(rows)}.map(() => 0),
    gaps: [{ afterIndex: 10, missing: 2, measured: true, animeMissing: 2 }],
  }))`)
  // 読むのはいちばん大きい動画（開いたビューア・トリミング画面。詳細パネルにも同じクリップの小さい動画がある）。
  // 押した後、シークが落ち着いてから位置を読む（人の押す速さ。連打はここでは見ない）。
  const video = `[...document.querySelectorAll('video')].sort((a, b) => b.clientWidth - a.clientWidth)[0]`
  const shownFrame = `Math.round((${video}.currentTime - 1 / 48) * 24)`
  async function press(action, times) {
    const seen = []
    for (let i = 0; i < times; i++) {
      await evaluate(action)
      await until(`!${video}.seeking`)
      await new Promise((resolve) => setTimeout(resolve, 60))
      seen.push(await evaluate(shownFrame))
    }
    return seen
  }
  function expectFrames(what, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
  }
  const key = (target, k) => `${target}.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true }))`

  await evaluate(`document.querySelector('[data-img-id="1"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await until(`document.querySelectorAll('video').length === 2`)
  await new Promise((resolve) => setTimeout(resolve, 300))
  // ビューアは開くと流れ始めるので、止めて先頭へ戻してから押す。
  await evaluate(`(() => { const v = ${video}; v.pause(); v.currentTime = 0 })()`)
  await until(`!${video}.seeking`)
  await new Promise((resolve) => setTimeout(resolve, 100))
  // ビューア：撮り逃しの行では同じ絵のまま 1 つ進み、9 枚目の後ろの抜けでは 2 回止まる。
  expectFrames('viewer .', await press(key('window', '.'), 13), [1, 2, 3, 4, 5, 5, 6, 7, 8, 9, 9, 9, 12])
  expectFrames('viewer ,', await press(key('window', ','), 4), [9, 9, 9, 8])
  await evaluate(key('window', 'Escape'))
  await new Promise((resolve) => setTimeout(resolve, 180))

  // 閉じた Escape で選択も外れるので、選び直して詳細パネルのボタンから開く。選択は本物のマウス操作でしか動かない。
  await mouseClick('[data-img-id="1"]')
  await until(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '動画を編集')`)
  await click('動画を編集')
  await until(`Boolean(document.querySelector('video')) && document.body.textContent.includes('+1f')`)
  await new Promise((resolve) => setTimeout(resolve, 300))
  // トリミング画面：撮り逃しの行には止まるが、抜けでは止まらず 9 枚目から 12 枚目へ渡る。
  expectFrames('trimmer .', await press(key('document', '.'), 12), [1, 2, 3, 4, 5, 5, 6, 7, 8, 9, 12, 13])
  expectFrames('trimmer ,', await press(key('document', ','), 3), [12, 9, 8])
  const stepButton = (card, label) => `[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '${label}')[${card}].click()`
  // 開始（左の ±1f）と終了（右の ±1f）。終了は末尾の 23 枚目から戻り、開始（12 枚目）の 1 行後ろで止まる。
  expectFrames('trimmer IN +1f', await press(stepButton(0, '+1f'), 11), [1, 2, 3, 4, 5, 5, 6, 7, 8, 9, 12])
  expectFrames('trimmer OUT -1f', await press(stepButton(1, '−1f'), 12), [22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 13, 13])
  await evaluate(key('document', 'Escape'))
  await until(`document.body.textContent.includes('閉じる')`)
  await click('閉じる')
  await until(`!document.body.textContent.includes('+1f')`)
}

run().then(() => 0, (error) => { console.error(error); return 1 }).then((code) => {
  win?.destroy()
  server?.close()
  try { unlinkSync(mediaPath); rmdirSync(mediaDir) } catch {}
  app.exit(code)
})
