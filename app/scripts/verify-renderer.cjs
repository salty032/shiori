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
        res.setHeader('Content-Type', 'video/webm')
        res.end(readFileSync(mediaPath)); return
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
  async function evaluate(code) { return win.webContents.executeJavaScript(code) }
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
  await evaluate(`void (window.api.getStorageInfo = async () => ({
    captureDir: 'renderer-smoke', captureBytes: 0, thumbnailBytes: 0, dbBytes: 0,
    modelBytes: 0, imageCount: 0, videoCount: 1
  }))`)
  async function click(label) {
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(label)})
      if (!button) throw new Error('Button missing: ' + ${JSON.stringify(label)})
      button.click()
    })()`)
  }
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
  console.log('Electron renderer: video volume keys and settings tab lifecycle passed.')
}

run().then(() => 0, (error) => { console.error(error); return 1 }).then((code) => {
  win?.destroy()
  server?.close()
  try { unlinkSync(mediaPath); rmdirSync(mediaDir) } catch {}
  app.exit(code)
})
