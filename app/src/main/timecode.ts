// 拡張機能から届く「直近の再生対象（タイトル・再生時刻・URL）」を保持する共有状態。
// 録画開始・タイムコード受信・キャプチャパイプラインの3者が読み書きするため、
// 単一モジュールにアクセサ経由で封じ込める。
export interface Timecode {
  title: string
  currentTime: number | null
  url: string | null
}

let lastTimecode: Timecode | null = null
let lastTimecodeAt = 0
let lastFocusedTimecodeAt = 0

export function getLastTimecode(): Timecode | null {
  return lastTimecode
}

export function getLastTimecodeAt(): number {
  return lastTimecodeAt
}

// 直近タイムコードを更新し、受信時刻を現在時刻で打刻する。
export function setLastTimecode(tc: Timecode): void {
  lastTimecode = tc
  lastTimecodeAt = Date.now()
}

export function getLastFocusedTimecodeAt(): number {
  return lastFocusedTimecodeAt
}

// フォーカス中タブからのタイムコードを受信した時刻を打刻する。
export function markFocusedTimecodeNow(): void {
  lastFocusedTimecodeAt = Date.now()
}
