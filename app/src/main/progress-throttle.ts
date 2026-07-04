// 大量件数の進捗 IPC（export/thumbgen/retag）を間引くための共通ヘルパー。
// 1件ごとに sendToRenderer すると数千件規模で IPC 洪水になるため、前回送信から
// 25ms 以上経過したか、パーセント表示が変わったときだけ送る。最終件は必ず true を返す。
export function createProgressThrottle(total: number, intervalMs = 25): (current: number) => boolean {
  let lastSentAt = 0
  let lastPercent = -1
  return (current: number): boolean => {
    if (current >= total) return true
    const now = Date.now()
    const percent = total > 0 ? Math.floor((current / total) * 100) : 0
    if (percent !== lastPercent || now - lastSentAt >= intervalMs) {
      lastSentAt = now
      lastPercent = percent
      return true
    }
    return false
  }
}
