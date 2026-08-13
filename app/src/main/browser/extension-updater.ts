import { app, Notification } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, mkdirSync, copyFileSync, readdirSync, rmSync } from 'fs'
import { compareVersions } from '../system/version'

export function bundledExtPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'extension')
    : join(app.getAppPath(), '..', 'extension')
}

export function installedExtensionPath(): string {
  return join(app.getPath('userData'), 'extension')
}

export function readVersion(dir: string): string | null {
  try {
    const raw = readFileSync(join(dir, 'manifest.json'), 'utf-8')
    return (JSON.parse(raw) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

// サブフォルダ（将来のアイコンディレクトリ等）も取りこぼさないよう再帰コピーする。
// フラット前提の copyFileSync だとディレクトリに当たって throw し、起動を巻き込む。
function copyDir(src: string, dest: string, deferManifest = false): void {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (deferManifest && entry.name === 'manifest.json') continue
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else copyFileSync(s, d)
  }
}

// copyDir は上書きと追加しかしないため、旧バージョンにあって新バージョンで消えたファイル
// （リネーム前のスクリプトや使わなくなったアイコン等）がインストール先に残り続ける。
// manifest に載っていなければ Chrome は読まないので実害はないが、更新のたびに溜まる一方
// なのでバンドル側に存在しないものを消す。インストール先はバンドルの純粋なコピーで、
// ユーザー生成物も Chrome の書き込みも無いため、消して失うものはない。
// manifest.json は copyExtensionUpdate が最後に置く（コミットマーカー）ので除外する。
function pruneExtras(src: string, dest: string): void {
  for (const entry of readdirSync(dest, { withFileTypes: true })) {
    if (entry.name === 'manifest.json') continue
    const d = join(dest, entry.name)
    if (!existsSync(join(src, entry.name))) {
      rmSync(d, { recursive: true, force: true })
      continue
    }
    if (entry.isDirectory()) pruneExtras(join(src, entry.name), d)
  }
}

// manifest は更新完了のコミットマーカーとして最後に置く。途中でコピーに失敗しても
// installedVersion は旧版のままなので、次回起動時に更新を再試行できる。
// prune も manifest 配置より前に済ませ、中断時は次回起動でまるごとやり直させる。
export function copyExtensionUpdate(src: string, dest: string): void {
  copyDir(src, dest, true)
  pruneExtras(src, dest)
  copyFileSync(join(src, 'manifest.json'), join(dest, 'manifest.json'))
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
      copyExtensionUpdate(bundled, installed)

      if (installedVersion) {
        new Notification({
          title: 'Shiori',
          body: `拡張機能が ${installedVersion} → ${bundledVersion} に更新されました。Chrome の chrome://extensions で再読み込みを押してください。`
        }).show()
      }
    }
  } catch (err) {
    console.warn('[ext-update] failed (non-fatal)', err)
  }
}
