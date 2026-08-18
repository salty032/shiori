// モデルのダウンロード中に、書き込み先で障害が起きたときの経路。
//
// WriteStream の 'error' はリスナーが 1 つも無いと Node が未処理例外へ格上げし、
// **メインプロセスごと落とす**（ダウンロード失敗として返すべきものがアプリの突然終了になる）。
// 旧実装は write() が false を返した drain 待ちの間しかリスナーを張っていなかったため、
// 通常経路（write() が true）でのディスクフルがそのまま落ちる形だった。model.onnx は
// 600MB あるので ENOSPC は現実に起きる。
//
// 既存の tagger.test.ts は 'fs' をモックしていない（ハッシュ計算に実物の createReadStream を
// 使う）ため、書き込み経路だけこのファイルに分けている。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

class FakeWriteStream extends EventEmitter {
  ended = false
  chunks = 0
  // write() が返す値。false にすると呼び出し側は drain 待ちに入る。
  writeReturns = true
  // write() の中で起こす障害。ディスクフル・権限変更・I/O 障害の代わり。
  failOnChunk: number | null = null
  // write() の瞬間に 'error' の待ち受けが何本あったか。0 が混ざる＝アプリが落ちうる。
  errorListenersAtWrite: number[] = []
  // drain 待ちで落ちる場合に 'drain' を出さない（実物と同じく二度と進まない）。
  failed = false

  write(chunk: Uint8Array): boolean {
    this.chunks++
    this.errorListenersAtWrite.push(this.listenerCount('error'))
    if (this.failOnChunk === this.chunks) {
      this.failed = true
      queueMicrotask(() => this.emit('error', new Error('ENOSPC: no space left on device')))
      return this.writeReturns
    }
    if (!this.writeReturns) queueMicrotask(() => this.emit('drain'))
    void chunk
    return this.writeReturns
  }

  end(): void {
    this.ended = true
    if (!this.failed) queueMicrotask(() => this.emit('finish'))
  }
}

let lastStream: FakeWriteStream | null = null
let nextStreamSetup: ((s: FakeWriteStream) => void) | null = null

const { fakeNet } = vi.hoisted(() => ({ fakeNet: { fetch: vi.fn() } }))

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/mock') },
  nativeImage: { createFromPath: vi.fn() },
  net: fakeNet,
}))

vi.mock('fs', () => ({
  createWriteStream: vi.fn(() => {
    const s = new FakeWriteStream()
    nextStreamSetup?.(s)
    lastStream = s
    return s
  }),
  createReadStream: vi.fn(() => {
    const s = new EventEmitter()
    queueMicrotask(() => { s.emit('data', Buffer.from('x')); s.emit('end') })
    return s
  }),
}))

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(''),
  // ダウンロード済みファイルは無い＝必ず取得しに行く。
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
  unlink: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}))

import { unlink } from 'fs/promises'
import { ensureModel, _resetTaggerStateForTest, _modelFilePathsForTest } from './tagger'

// content-length を返さない応答にして「受信量と一致するか」の検査を回避する
// （ここで見たいのは書き込み側の障害だけ）。
function respondWith(chunkCount: number): void {
  fakeNet.fetch.mockImplementation(async () => {
    let remaining = chunkCount
    return {
      ok: true,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => (remaining-- > 0
            ? { done: false, value: new Uint8Array(1024) }
            : { done: true, value: undefined }),
          cancel: () => {},
        })
      }
    }
  })
}

describe('モデルのダウンロード: 書き込み先の障害', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lastStream = null
    nextStreamSetup = null
    // ortModule を差し込んで require('onnxruntime-node') を踏ませない。
    _resetTaggerStateForTest({ ortModule: { InferenceSession: { create: vi.fn() } } })
  })

  it('write() が true を返す通常経路でも error の待ち受けを外さない', async () => {
    respondWith(3)
    await ensureModel().catch(() => {})

    expect(lastStream).not.toBeNull()
    expect(lastStream!.chunks).toBeGreaterThan(0)
    // 1 回でも 0 があれば、そのタイミングの障害はアプリの突然終了になる。
    expect(lastStream!.errorListenersAtWrite).not.toContain(0)
  })

  it('書き込みが失敗したらアプリを落とさずダウンロード失敗として返す', async () => {
    respondWith(3)
    nextStreamSetup = (s) => { s.failOnChunk = 2 }

    await expect(ensureModel()).rejects.toThrow(/ENOSPC/)
    // 書きかけの .tmp を残さない。
    const { tags } = _modelFilePathsForTest()
    expect(vi.mocked(unlink)).toHaveBeenCalledWith(`${tags}.tmp`)
  })

  it('drain 待ちの最中に失敗しても、そこで止まらず失敗として返す', async () => {
    respondWith(3)
    nextStreamSetup = (s) => { s.writeReturns = false; s.failOnChunk = 2 }

    // 'drain' が二度と来ない状況。待ち合わせが reject されないとここで固着する。
    await expect(ensureModel()).rejects.toThrow(/ENOSPC/)
  })

  it('チャンクごとにリスナーを積み増さない（600MB の DL で警告が出る）', async () => {
    respondWith(50)
    nextStreamSetup = (s) => { s.writeReturns = false }
    await ensureModel().catch(() => {})

    expect(lastStream!.chunks).toBe(50)
    expect(lastStream!.listenerCount('error')).toBeLessThanOrEqual(2)
    expect(lastStream!.listenerCount('drain')).toBeLessThanOrEqual(2)
    // 最後まで書き切って end() まで到達している（この後ハッシュ照合で落ちるのは想定どおり。
    // 期待値は実物のファイルの値でピン留めされているため、テストの偽データでは必ず外れる）。
    expect(lastStream!.ended).toBe(true)
  })
})
