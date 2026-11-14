import { isAbsolute, relative, sep } from 'path'

// target が base の「中」（base 自身は含まない）にあるか。
//
// **アプリが開いてよい・消してよいファイルの境界を決める式。** 以前は paths.ts・move-captures.ts・
// ipc-drag.ts に同じ式が別々に書かれていて、どれか 1 つだけ直すとそこが穴になる形だった。
// ここだけに置き、3 か所ともこれを使う。electron に依存させない（move-captures.ts のテストが
// electron 無しで読み込むため）。
export function isChildPath(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
