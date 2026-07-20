import { app, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { deflateSync } from 'zlib'
import { sendToRenderer, showMainWindow } from './windows'
import { CH } from '../shared/api'
import { t } from './i18n'

let tray: Tray | null = null
let trayNormalIcon: Electron.NativeImage | null = null
let trayRecordingIcon: Electron.NativeImage | null = null
// 言語変更でツールチップを組み直すときに、録画中かどうかを復元するために保持する。
let isRecording = false

function buildTrayMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    { label: t('menu.open'), click: () => showMainWindow() },
    {
      label: t('menu.settings'),
      click: () => {
        showMainWindow()
        sendToRenderer(CH.openSettings)
      }
    },
    { label: t('menu.quit'), click: () => app.quit() }
  ])
}

// トレイ用アイコンを、サイズごとに用意された PNG（build/icon16・icon24・icon32）から組み立てる。
// icon.ico を nativeImage.createFromPath() で読むと最大サイズの 1 枚しか取り出せず、
// それを 16px 枠へ潰し込むことになって絵が崩れる。表示スケール（100%/150%/200%）ごとに
// 実寸の PNG を持たせ、どれを使うかを OS に選ばせる。
// トレイの論理サイズは 16 なので、各 representation のピクセル数は 16 * scaleFactor と一致する。
// PNG はここでリサイズしない。絵の差し替えは assets/icons/ に置いて scripts/build-icons.mjs を流す。
function buildTrayIcon(): Electron.NativeImage {
  const icon = nativeImage.createEmpty()
  for (const [scaleFactor, file] of [[1, 'icon16.png'], [1.5, 'icon24.png'], [2, 'icon32.png']] as const) {
    const rep = nativeImage.createFromPath(join(__dirname, '../../build', file))
    if (rep.isEmpty()) continue
    icon.addRepresentation({ scaleFactor, buffer: rep.toPNG() })
  }
  return icon
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})

// 録画中トレイアイコン用の赤丸 PNG をその場で生成する（外部アセット不要。dev 版と同じ手法）。
function buildRedCirclePng(size: number): Buffer {
  const center = (size - 1) / 2
  const radius = size / 2 - 1.5
  const rows: Buffer[] = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4)
    row[0] = 0
    for (let x = 0; x < size; x++) {
      if (Math.hypot(x - center, y - center) < radius) {
        const i = 1 + x * 4
        row[i] = 220; row[i + 1] = 38; row[i + 2] = 38; row[i + 3] = 255
      }
    }
    rows.push(row)
  }
  const idat = deflateSync(Buffer.concat(rows))
  const crc32 = (buf: Buffer): number => {
    let crc = 0xffffffff
    for (const b of buf) crc = (CRC_TABLE[(crc ^ b) & 0xff] ?? 0) ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const t = Buffer.from(type, 'ascii')
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export function createTray(): void {
  trayNormalIcon = buildTrayIcon()
  try {
    trayRecordingIcon = nativeImage.createFromBuffer(buildRedCirclePng(16))
  } catch (err) {
    console.error('[tray] failed to create recording icon', err)
  }
  tray = new Tray(trayNormalIcon)
  tray.setToolTip('Shiori')
  tray.setContextMenu(buildTrayMenu())
  // Windows では左クリック（シングル）でウィンドウを開けるようにする。右クリックは
  // setContextMenu が握るのでメニュー表示のまま、左クリックだけこちらで拾う。
  tray.on('click', () => showMainWindow())
  tray.on('double-click', () => showMainWindow())
}

// 言語変更時に呼ぶ。メニュー項目のラベルは Menu 生成時に文字列として焼き込まれるので、
// t() の参照先が変わっても既存メニューは古い言語のまま残る。作り直しが必要なのはここだけ
// （他の main 側文言は表示の直前に t() を呼ぶため、設定変更が自動で効く）。
export function rebuildTrayMenu(): void {
  if (!tray) return
  tray.setContextMenu(buildTrayMenu())
  // ツールチップも現在の言語へ揃える（録画中に言語を変えた場合に取り残されないよう）。
  setTrayRecording(isRecording)
}

// 録画状態に応じてトレイアイコン・ツールチップを切り替える。
export function setTrayRecording(recording: boolean): void {
  if (!tray) return
  isRecording = recording
  if (recording) {
    if (trayRecordingIcon) tray.setImage(trayRecordingIcon)
    tray.setToolTip(t('tray.recording'))
  } else {
    if (trayNormalIcon) tray.setImage(trayNormalIcon)
    tray.setToolTip('Shiori')
  }
}
