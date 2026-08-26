import { app } from 'electron'
import { join } from 'path'
import { readFileSync, existsSync, renameSync } from 'fs'
import { writeFile, rename, unlink } from 'fs/promises'
import { normalizeCaptureHotkey } from '../browser/hotkey'
import type { SmartFolder, Settings, Lang } from '../../shared/types'
import { langFromLocale } from '../../shared/i18n'
import { SETTINGS_DEFAULTS } from '../../shared/settingsDefaults'

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

function languageValue(value: unknown): Lang {
  return value === 'ja' || value === 'en' ? value : DEFAULTS.language
}

function videoExportFormatValue(value: unknown): Settings['videoExportFormat'] {
  return value === 'h264' ? 'h264' : DEFAULTS.videoExportFormat
}

// 新規インストール時の初期表示言語。app.getLocale() は app ready 前だと空文字を返しうるので、
// 呼ぶのは settings.json が存在しないと分かった後（＝ready 後の loadSettings）に限る。
// 一度決めたら settings.json に焼き付き、以降 OS の言語変更には追従しない
// （ユーザーが設定画面で選び直した値を勝手に上書きしないため）。
function osDefaultLang(): Lang {
  try {
    return langFromLocale(app.getLocale())
  } catch {
    return DEFAULTS.language
  }
}

function extensionIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[a-p]{32}$/.test(item))
    .slice(0, MAX_STRINGS)
}

// 旧 S/M/L（120/160/220）は全画面だと小さすぎたため 150/230/320 へ引き上げた。
// 既存の settings.json をそのまま読むと、更新しても画面が前のままになり
// 「サイズを変えていない人には何も起きていない」ように見えるので、旧値だけを
// 新しい同じ段（S→S, M→M, L→L）へ読み替える。180/260/360 は一度だけ入れた
// 引き上げ幅で、そのまま保存された設定が残っている可能性があるため一緒に拾う。
// キーに現行の3値（150/230/320）を入れてはいけない。読み込みのたびに
// 隣の段へ移り、選んだ大きさが起動ごとに変わる。
// 代償：表のいずれかの値をたまたま手で書いていた場合も読み替えられる。
const LEGACY_THUMB_SIZES: Record<number, number> = {
  120: 150, 160: 230, 220: 320,
  180: 150, 260: 230, 360: 320,
}
function migrateThumbnailSize(value: unknown): unknown {
  if (typeof value !== 'number') return value
  return LEGACY_THUMB_SIZES[value] ?? value
}

export function normalizeSettings(value: unknown): Settings {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const allowedIds = extensionIdList(data.allowedExtensionIds)
  return {
    titleStrip: stringList(data.titleStrip),
    thumbnailSize: boundedNumber(migrateThumbnailSize(data.thumbnailSize), DEFAULTS.thumbnailSize, 80, 360),
    frameFps: boundedNumber(data.frameFps, DEFAULTS.frameFps, 1, 60),
    frameFpsAuto: data.frameFpsAuto !== false,
    smartFolders: smartFolders(data.smartFolders),
    captureHotkey: hotkeyText(data.captureHotkey, DEFAULTS.captureHotkey),
    clipHotkey: hotkeyText(data.clipHotkey, DEFAULTS.clipHotkey),
    // 著作権対策として録画時間を厳格に上限30秒とする（設定でもこれ以上には出来ない）。
    // インポート動画の尺上限（ipc-import.ts の MAX_IMPORT_VIDEO_SECONDS）と揃える。
    clipMaxSeconds: boundedNumber(data.clipMaxSeconds, DEFAULTS.clipMaxSeconds, 5, 30),
    clipNotify: data.clipNotify !== false,
    captureNotify: data.captureNotify !== false,
    allowedExtensionIds: allowedIds.length > 0 ? allowedIds : [EXTENSION_ID],
    serviceOrder: stringList(data.serviceOrder),
    showAiTags: data.showAiTags === true,
    theme: themeValue(data.theme),
    language: languageValue(data.language),
    videoExportFormat: videoExportFormatValue(data.videoExportFormat),
    lastRunVersion: nullableText(data.lastRunVersion),
  }
}

let _settingsCache: Settings | null = null

// 読み込みに失敗する理由は 2 種類あり、**取るべき行動が正反対**なので混ぜてはいけない。
//   * 'corrupt'    — 中身が JSON として読めない。放っておくと次の設定変更で上書きされて
//                    復旧不能になるので、退避（.corrupt-<時刻>）してから初期値で立ち上げる。
//   * 'unreadable' — ファイルは在るが読めなかった。Windows ではウイルス対策・検索インデクサ・
//                    別ハンドルが settings.json を一瞬掴むことがあり、EPERM/EBUSY/EACCES が
//                    間欠的に出る。**これを破損として退避すると、掴まれていた瞬間に起動した
//                    だけで設定が初期値に戻る。** ファイルには一切触らず、リトライで吸収する
//                    （書き込み側 persistToDisk と同じ考え方）。それでも読めなければ、
//                    初期値で動いていることと上書きの危険を画面に出す。
export type SettingsLoadProblem = 'corrupt' | 'unreadable'

// 検知を呼び出し側（bootstrap）へ伝える一回限りのフラグ。loadSettings 自体は windows.ts に
// 依存させたくない（sendNotice は mainWindow 生成前だと無言で消える）ため、実際の通知は
// ウィンドウ準備後に consumeSettingsLoadProblem() で拾わせる。
let _loadProblem: SettingsLoadProblem | null = null

export function consumeSettingsLoadProblem(): SettingsLoadProblem | null {
  const v = _loadProblem
  _loadProblem = null
  return v
}

// ロックが外れるのを待つだけなので、非同期にする意味が無い（loadSettings は同期で、
// 呼び出し側は起動処理）。最悪でも 80+160+240=480ms で抜ける。
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

function readSettingsText(path: string): string {
  const MAX_ATTEMPTS = 4
  for (let attempt = 1; ; attempt++) {
    try {
      return readFileSync(path, 'utf-8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= MAX_ATTEMPTS || !TRANSIENT_CODES.has(code ?? '')) throw err
      sleepSync(80 * attempt)  // 80,160,240ms のバックオフ
    }
  }
}

export function loadSettings(): Settings {
  if (_settingsCache) return _settingsCache
  try {
    const path = settingsPath()
    if (existsSync(path)) {
      // 読めた後の JSON.parse だけが「破損」。ここを分けないと、読めなかっただけの
      // ファイルまで退避されて初期値に戻る。
      const text = readSettingsText(path)
      try {
        _settingsCache = normalizeSettings({ ...DEFAULTS, ...JSON.parse(text) })
        return _settingsCache
      } catch (parseErr) {
        console.warn('[settings] settings.json is corrupt, preserving it:', parseErr)
        try {
          renameSync(path, `${path}.corrupt-${Date.now()}`)
        } catch (renameErr) {
          console.warn('[settings] failed to preserve corrupt settings.json:', renameErr)
        }
        _loadProblem = 'corrupt'
      }
    }
  } catch (err) {
    // リトライしても読めなかった（ロック・権限）。ファイルは残っているので触らない。
    console.warn('[settings] could not read settings.json, leaving it untouched:', err)
    _loadProblem = 'unreadable'
  }
  // ここに来るのは「settings.json が無い（＝新規インストール）」か「読み込みに失敗した」かの
  // どちらか。前者だけ OS ロケールから表示言語を決める。後者は設定を持っていたユーザーなので、
  // 破損や読み取り失敗をきっかけに表示言語まで変わらないよう DEFAULTS の 'ja' を維持する。
  _settingsCache = { ...DEFAULTS, language: _loadProblem ? DEFAULTS.language : osDefaultLang() }
  return _settingsCache
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 永続化の最終失敗を呼び出し側（bootstrap）へ伝える購読口。settings.ts は windows.ts に
// 依存させたくない（_corruptOnLoad と同じ理由）ので、通知の実体は bootstrap 側に持たせる。
//
// **なぜ黙って諦めてはいけないか** — saveSettings はディスク反映を待たずに返る設計で、
// 画面上は保存できたようにしか見えない。書き込みが最後まで通らなかった場合、次に起動した
// ときだけ設定が巻き戻る。原因（AV のロック・ディスク満杯・権限）に心当たりが無いまま
// 「たまに設定が戻る」が起きるので、その場で言う。
let _persistFailed = false
const persistFailedCallbacks: Array<() => void> = []

export function onSettingsPersistFailed(cb: () => void): void {
  persistFailedCallbacks.push(cb)
  // 登録前に失敗していた場合（起動直後の保存など）も取りこぼさない。
  if (_persistFailed) cb()
}

// 連続変更のたびに出すと、ロック中は同じトーストが何枚も重なる。一度知らせたら、
// 次に 1 回でも書き込めるまでは黙る（＝失敗→成功→失敗なら 2 回目も出る）。
function notifyPersistFailed(): void {
  if (_persistFailed) return
  _persistFailed = true
  persistFailedCallbacks.forEach((cb) => cb())
}

// 直列化された永続化キュー。連続変更でもディスクへの書き込み順序が入れ替わらないようにする。
let _persistChain: Promise<void> = Promise.resolve()

// ディスクへの永続化はベストエフォート。Windows ではウイルス対策・検索インデクサ・別ハンドルが
// settings.json を一時的にロックし、rename/write が EPERM/EBUSY/EACCES で間欠的に失敗する。
// これを同期書き込みで throw させると settingsSet IPC が reject し、renderer 側が楽観更新を
// 巻き戻して「設定がたまに反映されない」原因になっていた。ここではリトライで吸収し、最終的に
// 失敗しても throw しない（セッション内の値は _settingsCache が保持し、次の変更で再度書き込まれる）。
// ただし**黙って諦めない**——リトライを使い切ったら onSettingsPersistFailed で画面に出す。
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
      _persistFailed = false
      return
    } catch (err) {
      await unlink(tmp).catch(() => {})
      const code = (err as NodeJS.ErrnoException).code
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (attempt === MAX_ATTEMPTS || !transient) {
        // tmp+rename が通らない場合の最終手段として実ファイルへ直接書き込む
        // （原子性は劣るが rename の EPERM を回避できる）。これも失敗したら諦める。
        try { await writeFile(path, json, 'utf-8'); _persistFailed = false; return }
        catch (fallbackErr) {
          console.error('[settings] persist failed after retries:', fallbackErr)
          notifyPersistFailed()
          return
        }
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
