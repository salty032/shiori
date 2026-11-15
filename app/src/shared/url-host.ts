// URL からホスト名を取る（先頭の www. は外す）。読めない URL は null。
// DB の host 列（絞り込みに使う）と画面のサービス名が同じ式で出ないと、同じ素材が別のホストに見える。
export function urlHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}
