import { app, Notification } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, mkdirSync, copyFileSync, readdirSync } from 'fs'

function bundledExtPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'extension')
    : join(app.getAppPath(), '..', 'extension')
}

export function installedExtensionPath(): string {
  return join(app.getPath('userData'), 'extension')
}

function readVersion(dir: string): string | null {
  try {
    const raw = readFileSync(join(dir, 'manifest.json'), 'utf-8')
    return (JSON.parse(raw) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

function compareVersions(a: string, b: string): number {
  // "0.4.0-beta" のような非数値セグメントは Number() で NaN になり、NaN の引き算が
  // 常に false 側（更新なし判定）に倒れる。NaN は 0 扱いにフォールバックする。
  const toParts = (v: string): number[] => v.split('.').map((seg) => {
    const n = Number(seg)
    return Number.isFinite(n) ? n : 0
  })
  const pa = toParts(a)
  const pb = toParts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

// サブフォルダ（将来のアイコンディレクトリ等）も取りこぼさないよう再帰コピーする。
// フラット前提の copyFileSync だとディレクトリに当たって throw し、起動を巻き込む。
function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else copyFileSync(s, d)
  }
}

export function checkExtensionUpdate(): void {
  // 拡張のバンドル更新は best-effort。コピー失敗（権限・AVロック・ディスクフル等）が
  // whenReady の後続（initDb / WS / ウィンドウ生成 / トレイ / ホットキー）を道連れにして
  // 「起動したのに何も無い」状態を招かないよう、ここで必ず例外を飲み込む。
  // 失敗してもバンドル拡張はそのまま動作し、ユーザーは手動で再読み込みできる。
  try {
    const bundled = bundledExtPath()
    const installed = installedExtensionPath()

    if (!existsSync(bundled)) return

    const bundledVersion = readVersion(bundled)
    if (!bundledVersion) return

    const installedVersion = readVersion(installed)

    if (!installedVersion || compareVersions(bundledVersion, installedVersion) > 0) {
      copyDir(bundled, installed)

      if (installedVersion) {
        new Notification({
          title: '栞',
          body: `拡張機能が ${installedVersion} → ${bundledVersion} に更新されました。Chrome の chrome://extensions で再読み込みを押してください。`
        }).show()
      }
    }
  } catch (err) {
    console.warn('[ext-update] failed (non-fatal)', err)
  }
}
