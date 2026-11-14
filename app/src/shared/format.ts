// 容量の表示。設定画面（使用量）と、保存先を移すときの確認ダイアログ（main）が同じものを使う。
// **2 か所で別々に持たない**——同じ数字が画面ごとに違う丸め方で出ると、どちらかが間違って見える。
//
// 桁数を揃えるのではなく有効数字を揃える——12 GB / 210 MB / 8.4 GB のように、10 未満だけ
// 小数第1位まで出す。1000 未満で単位を上げるのは、999 MB の次が 1.0 GB になるより
// 0.98 GB のほうが読みにくいため。
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  // 10 以上は整数（12 GB）、10 未満は小数第1位（8.4 GB）。桁が増えるほど小数の情報量は減る。
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}
