import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'fs'
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

function smartFolders(value: unknown): SmartFolder[] {
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
    captureNotify: data.captureNotify !== false,
    allowedExtensionIds: allowedIds.length > 0 ? allowedIds : [EXTENSION_ID],
    serviceOrder: stringList(data.serviceOrder),
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

export function saveSettings(s: unknown): void {
  // tmp に書いてから rename（同一FS上ではアトミック）。
  // 書き込み途中のクラッシュ・電源断で settings.json 本体が壊れるのを防ぐ。
  const path = settingsPath()
  const tmp = `${path}.tmp`
  try {
    const normalized = normalizeSettings(s)
    writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf-8')
    renameSync(tmp, path)
    _settingsCache = normalized
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
}
