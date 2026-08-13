// バージョン文字列の比較。extension-updater（拡張のバンドル版とインストール済み版）と
// updater（pending に残ったインストーラと実行中のアプリ）の両方から使う。
export function compareVersions(a: string, b: string): number {
  // "0.4.0-beta" のような非数値セグメントは Number() で NaN になり、NaN の引き算が
  // 常に false 側（更新なし判定）に倒れる。NaN は 0 扱いにフォールバックする。
  const toParts = (v: string): number[] => v.split('.').map((seg) => {
    const n = Number(seg)
    return Number.isFinite(n) ? n : 0
  })
  const pa = toParts(a)
  const pb = toParts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
