import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/userData') } }))
import { diagnoseCorrespondence, writeCorrespondenceDiagnostic } from './frame-correspondence-diag'

const drawn = Array.from({ length: 200 }, (_, i) => i * 20)
const pts = drawn.map((t) => t / 1000)
const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('experimental correspondence hypotheses', () => {
  it('locates single and consecutive losses using local times', () => {
    for (const start of [5, 40, 120, 180]) {
      for (const missing of [1, 2, 3]) {
        const short = pts.slice()
        short.splice(start, missing)
        expect(diagnoseCorrespondence(drawn, short)).toMatchObject({
          status: 'candidate', missing, candidateStart: start, candidateEnd: start
        })
      }
    }
  })
  it('handles a long local supply interval without inferring two losses', () => {
    const uneven = drawn.map((t, i) => t + (i >= 121 ? 20 : 0))
    const short = uneven.map((t) => t / 1000)
    short.splice(120, 1)
    expect(diagnoseCorrespondence(uneven, short)).toMatchObject({
      status: 'candidate', missing: 1, candidateStart: 120, candidateEnd: 120
    })
  })
  it('does not treat tail-only loss or a temporary step as an interior candidate', () => {
    expect(diagnoseCorrespondence(drawn, pts.slice(0, -1)).status).toBe('inconclusive')
    for (const count of [2, 3, 5, 10]) {
      const shifted = pts.slice(0, -1)
      // Below one interval so returning to baseline stays strictly monotonic.
      for (let i = 50; i < 50 + count; i++) shifted[i] += 0.019
      expect(diagnoseCorrespondence(drawn, shifted).status).toBe('inconclusive')
    }
  })
  it('rejects the known startup/origin regression shapes', () => {
    const supply = drawn.map((t) => t * 19.1 / 20)
    const jitter = supply.slice(0, -1).map((t) => t / 1000)
    jitter[1] += .0096
    jitter[2] += .0131
    for (let i = 3; i < jitter.length; i++) jitter[i] -= .0029
    expect(diagnoseCorrespondence(supply, jitter).status).toBe('inconclusive')
    const origin = pts.slice(0, -1).map((t, i) => i === 0 ? t + .009 : t)
    expect(diagnoseCorrespondence(drawn, origin).status).toBe('inconclusive')
    const initialPair = pts.slice(0, -1).map((t, i) => i === 0 ? t : t - .019)
    expect(diagnoseCorrespondence(drawn, initialPair).status).toBe('inconclusive')
  })
  it('keeps startup and near-end losses inconclusive', () => {
    for (const start of [1, 2, 3, 4, 198]) {
      const short = pts.slice()
      short.splice(start, 1)
      expect(diagnoseCorrespondence(drawn, short).status).toBe('inconclusive')
    }
  })
  it('records the unresolved timestamp-only counterexample as a candidate, never proof', () => {
    const short = pts.slice(0, -1).map((t, i) => i >= 80 ? t + .020 : t)
    expect(diagnoseCorrespondence(drawn, short)).toMatchObject({ status: 'candidate', candidateStart: 80 })
  })
  it('rejects malformed clocks and does not modify inputs', () => {
    expect(diagnoseCorrespondence([0, 0, 20], [0, .02]).status).toBe('invalid')
    expect(diagnoseCorrespondence([0, NaN], [0]).status).toBe('invalid')
    expect(diagnoseCorrespondence(drawn, pts).status).toBe('not-short')
    expect(() => diagnoseCorrespondence(Object.freeze(drawn.slice()), Object.freeze(pts.slice(0, -1)))).not.toThrow()
  })
})

describe('opt-in evidence files', () => {
  it('writes raw clocks and the original table for every opted-in recording, including normal ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shiori-correspondence-'))
    dirs.push(dir)
    vi.stubEnv('SHIORI_FRAME_DIAGNOSTICS_DIR', dir)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const table = [{ mediaTime: 0, frameIndex: 0, captured: true }]
    await writeCorrespondenceDiagnostic(7, drawn, pts, table)
    await writeCorrespondenceDiagnostic(7, drawn, pts, table)
    const files = await readdir(dir)
    expect(files).toHaveLength(2)
    const data = JSON.parse(await readFile(join(dir, files[0]), 'utf8'))
    expect(data).toMatchObject({ schemaVersion: 1, imageId: 7, drawnAt: drawn, pts, table,
      diagnosis: { status: 'not-short' } })
    expect(table).toEqual([{ mediaTime: 0, frameIndex: 0, captured: true }])
  })
  it('is disabled by default and tolerates filesystem failure', async () => {
    vi.stubEnv('SHIORI_FRAME_DIAGNOSTICS_DIR', '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await writeCorrespondenceDiagnostic(1, drawn, pts, [])
    expect(log).not.toHaveBeenCalled()
    const dir = await mkdtemp(join(tmpdir(), 'shiori-correspondence-'))
    dirs.push(dir)
    const file = join(dir, 'not-a-directory')
    await writeFile(file, 'test')
    vi.stubEnv('SHIORI_FRAME_DIAGNOSTICS_DIR', file)
    await expect(writeCorrespondenceDiagnostic(1, drawn, pts, [])).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })
})
