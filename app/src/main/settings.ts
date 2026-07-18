import { app } from 'electron'
import { join } from 'path'
import { readFileSync, existsSync, renameSync } from 'fs'
import { writeFile, rename, unlink } from 'fs/promises'
import { normalizeCaptureHotkey } from './hotkey'
import type { SmartFolder, Settings } from '../shared/types'
import { SETTINGS_DEFAULTS } from '../shared/settingsDefaults'

export type { SmartFolder, Settings }

const EXTENSION_ID = 'cgoodmpndbpjjlhpeimjjjjccioebdpn'
const DEFAULTS: Settings = { ...SETTINGS_DEFAULTS, allowedExtensionIds: [EXTENSION_ID] }
const MAX_STRINGS = 100
const MAX_TEXT_LENGTH = 200
const MAX_SMART_FOLDERS = 50

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, MAX_TEXT_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_STRINGS)
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function nullableText(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, MAX_TEXT_LENGTH) : null
}

export function smartFolders(value: unknown): SmartFolder[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_SMART_FOLDERS).map((folder, index) => {
    const data = folder && typeof folder === 'object' ? folder as Record<string, unknown> : {}
    return {
      id: nullableText(data.id) ?? `folder-${index}`,
      name: nullableText(data.name) ?? 'Untitled',
      tags: stringList(data.tags),
      tagMode: data.tagMode === 'or' ? 'or' : 'and',
      site: nullableText(data.site),
      search: nullableText(data.search) ?? ''
    }
  })
}

function hotkeyText(value: unknown, fallback: string): string {
  return normalizeCaptureHotkey(value) ?? fallback
}

function themeValue(value: unknown): Settings['theme'] {
  return value === 'dark' || value === 'light' || value === 'system' ? value : 'dark'
}

function extensionIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[a-p]{32}$/.test(item))
    .slice(0, MAX_STRINGS)
}

export function normalizeSettings(value: unknown): Settings {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const allowedIds = extensionIdList(data.allowedExtensionIds)
  return {
    titleStrip: stringList(data.titleStrip),
    thumbnailSize: boundedNumber(data.thumbnailSize, DEFAULTS.thumbnailSize, 80, 360),
    frameFps: boundedNumber(data.frameFps, DEFAULTS.frameFps, 1, 60),
    frameFpsAuto: data.frameFpsAuto !== false,
    smartFolders: smartFolders(data.smartFolders),
    captureHotkey: hotkeyText(data.captureHotkey, DEFAULTS.captureHotkey),
    clipHotkey: hotkeyText(data.clipHotkey, DEFAULTS.clipHotkey),
    clipMaxSeconds: boundedNumber(data.clipMaxSeconds, DEFAULTS.clipMaxSeconds, 5, 300),
    clipNotify: data.clipNotify !== false,
    captureNotify: data.captureNotify !== false,
    allowedExtensionIds: allowedIds.length > 0 ? allowedIds : [EXTENSION_ID],
    serviceOrder: stringList(data.serviceOrder),
    showAiTags: data.showAiTags === true,
    theme: themeValue(data.theme),
    lastRunVersion: nullableText(data.lastRunVersion),
  }
}

let _settingsCache: Settings | null = null
// 破損検知を呼び出し側（bootstrap）へ伝える一回限りのフラグ。loadSettings 自体は
// windows.ts に依存させたくない（sendNotice は mainWindow 生成前だと無言で消える）ため、
// 実際の通知はウィンドウ準備後に consumeCorruptSettingsNotice() で拾わせる。
let _corruptOnLoad = false

export function consumeCorruptSettingsNotice(): boolean {
  const v = _corruptOnLoad
  _corruptOnLoad = false
  return v
}

export function loadSettings(): Settings {
  if (_settingsCache) return _settingsCache
  try {
    if (existsSync(settingsPath())) {
      const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'))
      _settingsCache = normalizeSettings({ ...DEFAULTS, ...parsed })
      return _settingsCache
    }
  } catch (err) {
    console.warn('[settings] load failed, using defaults:', err)
    // 破損したファイルは無言でデフォルト初期化すると、次の設定変更で上書き保存され
    // 復旧不能になる。退避してから通知フラグを立てる（中身の復旧は手動でも可能にする）。
    try {
      if (existsSync(settingsPath())) {
        renameSync(settingsPath(), `${settingsPath()}.corrupt-${Date.now()}`)
      }
    } catch (renameErr) {
      console.warn('[settings] failed to preserve corrupt settings.json:', renameErr)
    }
    _corruptOnLoad = true
  }
  _settingsCache = { ...DEFAULTS }
  return _settingsCache
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 直列化された永続化キュー。連続変更でもディスクへの書き込み順序が入れ替わらないようにする。
let _persistChain: Promise<void> = Promise.resolve()

// ディスクへの永続化はベストエフォート。Windows ではウイルス対策・検索インデクサ・別ハンドルが
// settings.json を一時的にロックし、rename/write が EPERM/EBUSY/EACCES で間欠的に失敗する。
// これを同期書き込みで throw させると settingsSet IPC が reject し、renderer 側が楽観更新を
// 巻き戻して「設定がたまに反映されない」原因になっていた。ここではリトライで吸収し、最終的に
// 失敗しても throw しない（セッション内の値は _settingsCache が保持し、次の変更で再度書き込まれる）。
async function persistToDisk(data: Settings): Promise<void> {
  const path = settingsPath()
  const tmp = `${path}.tmp`
  const json = JSON.stringify(data, null, 2)
  const MAX_ATTEMPTS = 5
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // tmp に書いてから rename（同一FS上ではアトミック）。
      // 書き込み途中のクラッシュ・電源断で settings.json 本体が壊れるのを防ぐ。
      await writeFile(tmp, json, 'utf-8')
      await rename(tmp, path)
      return
    } catch (err) {
      await unlink(tmp).catch(() => {})
      const code = (err as NodeJS.ErrnoException).code
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (attempt === MAX_ATTEMPTS || !transient) {
        // tmp+rename が通らない場合の最終手段として実ファイルへ直接書き込む
        // （原子性は劣るが rename の EPERM を回避できる）。これも失敗したら諦める。
        try { await writeFile(path, json, 'utf-8'); return }
        catch (fallbackErr) { console.error('[settings] persist failed after retries:', fallbackErr); return }
      }
      await delay(80 * attempt)  // 80,160,240,320ms のバックオフ
    }
  }
}

export function saveSettings(s: unknown): void {
  const normalized = normalizeSettings(s)
  // セッション内の真実はここ。ディスク反映を待たず即座に確定し、loadSettings/getSettings が
  // 常に最新値を返すようにする（永続化の成否と UI 反映を切り離す）。
  _settingsCache = normalized
  _persistChain = _persistChain
    .then(() => persistToDisk(normalized))
    .catch((err) => { console.error('[settings] unexpected persist error:', err) })
}

// saveSettings はディスク反映を待たずに返るため、直後にプロセスが終了すると
// 最後の変更だけ書き込まれずに巻き戻る（テーマ変更 → 即終了、など）。終了経路では
// これを await してキューを空にしてから終わること（bootstrap の before-quit）。
// アップデート適用も app.quit() 経由で before-quit を通るので、同じ経路で守られる。
//
// _persistChain は catch 済みで reject しない。await 中に新しい saveSettings が
// 来た場合は積まれた側を取り逃すが、終了直前にそこまで面倒を見る必要はない
// （before-quit 時点でウィンドウは閉じており、新規の設定変更はもう来ない）。
export function flushSettings(): Promise<void> {
  return _persistChain
}
