import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ライブラリのエクスポート → インポートを、本物のファイルとデータベースで通す（PC を移す道）。
// 差し替えるのは、フォルダを選ぶ画面・画面への通知・動画の解析（ffmpeg）・AI のタグ付けだけ。
// データベースは本物のスキーマに実物の SQLite（test-sqlite-shim.ts）、書き出し・読み込み・保存先は本物。
// 破ると、移した先で撮った日時・撮ったか取り込んだか・タグ・メモ・タイムシート・コマの表が黙って欠ける。

const state = vi.hoisted(() => ({ userData: '', pick: '' }))
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

vi.mock('electron', () => ({ app: { getPath: () => state.userData, isPackaged: false, getVersion: () => '0.0.0' } }))
vi.mock('better-sqlite3', async () => ({ default: (await import('../db/test-sqlite-shim')).SqliteShim }))
vi.mock('../system/dialogs', () => ({
  showOpenDialogOver: async () => ({ canceled: false, filePaths: [state.pick] }),
  showMessageBoxOver: async () => ({ response: 0 }),
}))
vi.mock('../system/windows', () => ({
  handleTrusted: (channel: string, listener: (...args: unknown[]) => unknown) => { handlers.set(channel, listener) },
  sendToRenderer: () => {},
  sendNotice: () => {},
  safeExternalUrl: (url: string) => url,
  getMainWindow: () => null,
}))
vi.mock('../video/ffmpeg', () => ({
  extractThumb: async () => { throw new Error('no ffmpeg in test') },
  getVideoMeta: async () => ({ duration: 5, fps: 24 }),
}))
vi.mock('../capture/tagger', () => ({ canAutoTag: async () => false, ensureModel: async () => {}, runTagger: async () => [] }))

import { initDb } from '../db/db-schema'
import { getDb, prepare } from '../db/db-core'
import { insertImage, getTimesheet, saveTimesheet } from '../db/db'
import { addTagsBulk, getImageTags } from '../db/db-tags'
import { getVideoFrames, saveVideoFrames, type StoredFrame } from '../db/db-video-frames'
import { ensureCaptureSubDir } from '../system/paths'
import { registerShareHandlers } from './ipc-share'

const dirs: string[] = []
const tempDir = (name: string): string => { const d = mkdtempSync(join(tmpdir(), `shiori-${name}-`)); dirs.push(d); return d }

type Row = { id: number; filepath: string; captured_at: number; original_captured_at: number | null; source: string; title: string | null; memo: string | null; url: string | null; current_time: number | null; media_type: string }
// current_time は SQLite の予約語（今の時刻）なので、列として読むには引用符が要る。囲まないと時計を比べてしまい、
// 再生位置を確かめないまま、秒がまたいだときだけ落ちていた。
const rows = (): Row[] => prepare('SELECT id, filepath, captured_at, original_captured_at, source, title, memo, url, "current_time", media_type FROM images ORDER BY title').all() as Row[]
const manualTags = (id: number): string[] => getImageTags(id).filter((t) => t.source === 'manual').map((t) => t.name).sort()

const frames: StoredFrame[] = [
  { mediaTime: 0, frameIndex: 0, captured: true, verified: 'unknown' },
  { mediaTime: 1 / 24, frameIndex: 2, captured: true, verified: 'unknown' },
  { mediaTime: 2 / 24, frameIndex: 2, captured: false, verified: 'changed' },
]
// 打った位置（表の行）・動画番号・列（D 列 = 3）。保存の形のまま比べる。
const timesheet = '[[0,"A1"],[2,"","",3]]'

// 送り元のライブラリ：撮った画像・撮った動画（コマの表・タイムシートつき）・取り込んだ画像。
async function seedLibrary(): Promise<void> {
  const dir = await ensureCaptureSubDir(1_700_000_000_000)
  const file = (name: string): string => { const p = join(dir, name); writeFileSync(p, `bytes of ${name}`); return p }
  const shot = insertImage({ filepath: file('shot.png'), captured_at: 1_700_000_000_000, title: 'a 撮った画像', current_time: 12.5, url: 'https://example.com/w', width: 1280, height: 720, memo: '線の歪み', media_type: 'image', duration: null, fps: null, thumb_path: null, source: 'capture' })
  addTagsBulk(shot, [{ name: 'tag_a', source: 'manual' }, { name: 'ai_tag', source: 'ai' }])
  const clip = insertImage({ filepath: file('clip.webm'), captured_at: 1_700_000_100_000, title: 'b 撮った動画', current_time: 30, url: null, width: 1920, height: 1080, memo: null, media_type: 'video', duration: 5, fps: 24, thumb_path: null, source: 'capture' })
  saveVideoFrames(clip, frames)
  saveTimesheet(clip, timesheet)
  const imported = insertImage({ filepath: file('imported.png'), captured_at: 1_700_000_200_000, original_captured_at: 1_500_000_000_000, title: 'c 取り込んだ画像', current_time: null, url: null, width: null, height: null, memo: 'もらった', media_type: 'image', duration: null, fps: null, thumb_path: null, source: 'import' })
  addTagsBulk(imported, [{ name: 'tag_b', source: 'manual' }])
}

async function exportFrom(userData: string): Promise<string> {
  state.userData = userData
  state.pick = tempDir('export-parent')
  const result = await handlers.get('share:export')!({}) as { canceled: boolean; count: number; path: string }
  expect(result).toMatchObject({ canceled: false, count: 3 })
  return result.path
}

async function importInto(userData: string, bundle: string, mode: 'restore' | 'receive'): Promise<void> {
  ;(getDb() as unknown as { close(): void }).close()
  state.userData = userData
  initDb()
  state.pick = bundle
  const result = await handlers.get('share:import')!({}, mode) as { canceled: boolean; count: number; errors: string[] }
  expect(result).toMatchObject({ canceled: false, count: 3, errors: [] })
}

beforeEach(async () => {
  handlers.clear()
  state.userData = tempDir('from')
  initDb()
  registerShareHandlers()
  await seedLibrary()
})

afterEach(() => {
  try { (getDb() as unknown as { close(): void }).close() } catch { /* 閉じ済み */ }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('ライブラリのエクスポート → 自分のライブラリとして戻す', () => {
  it('撮った日時・撮ったか取り込んだか・題名・メモ・URL・再生位置・手動タグがそのまま戻る', async () => {
    const before = rows().map((r) => ({ ...r, tags: manualTags(r.id) }))
    const bundle = await exportFrom(state.userData)
    await importInto(tempDir('to'), bundle, 'restore')
    const after = rows().map((r) => ({ ...r, tags: manualTags(r.id) }))
    const strip = ({ id: _id, filepath: _f, ...rest }: Row & { tags: string[] }) => rest
    expect(after.map(strip)).toEqual(before.map(strip))
  })

  it('動画のコマの表とタイムシートもそのまま戻る', async () => {
    const bundle = await exportFrom(state.userData)
    await importInto(tempDir('to'), bundle, 'restore')
    const clip = rows().find((r) => r.media_type === 'video')!
    expect(getVideoFrames(clip.id)).toEqual(frames)
    expect(getTimesheet(clip.id)).toBe(timesheet)
  })

  it('ファイルは移した先の保存先に入り、開ける場所を指す', async () => {
    const bundle = await exportFrom(state.userData)
    const to = tempDir('to')
    await importInto(to, bundle, 'restore')
    for (const r of rows()) expect(r.filepath.startsWith(join(to, 'captures'))).toBe(true)
  })
})

describe('ライブラリのエクスポート → 受け取った素材として追加する', () => {
  it('全部を取り込んだ素材として今日の日付で入れ、元の撮影日時は残す', async () => {
    const bundle = await exportFrom(state.userData)
    const t0 = Date.now()
    await importInto(tempDir('to'), bundle, 'receive')
    const after = rows()
    expect(after.every((r) => r.source === 'import')).toBe(true)
    expect(after.every((r) => r.captured_at >= t0)).toBe(true)
    expect(after.map((r) => r.original_captured_at)).toEqual([1_700_000_000_000, 1_700_000_100_000, 1_500_000_000_000])
  })
})
