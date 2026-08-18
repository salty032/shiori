// assets/icons/ の PNG を、アプリと拡張機能が読む場所へ配る。
// PNG は一切リサイズせず、渡されたバイト列をそのままコピー・そのまま .ico へ詰める。
// 絵を差し替えるときは assets/icons/ の PNG だけ入れ替えて、このスクリプトを流す。
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const src = (px) => join(root, 'assets/icons', `${px}.png`)

// トレイは論理サイズ 16 を 100%/150%/200% で表示するので 16/24/32 が要る。
const TRAY = [16, 24, 32]
// Chrome / Firefox の manifest が要求するサイズ。
const EXT = [16, 32, 48, 128]
// .ico に詰めるサイズ。用意された PNG をすべて入れ、OS に選ばせる。
// **256 は必須。** electron-builder が 256 未満の .ico を拒否するため、無いとパッケージが
// 「Icon must be at least 256x256 pixels」で落ちる（テストも型検査も通るので気づけない）。
const ICO = [16, 24, 32, 48, 128, 256]

// ICO は Vista 以降 PNG 圧縮エントリを扱えるため、デコードも再エンコードもせず
// PNG をそのまま格納する。こうすると出力される絵は元ファイルとビット単位で同じになる。
function packIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)

  const dir = Buffer.alloc(16 * pngs.length)
  let offset = header.length + dir.length
  pngs.forEach(({ px, data }, i) => {
    const e = i * 16
    dir[e] = px >= 256 ? 0 : px // width（256 は 0 で表す）
    dir[e + 1] = px >= 256 ? 0 : px // height
    dir[e + 2] = 0 // パレット色数（トゥルーカラーは 0）
    dir[e + 3] = 0 // reserved
    dir.writeUInt16LE(1, e + 4) // color planes
    dir.writeUInt16LE(32, e + 6) // bits per pixel
    dir.writeUInt32LE(data.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += data.length
  })

  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)])
}

const buildDir = join(root, 'app/build')
const extDir = join(root, 'extension')
mkdirSync(buildDir, { recursive: true })

for (const px of TRAY) copyFileSync(src(px), join(buildDir, `icon${px}.png`))
for (const px of EXT) copyFileSync(src(px), join(extDir, `icon${px}.png`))

writeFileSync(
  join(buildDir, 'icon.ico'),
  packIco(ICO.map((px) => ({ px, data: readFileSync(src(px)) })))
)

console.log(`[icons] tray ${TRAY.join('/')} / ext ${EXT.join('/')} / ico ${ICO.join('/')}`)
