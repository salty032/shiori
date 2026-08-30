import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { planCaptureMove, moveCaptureFiles } from './move-captures'

const made: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shiori-move-'))
  made.push(dir)
  return dir
}
afterEach(async () => {
  while (made.length) await rm(made.pop()!, { recursive: true, force: true })
})

describe('planCaptureMove', () => {
  const OLD = resolve('/old/captures')
  const NEW = resolve('/new/captures')

  it('年月サブフォルダの形をそのまま保つ', () => {
    const rows = [{ id: 1, filepath: join(OLD, '2026-08', 'cap_1.png') }]
    expect(planCaptureMove(rows, [OLD], NEW)).toEqual([
      { id: 1, from: join(OLD, '2026-08', 'cap_1.png'), to: join(NEW, '2026-08', 'cap_1.png') },
    ])
  })

  it('昔のフラット置きも、そのままの位置で移す', () => {
    const rows = [{ id: 1, filepath: join(OLD, 'cap_1.png') }]
    expect(planCaptureMove(rows, [OLD], NEW)[0].to).toBe(join(NEW, 'cap_1.png'))
  })

  it('既に新しい場所にあるものは対象にしない', () => {
    const rows = [{ id: 1, filepath: join(NEW, '2026-08', 'cap_1.png') }]
    expect(planCaptureMove(rows, [OLD, NEW], NEW)).toEqual([])
  })

  // 保存先の外にあるファイルは、こちらの管理下でない可能性がある。触らない。
  it('どの保存先の下にも無いファイルは触らない', () => {
    const rows = [{ id: 1, filepath: resolve('/elsewhere/cap_1.png') }]
    expect(planCaptureMove(rows, [OLD], NEW)).toEqual([])
  })

  it('過去に使った保存先のぶんも集める', () => {
    const older = resolve('/older/captures')
    const rows = [
      { id: 1, filepath: join(OLD, 'cap_1.png') },
      { id: 2, filepath: join(older, 'cap_2.png') },
    ]
    expect(planCaptureMove(rows, [OLD, older], NEW).map((t) => t.id)).toEqual([1, 2])
  })
})

describe('moveCaptureFiles', () => {
  it('全部コピーし終えてから記録を書き換え、元を消す', async () => {
    const from = await tempDir()
    const to = await tempDir()
    await mkdir(join(from, '2026-08'), { recursive: true })
    await writeFile(join(from, '2026-08', 'cap_1.png'), 'x')
    let committed: readonly { id: number; to: string }[] = []

    const result = await moveCaptureFiles({
      targets: [{ id: 1, from: join(from, '2026-08', 'cap_1.png'), to: join(to, '2026-08', 'cap_1.png') }],
      commit: (moved) => { committed = moved.map((m) => ({ id: m.id, to: m.to })) },
    })

    expect(result).toEqual({ ok: true, moved: 1, missing: 0 })
    expect(committed).toEqual([{ id: 1, to: join(to, '2026-08', 'cap_1.png') }])
    expect(await readFile(join(to, '2026-08', 'cap_1.png'), 'utf8')).toBe('x')
    await expect(stat(join(from, '2026-08', 'cap_1.png'))).rejects.toThrow()
  })

  // ここが全部か無かの肝。1 件でも駄目なら、コピー済みを消して記録に触らずに戻る。
  it('コピーに失敗したら、コピー済みを消して記録を触らない', async () => {
    const from = await tempDir()
    const to = await tempDir()
    await writeFile(join(from, 'a.png'), 'a')
    await writeFile(join(from, 'b.png'), 'b')
    let commitCalled = false

    const result = await moveCaptureFiles({
      targets: [
        { id: 1, from: join(from, 'a.png'), to: join(to, 'a.png') },
        // ディレクトリを書き込み先に指定して copyFile を失敗させる
        { id: 2, from: join(from, 'b.png'), to: to },
      ],
      commit: () => { commitCalled = true },
    })

    expect(result.ok).toBe(false)
    expect(commitCalled).toBe(false)
    // コピー済みの 1 件目は消えている（何も起きなかった状態に戻る）
    await expect(stat(join(to, 'a.png'))).rejects.toThrow()
    // 元はどちらも残っている
    expect(await readFile(join(from, 'a.png'), 'utf8')).toBe('a')
    expect(await readFile(join(from, 'b.png'), 'utf8')).toBe('b')
  })

  it('中止しても、コピー済みを消して記録を触らない', async () => {
    const from = await tempDir()
    const to = await tempDir()
    await writeFile(join(from, 'a.png'), 'a')
    await writeFile(join(from, 'b.png'), 'b')
    let commitCalled = false
    let done = 0

    const result = await moveCaptureFiles({
      targets: [
        { id: 1, from: join(from, 'a.png'), to: join(to, 'a.png') },
        { id: 2, from: join(from, 'b.png'), to: join(to, 'b.png') },
      ],
      commit: () => { commitCalled = true },
      onProgress: () => { done++ },
      isCanceled: () => done >= 1,
    })

    expect(result).toEqual({ ok: false, reason: 'canceled' })
    expect(commitCalled).toBe(false)
    await expect(stat(join(to, 'a.png'))).rejects.toThrow()
    expect(await readFile(join(from, 'a.png'), 'utf8')).toBe('a')
  })

  // アプリの外で消されたファイル。移動より前から開けない行なので、これで全体は止めない。
  it('元が既に無い行は飛ばし、残りは移す', async () => {
    const from = await tempDir()
    const to = await tempDir()
    await writeFile(join(from, 'b.png'), 'b')
    let committed: number[] = []

    const result = await moveCaptureFiles({
      targets: [
        { id: 1, from: join(from, 'gone.png'), to: join(to, 'gone.png') },
        { id: 2, from: join(from, 'b.png'), to: join(to, 'b.png') },
      ],
      commit: (moved) => { committed = moved.map((m) => m.id) },
    })

    expect(result).toEqual({ ok: true, moved: 1, missing: 1 })
    expect(committed).toEqual([2])
  })
})
