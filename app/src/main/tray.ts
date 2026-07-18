import { app, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { deflateSync } from 'zlib'
import { sendToRenderer, showMainWindow } from './windows'
import { CH } from '../shared/api'

let tray: Tray | null = null
let trayNormalIcon: Electron.NativeImage | null = null
let trayRecordingIcon: Electron.NativeImage | null = null

function buildTrayMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    { label: '開く', click: () => showMainWindow() },
    {
      label: '設定',
      click: () => {
        showMainWindow()
        sendToRenderer(CH.openSettings)
      }
    },
    { label: '終了', click: () => app.quit() }
  ])
}

// トレイ用アイコンを、サイズごとに描き分けた PNG（build/icon16・icon32・icon48）から組み立てる。
// icon.ico を nativeImage.createFromPath() で読むと最大サイズ（256x256）の 1 枚しか取り出せず、
// それを 16px 枠へ潰し込むことになって絵が崩れる。小サイズ用に線の太さを調整した専用 PNG を
// スケールごとに持たせ、表示スケール（100%/150%/200%）に応じた解像度を OS に選ばせる。
// トレイの論理サイズは 16。各 representation のピクセル数は 16 * scaleFactor になる必要があるため、
// 1x=16px / 1.5x=24px（48px を縮小）/ 2x=32px を渡す。
function buildTrayIcon(): Electron.NativeImage {
  const icon = nativeImage.createEmpty()
  for (const [scaleFactor, file, px] of [[1, 'icon16.png', 16], [1.5, 'icon48.png', 24], [2, 'icon32.png', 32]] as const) {
    const rep = nativeImage.createFromPath(join(__dirname, '../../build', file))
    if (rep.isEmpty()) continue
    const sized = rep.getSize().width === px ? rep : rep.resize({ width: px, height: px, quality: 'best' })
    icon.addRepresentation({ scaleFactor, buffer: sized.toPNG() })
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

// 録画状態に応じてトレイアイコン・ツールチップを切り替える。
export function setTrayRecording(recording: boolean): void {
  if (!tray) return
  if (recording) {
    if (trayRecordingIcon) tray.setImage(trayRecordingIcon)
    tray.setToolTip('Shiori — 録画中')
  } else {
    if (trayNormalIcon) tray.setImage(trayNormalIcon)
    tray.setToolTip('Shiori')
  }
}
