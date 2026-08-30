// 保存先を変えたときに、これまでに撮ったものを新しい場所へ移す。
//
// **全部移すか、何もしないか、のどちらかにする。** 半分だけ移った状態は、ファイルが
// 2 か所に散り、どちらに何があるのかを人が把握しなければならなくなる。開けはするが、
// 後始末が面倒なだけで誰の得にもならない。
//
// そのための順番が「全部コピー → 記録をまとめて 1 回で書き換え → 元を消す」。
//
//   コピー中に中止・失敗 … コピーした先を消して終わり。記録も保存先も変わらない
//   記録の書き換え      … SQLite の 1 トランザクション。途中で落ちれば丸ごと巻き戻る
//   元を消している最中  … 古い場所にファイルが残るだけ。記録は新しい場所を指しており、
//                          開くぶんには困らない（残骸は掃除で消せる）
//
// 代償は、移動中だけ移動先に 2 倍の空きが要ること。空けたい側ではなく移す先の話なので、
// 目的（元のドライブを空ける）とは衝突しない。
//
// **移すのは記録にあるファイルだけ。** フォルダの中身を舐めると、その人が前から置いていた
// 無関係なファイルまで巻き込む。サムネイルは移さない——userData に別で置いてあり、
// 消えても作り直せるうえ、容量も原本に比べれば些細。
import { copyFile, mkdir, stat, unlink } from 'fs/promises'
import { dirname, relative, resolve, isAbsolute, sep } from 'path'

export type MoveTarget = { id: number; from: string; to: string }

export type MoveOutcome =
  // moved は記録を書き換えた件数。missing は元のファイルが既に無かった件数
  // （アプリの外で消されたもの。移動より前から開けない行なので、これで中止はしない）。
  | { ok: true; moved: number; missing: number }
  | { ok: false; reason: 'canceled' | 'failed'; failedPath?: string }

function isUnder(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

// どのファイルをどこへ移すかを決める。**新しい場所からの相対の形は元のまま保つ**——
// 年月のサブフォルダも、昔のフラット置きのファイルも、そのままの並びで移る。
//
// 既に新しい場所にあるものは対象から外す。roots はいま許可している保存先の一覧
// （既定の場所・過去に使った場所）で、そのどれの下にも無いファイルは触らない
// ——取り込み元がライブラリの外にある等、こちらの管理下でない可能性があるため。
export function planCaptureMove(
  rows: readonly { id: number; filepath: string }[],
  roots: readonly string[],
  newRoot: string
): MoveTarget[] {
  const dest = resolve(newRoot)
  const bases = roots.map((root) => resolve(root)).filter((root) => root !== dest)
  const targets: MoveTarget[] = []
  for (const row of rows) {
    if (!row.filepath) continue
    const from = resolve(row.filepath)
    if (isUnder(dest, from)) continue
    const base = bases.find((root) => isUnder(root, from))
    if (!base) continue
    targets.push({ id: row.id, from, to: resolve(dest, relative(base, from)) })
  }
  return targets
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    /* 消せなくても続ける。残骸は開くのに影響しない */
  }
}

export async function moveCaptureFiles(params: {
  targets: readonly MoveTarget[]
  // コピーが全部終わってから 1 回だけ呼ばれる。記録の書き換えをまとめて行う口。
  commit: (moved: readonly MoveTarget[]) => void
  onProgress?: (done: number, total: number) => void
  isCanceled?: () => boolean
}): Promise<MoveOutcome> {
  const copied: MoveTarget[] = []
  let missing = 0

  // ── 第 1 段：全部コピーする。ここまでは何も確定していない ──
  for (let i = 0; i < params.targets.length; i++) {
    if (params.isCanceled?.()) {
      for (const target of copied) await removeQuietly(target.to)
      return { ok: false, reason: 'canceled' }
    }
    const target = params.targets[i]
    // 元が既に無い行は飛ばす。**これで全体を止めない**——アプリの外で消されたもので、
    // 移動より前から開けない行だから、移動の成否とは関係がない。
    if (!(await exists(target.from))) {
      missing++
      params.onProgress?.(i + 1, params.targets.length)
      continue
    }
    try {
      await mkdir(dirname(target.to), { recursive: true })
      await copyFile(target.from, target.to)
      copied.push(target)
    } catch (err) {
      // 容量不足・権限・ドライブ切断。**1 件でも駄目なら全部やめる。**
      // コピーした先を消して、記録も保存先も触らずに戻る。
      console.warn('[move] copy failed, rolling back', target.from, err)
      for (const done of copied) await removeQuietly(done.to)
      return { ok: false, reason: 'failed', failedPath: target.from }
    }
    params.onProgress?.(i + 1, params.targets.length)
  }

  // ── 第 2 段：記録をまとめて書き換える。ここで初めて確定する ──
  params.commit(copied)

  // ── 第 3 段：元を消す。**失敗しても移動は成立している** ──
  // 記録は新しい場所を指しているので、消し残しは開くのに影響しない残骸にすぎない。
  for (const target of copied) await removeQuietly(target.from)

  return { ok: true, moved: copied.length, missing }
}
