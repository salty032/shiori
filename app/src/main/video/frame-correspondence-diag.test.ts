import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/userData') } }))
import {
  diagnoseCorrespondence, locateLostFrames, writeCorrespondenceDiagnostic, type DiagContext
} from './frame-correspondence-diag'

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

// 供給の間隔は実録画と同じく毎回揺れる（13〜27ms）。ファイルの時刻は WebM と同じく 1ms 刻み。
function unevenSupply(count: number): number[] {
  let seed = 12345
  let t = 1_700_000_000_000
  return Array.from({ length: count }, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    t += 13 + (seed % 1400) / 100
    return t
  })
}
// 供給のうち keep に残った分だけがファイルに入ったとして、ファイル側の時刻（秒・先頭が 0）を作る。
function fileOf(supply: number[], lostAt: number[]): number[] {
  const kept = supply.filter((_, i) => !lostAt.includes(i))
  return kept.map((t) => Math.round(t - kept[0]) / 1000)
}

describe('locateLostFrames（どこで何枚落ちたかを間隔から出す）', () => {
  const supply = unevenSupply(300)

  it('先頭・途中・末尾の欠落を、枚数と位置まで分ける', () => {
    // 先頭 3 枚、供給の 60 枚目、150〜151 枚目、末尾 2 枚が落ちた録画。
    const lost = locateLostFrames(supply, fileOf(supply, [0, 1, 2, 60, 150, 151, 298, 299]))
    expect(lost).toMatchObject({
      head: 3, tail: 2,
      // ファイル側の添字：60 − 先頭 3 ＝ 57、150 − 先頭 3 − 途中 1 ＝ 146
      interior: [{ before: 57, count: 1 }, { before: 146, count: 2 }]
    })
    expect(lost!.meanErrorMs).toBeLessThan(1)
    expect(lost!.tailOnlyMeanErrorMs).toBeGreaterThan(lost!.meanErrorMs * 3)
  })

  // 累積のずれ（段差）を見る方法では、これが「80 枚目で 1 枚落ちた」と区別できなかった
  // （上の 'records the unresolved timestamp-only counterexample'）。間隔の並びは末尾まで
  // ずれずに合っているので、途中の欠落にはしない。
  it('時刻だけが途中からずれた録画の末尾欠落を、途中の欠落と取り違えない', () => {
    const file = fileOf(supply, [299]).map((t, i) => (i >= 80 ? t + 0.02 : t))
    expect(locateLostFrames(supply, file)).toMatchObject({ head: 0, tail: 1, interior: [] })
  })

  it('供給が等間隔で区別できないときは末尾に寄せ、区別できていないことが数字から読める', () => {
    const lost = locateLostFrames(drawn, pts.slice(0, -2))
    expect(lost).toMatchObject({ head: 0, tail: 2, interior: [] })
    expect(lost!.meanErrorMs).toBe(lost!.tailOnlyMeanErrorMs)
  })

  it('足りなくない録画・壊れた時刻・足りなすぎる録画は調べない', () => {
    expect(locateLostFrames(drawn, pts)).toBeNull()
    expect(locateLostFrames(drawn.slice(0, -1), pts)).toBeNull()
    expect(locateLostFrames([0, NaN, 40, 60], [0, 0.02, 0.04])).toBeNull()
    expect(locateLostFrames(unevenSupply(400), pts.slice(0, 200))).toBeNull()
  })

  it('渡した配列を書き換えない', () => {
    const frozenSupply = Object.freeze(supply.slice())
    const frozenFile = Object.freeze(fileOf(supply, [10]))
    expect(() => locateLostFrames(frozenSupply, frozenFile)).not.toThrow()
  })
})

describe('録画したときの状況を残す', () => {
  const context: DiagContext = {
    appVersion: '9.9.9', extensionVersion: '9.9.8', lowMemoryMode: true, sessionId: 3, durationSec: 6,
    sourceFps: 23.976, captureFps: 60, displayHz: 60, host: 'localhost',
    capture: {
      callbacks: 0, presented: 0, skippedByCallback: 0, duplicateSuppressed: 0,
      captureTimeMissing: null, clockSkewMs: null, totalVideoFrames: null, droppedVideoFrames: null,
      tickerTicks: null, videoBitsPerSecond: null, bitrateSourceFps: null,
      streamWidth: null, streamHeight: null, cropWidth: null, cropHeight: null,
      // 記録が実際に始まったのは、供給 3 枚目と 4 枚目のあいだ。
      recStartCalledAt: drawn[0] - 5, sinkOpenedAt: drawn[0] - 4, recStartedAt: drawn[3] - 1, firstChunkAt: drawn[8] - 1,
      supplyStoppedAt: null, recStopCalledAt: null, recStoppedAt: null,
      chunkCount: 60, priorPrepares: 0, mimeType: 'video/webm;codecs=vp9,opus'
    },
    startDoubts: { notSettled: false, armingUnconfirmed: false }
  }

  it('版・状況・録画ファイルの場所・記録が始まる前に数えた枚数がファイルに入る', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shiori-correspondence-'))
    dirs.push(dir)
    vi.stubEnv('SHIORI_FRAME_DIAGNOSTICS_DIR', dir)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeCorrespondenceDiagnostic(7, drawn, pts.slice(0, -1), [], [], 'C:/clips/a.webm', context)
    const data = JSON.parse(await readFile(join(dir, (await readdir(dir))[0]), 'utf8'))
    expect(data).toMatchObject({
      schemaVersion: 1, videoPath: 'C:/clips/a.webm',
      context: { appVersion: '9.9.9', extensionVersion: '9.9.8', lowMemoryMode: true, capture: { priorPrepares: 0 } },
      countedBefore: { recStartCalled: 0, sinkOpened: 0, recStarted: 3, firstChunk: 8 },
      lost: { tail: 1 }
    })
    // 枚数が合わなかったことは 1 行で読める。
    expect(warn.mock.calls.flat().join(' ')).toMatch(/\[frame-loss\] image 7: supplied 200, file has 199.*start event 3, first data 8/)
  })

  // 目印（diag-log.on）の無い PC では、枚数が合わなくてもファイルは書かない。1 行だけ残す。
  it('書き出し先が無くても、枚数が合わなかったことは 1 行残す', async () => {
    vi.stubEnv('SHIORI_FRAME_DIAGNOSTICS_DIR', '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await writeCorrespondenceDiagnostic(8, drawn, pts.slice(0, -1), [])
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0][0])).toContain('[frame-loss] image 8')
    expect(log).not.toHaveBeenCalled()
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
