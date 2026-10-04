// Experimental evidence collection only. No frame table, DB or UI mutations.
import { mkdir, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'
import { findFrameDivergence } from './frame-verify'
import type { StoredFrame } from '../db/db-video-frames'

export const CORRESPONDENCE_DIAG_VERSION = 1
// Experimental bounds, not a measured guarantee of timestamp accuracy.
const TOLERANCE_MS = 10
const MIN_SIDE_FRAMES = 5

export interface CorrespondenceDiagnosis {
  version: number
  toleranceMs: number
  missing: number
  divergenceAt: number | null
  status: 'invalid' | 'not-short' | 'inconclusive' | 'candidate'
  // Inclusive bounds in the original supply sequence. All hypotheses delete
  // `missing` consecutive frames. Multiple separate losses are not modeled.
  candidateStart: number | null
  candidateEnd: number | null
  bestMaxResidualMs: number | null
}

/** Enumerate a single missing burst; never infer its size from average spacing. */
// toleranceMs is a parameter so recorded clocks can be re-scored offline
// (scripts/evaluate-frame-diagnostics.cjs) before any bound is adopted.
export function diagnoseCorrespondence(
  drawnAt: readonly number[], pts: readonly number[], toleranceMs = TOLERANCE_MS
): CorrespondenceDiagnosis {
  const missing = drawnAt.length - pts.length
  const out: CorrespondenceDiagnosis = {
    version: CORRESPONDENCE_DIAG_VERSION, toleranceMs, missing,
    divergenceAt: null, status: 'inconclusive', candidateStart: null,
    candidateEnd: null, bestMaxResidualMs: null
  }
  const increasing = (values: readonly number[]): boolean => values.every((v, i) =>
    Number.isFinite(v) && (i === 0 || v > values[i - 1]))
  if (!drawnAt.length || !pts.length || !increasing(drawnAt) || !increasing(pts)) {
    return { ...out, status: 'invalid' }
  }
  const divergence = findFrameDivergence([...drawnAt], [...pts])
  out.divergenceAt = divergence < Math.min(drawnAt.length, pts.length) ? divergence : null
  if (missing <= 0) return { ...out, status: 'not-short' }
  if (pts.length < MIN_SIDE_FRAMES * 2) return out

  const residual = (fileIndex: number, supplyIndex: number): number =>
    drawnAt[supplyIndex] - drawnAt[0] - (pts[fileIndex] - pts[0]) * 1000
  const head = Array.from({ length: MIN_SIDE_FRAMES }, (_, i) => residual(i, i)).sort((a, b) => a - b)
  const origin = head[head.length >> 1]
  const prefixMax: number[] = []
  const suffixMax: number[] = []
  for (let i = 0; i < pts.length; i++) {
    prefixMax[i] = Math.max(i ? prefixMax[i - 1] : 0, Math.abs(residual(i, i) - origin))
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    suffixMax[i] = Math.max(i + 1 < pts.length ? suffixMax[i + 1] : 0, Math.abs(residual(i, i + missing) - origin))
  }
  // Both sides need evidence. Startup and end-of-file hypotheses remain
  // inconclusive; a small residual is not proof of the identity of the picture.
  let best = Infinity
  for (let start = MIN_SIDE_FRAMES; start <= pts.length - MIN_SIDE_FRAMES; start++) {
    const maxResidual = Math.max(prefixMax[start - 1], suffixMax[start])
    best = Math.min(best, maxResidual)
    if (maxResidual > toleranceMs) continue
    if (out.candidateStart === null) out.candidateStart = start
    out.candidateEnd = start
  }
  out.bestMaxResidualMs = Number.isFinite(best) ? best : null
  if (out.divergenceAt !== null && out.candidateStart !== null) out.status = 'candidate'
  return out
}

/** Explicit opt-in; failures must not interrupt the existing verification. */
export async function writeCorrespondenceDiagnostic(
  imageId: number, drawnAt: readonly number[], pts: readonly number[], table: readonly StoredFrame[]
): Promise<void> {
  const configuredDir = process.env['SHIORI_FRAME_DIAGNOSTICS_DIR']
  if (!configuredDir) return
  try {
    const diagnosis = diagnoseCorrespondence(drawnAt, pts)
    const dir = resolve(configuredDir)
    await mkdir(dir, { recursive: true })
    const file = join(dir, `frame-${imageId}-${Date.now()}-${randomUUID()}.json`)
    await writeFile(file, JSON.stringify({
      schemaVersion: 1, createdAt: new Date().toISOString(), imageId,
      units: { drawnAt: 'epoch-ms', pts: 'seconds' },
      drawnAt, pts, table, diagnosis
    }), { encoding: 'utf8', flag: 'wx' })
    console.log(`[frame-correspondence-diag] image ${imageId}: ${JSON.stringify(diagnosis)}; ${file}`)
  } catch (err) {
    console.warn(`[frame-correspondence-diag] image ${imageId}: diagnostic failed`, err)
  }
}
