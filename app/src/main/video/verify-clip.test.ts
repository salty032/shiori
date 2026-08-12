import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { StoredFrame } from '../db'

// 検証（verifyClipFrames）は保存の後にバックグラウンドで走り、「N コマ未取得」（未検証）を
// 「N コマ要確認」へ変える。一覧は保存時点のスナップショットなので、**確定した枚数を
// 画面へ飛ばさないと検証済みの行が未検証の表示のまま残る**（実測 2026-08-10: DB は
// ambiguous=64 なのに画面は 90コマ未取得 のままだった）。経路ごとに飛ぶことを固定する。

const signatures = { value: [] as Uint8Array[], pts: [] as number[] }
vi.mock('./ffmpeg', () => ({
  getFrameSignatures: () => Promise.resolve({ signatures: signatures.value, pts: signatures.pts })
}))

const sendToRenderer = vi.fn()
vi.mock('../windows', () => ({ sendToRenderer: (...args: unknown[]) => sendToRenderer(...args) }))

const dropVideoFrames = vi.fn()
vi.mock('../db', () => ({
  dropVideoFrames: (...args: unknown[]) => dropVideoFrames(...args),
  saveVideoFrames: vi.fn(),
  setAmbiguousFrames: vi.fn(),
  setFrameCounts: vi.fn()
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
    dropVideoFrames.mockClear()
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
      expect(verifiedPayload()).toEqual({ id: 7, uncaptured: 1, ambiguous: 1, total: 3, unreported: 0 })
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
      expect(verifiedPayload()).toEqual({ id: 8, uncaptured: 0, ambiguous: null, total: 2, unreported: 0 })
    })
  })

  it('表を捨てたときは「コマ精度の情報が無い」状態を飛ばす', () => {
    // 供給時刻とファイル内 PTS の対応が途中から崩れ続ける＝表が使えないケース。
    signatures.value = [flat(10), flat(20), flat(30)]
    signatures.pts = [0, 0.04, 0.08]
    const drawnAt = [1000, 1020, 1040, 1060]
    const table: StoredFrame[] = [
      { mediaTime: 0, frameIndex: 0, captured: true },
      { mediaTime: 0.04, frameIndex: 1, captured: true }
    ]
    return verifyClipFrames(9, 'clip.webm', table, drawnAt).then(() => {
      expect(dropVideoFrames).toHaveBeenCalledWith(9)
      expect(verifiedPayload()).toEqual({ id: 9, uncaptured: null, ambiguous: null, total: null, unreported: null })
    })
  })
})
