import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { StoredFrame } from '../db-video-frames'

// 検証（verifyClipFrames）は保存の後にバックグラウンドで走り、「N コマ未取得」（未検証）を
// 「N コマ要確認」へ変える。一覧は保存時点のスナップショットなので、**確定した枚数を
// 画面へ飛ばさないと検証済みの行が未検証の表示のまま残る**（実測 2026-08-10: DB は
// ambiguous=64 なのに画面は 90コマ未取得 のままだった）。経路ごとに飛ぶことを固定する。

const signatures = { value: [] as Uint8Array[], pts: [] as number[] }
vi.mock('./ffmpeg', () => ({
  getFrameSignatures: () => Promise.resolve({ signatures: signatures.value, pts: signatures.pts })
}))

const sendToRenderer = vi.fn()
vi.mock('../system/windows', () => ({ sendToRenderer: (...args: unknown[]) => sendToRenderer(...args) }))

const markVideoFramesUnusable = vi.fn()
vi.mock('../db', () => ({
  setAmbiguousFrames: vi.fn(),
  setFrameCounts: vi.fn()
}))

const saveVideoFrames = vi.fn()
vi.mock('../db-video-frames', () => ({
  markVideoFramesUnusable: (...args: unknown[]) => markVideoFramesUnusable(...args),
  saveVideoFrames: (...args: unknown[]) => saveVideoFrames(...args),
  listClipsForRecheck: vi.fn(() => []),
  markRechecked: vi.fn()
}))

import { verifyClipFrames } from './verify-clip'
import { CH } from '../../shared/api'

const GRID = 32 * 32
function flat(value: number): Uint8Array {
  return new Uint8Array(GRID).fill(value)
}

// total（素材のコマ総数）も一緒に飛ばす。分子だけ更新すると、一覧のスナップショットの中で
// 分子と分母が別の時点の数になり、詳細パネルの割合判定が静かに狂う。
type VerifiedPayload = { id: number; uncaptured: number | null; ambiguous: number | null; total: number | null; unreported: number | null }

function verifiedPayload(): VerifiedPayload | null {
  const call = sendToRenderer.mock.calls.find((c) => c[0] === CH.framesVerified)
  return call ? (call[1] as VerifiedPayload) : null
}

describe('verifyClipFrames（検証結果を画面へ反映する通知）', () => {
  beforeEach(() => {
    sendToRenderer.mockClear()
    markVideoFramesUnusable.mockClear()
    saveVideoFrames.mockClear()
  })

  it('撮り逃したコマを検証したら、確定した枚数を飛ばす', () => {
    // 絵が変わっている＝「要確認」に落ちるコマを 1 つ作る。
    signatures.value = [flat(10), flat(200)]
    signatures.pts = [0, 0.02]
    const table: StoredFrame[] = [
      { mediaTime: 0, frameIndex: 0, captured: true },
      { mediaTime: 0.04, frameIndex: 0, captured: false },
      { mediaTime: 0.08, frameIndex: 1, captured: true }
    ]
    return verifyClipFrames(7, 'clip.webm', table, null).then(() => {
      expect(verifiedPayload()).toEqual({ id: 7, uncaptured: 1, ambiguous: 1, total: 3, unreported: 0, misaligned: 0, unreportedMeasured: true })
    })
  })

  it('撮り逃しが 0 でも飛ばす（未検証の表示を残さない）', () => {
    signatures.value = [flat(10), flat(200)]
    signatures.pts = [0, 0.02]
    const table: StoredFrame[] = [
      { mediaTime: 0, frameIndex: 0, captured: true },
      { mediaTime: 0.04, frameIndex: 1, captured: true }
    ]
    return verifyClipFrames(8, 'clip.webm', table, null).then(() => {
      expect(verifiedPayload()).toEqual({ id: 8, uncaptured: 0, ambiguous: null, total: 2, unreported: 0, misaligned: 0, unreportedMeasured: true })
    })
  })

  it('撮り逃しが0でも、録画に残った境界からアニメの抜け推定を保存する', async () => {
    signatures.pts = Array.from({ length: 13 }, (_, i) => 13.369 + i * 0.02)
    signatures.value = [
      flat(20), flat(20), flat(20), flat(20),
      flat(100), flat(100), flat(100), flat(100),
      flat(180), flat(180), flat(180), flat(180), flat(180)
    ]
    const table: StoredFrame[] = [
      { mediaTime: 35.201, frameIndex: 0, captured: true },
      { mediaTime: 35.243, frameIndex: 2, captured: true },
      { mediaTime: 35.410, frameIndex: 10, captured: true },
      { mediaTime: 35.452, frameIndex: 12, captured: true }
    ]

    await verifyClipFrames(297, 'clip.webm', table, null)

    const saved = saveVideoFrames.mock.calls.at(-1)?.[1] as StoredFrame[]
    expect(saved).toHaveLength(table.length)
    expect(saved[1].animeGapMissing).toBe(2)
    expect(verifiedPayload()?.unreported).toBe(3)
  })

  // **崩れても表を丸ごと捨てない。** 崩れた位置より手前は正しいので残し、以降の行にだけ
  // 「ずれ」の印を立てる。捨てること自体がコマ精度を失う変更にあたる（ANIME-FRAMES.md 0 章）。
  it('対応が途中から崩れたら、手前は残して以降の行にずれの印を立てる', () => {
    signatures.value = [flat(10), flat(20), flat(30)]
    signatures.pts = [0, 0.04, 0.08]
    const drawnAt = [1000, 1020, 1040, 1060]
    const table: StoredFrame[] = [
      { mediaTime: 0, frameIndex: 0, captured: true },
      { mediaTime: 0.04, frameIndex: 1, captured: true }
    ]
    return verifyClipFrames(9, 'clip.webm', table, drawnAt).then(() => {
      expect(markVideoFramesUnusable).not.toHaveBeenCalled()
      const saved = saveVideoFrames.mock.calls[0][1] as StoredFrame[]
      expect(saved[0].misaligned).toBeFalsy()
      expect(saved.some((f) => f.misaligned)).toBe(true)
      // 表として成立している以上、枚数は画面へ返す（「情報が無い」にしない）。
      expect(verifiedPayload()?.total).toBe(saved.length)
    })
  })

  // **段差が出ただけでは印を立てない。** 供給時刻とファイル PTS の段差は、原点に置いた
  // 1 枚がずれているだけでも出る。実測（image 307）はファイル先頭の 2 枚が 1ms 差で入って
  // おり、303 行のうち 301 行が誤って赤くなっていた——対応は末尾まで崩れていなかった。
  it('先頭の 1 枚がずれているだけなら、印を立てない', async () => {
    // ファイル: 先頭 2 枚が 1ms 差、以降は供給 20ms 刻み。
    const pts = Array.from({ length: 24 }, (_, i) => (i === 0 ? 0 : 0.001 + (i - 1) * 0.02))
    signatures.pts = pts
    signatures.value = pts.map(() => flat(10))
    // 供給は 20ms 等間隔。枚数がファイルと合わないので対応検査が走る。
    const drawnAt = Array.from({ length: 25 }, (_, i) => 1000 + i * 20)
    // 表は素材 43ms 刻み。行が指すファイル内フレームは末尾まで正しい。
    const table: StoredFrame[] = Array.from({ length: 10 }, (_, k) => ({
      mediaTime: k * 0.043, frameIndex: 1 + Math.round((k * 43) / 20), captured: true
    }))

    await verifyClipFrames(307, 'clip.webm', table, drawnAt)

    expect(markVideoFramesUnusable).not.toHaveBeenCalled()
    const saved = saveVideoFrames.mock.calls.at(-1)?.[1] as StoredFrame[]
    expect(saved).toHaveLength(10)
    expect(saved.some((f) => f.misaligned)).toBe(false)
    expect(verifiedPayload()).toMatchObject({ id: 307, misaligned: 0, total: 10 })
  })

  // 逆に、ずれが末尾まで溜まっているものには従来どおり印を立てる。
  // **こちらを緩めると、別のコマの絵を正しい絵として黙って出し続けることになる。**
  it('ずれが末尾まで溜まっていれば、その位置から先に印を立てる', async () => {
    // ファイル: 供給 20ms 刻みだが、10 枚目のところで 3 枚落ちている。
    const LOST_AT = 10, LOST = 3
    const pts = Array.from({ length: 24 }, (_, i) => (i < LOST_AT ? i : i + LOST) * 0.02)
    signatures.pts = pts
    signatures.value = pts.map(() => flat(10))
    const drawnAt = Array.from({ length: 27 }, (_, i) => 1000 + i * 20)
    const table: StoredFrame[] = Array.from({ length: 10 }, (_, k) => ({
      mediaTime: k * 0.043, frameIndex: Math.round((k * 43) / 20), captured: true
    }))

    await verifyClipFrames(12, 'clip.webm', table, drawnAt)

    expect(markVideoFramesUnusable).not.toHaveBeenCalled()
    const saved = saveVideoFrames.mock.calls.at(-1)?.[1] as StoredFrame[]
    expect(saved.slice(0, 5).some((f) => f.misaligned)).toBe(false)
    expect(saved.slice(5).every((f) => f.misaligned)).toBe(true)
    expect(verifiedPayload()).toMatchObject({ id: 12, misaligned: 5, total: 10 })
  })

  it('1 行も使えるところが無ければ、そのときだけ表として使わない', () => {
    // 対応が崩れたうえ、残った行がすべてファイルの範囲外を指しているケース。
    signatures.value = [flat(10)]
    signatures.pts = [0, 0.04, 0.08, 0.12]
    const drawnAt = [1000, 1040, 1200, 1240]
    const table: StoredFrame[] = [{ mediaTime: 0, frameIndex: 3, captured: true }]
    return verifyClipFrames(11, 'clip.webm', table, drawnAt).then(() => {
      expect(markVideoFramesUnusable).toHaveBeenCalledWith(11, 'correspondence-break')
      expect(verifiedPayload()).toEqual({ id: 11, uncaptured: null, ambiguous: null, total: null, unreported: null, misaligned: null, unreportedMeasured: false })
    })
  })
})
