// 起動失敗ダイアログに載せる 1 行を作る。
//
// 例外のメッセージは数千文字になることがあり（SQL 全文やパスの列挙など）、そのまま
// showErrorBox へ渡すとボタンが画面外へ出て閉じられなくなる。読み手が使うのは最初の
// 1 行だけなので、1 行目を 300 文字で切って渡す。スタックは console 側に残す。
export const STARTUP_ERROR_DETAIL_MAX = 300

export function describeStartupError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const firstLine = raw.split('\n')[0].trim()
  // 空文字のまま出すと、ダイアログに理由の行が消えて「何かに失敗した」だけが残る。
  if (!firstLine) return 'unknown error'
  return firstLine.length > STARTUP_ERROR_DETAIL_MAX
    ? `${firstLine.slice(0, STARTUP_ERROR_DETAIL_MAX)}...`
    : firstLine
}
