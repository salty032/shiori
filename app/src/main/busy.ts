// 中断されると困る長時間タスクの実行状況を集約する。各タスクのフラグは元々
// ipc-share / ipc-images / ipc-tagger / ipc-import に散らばっていて、
// 「今なにか走っているか」を横断で知る手段がなかった。アップデート適用（プロセス終了）
// の前にユーザーへ確認するにはその横断ビューが要るため、ここに集める。
//
// 各モジュールの既存フラグ（isShareImporting など）は二重起動防止用にそのまま残す。
// こちらは「終了してよいか」を判断するためだけの登録簿。
export type BusyTask = 'import' | 'export' | 'retag' | 'model-download' | 'thumb-repair'

const LABELS: Record<BusyTask, string> = {
  import: '取り込み',
  export: 'エクスポート',
  retag: 'AIタグ付け',
  'model-download': 'AIモデルのダウンロード',
  'thumb-repair': 'サムネイルの修復'
}

// 同種タスクが同時に走ることはない（各モジュールが単一フラグで排他している）が、
// 種別ごとの多重 begin/end に耐えるようカウンタで持つ。end 漏れで永久に busy に
// なるのが最悪ケースなので、呼び出し側は必ず finally で endTask すること。
const active = new Map<BusyTask, number>()

export function beginTask(task: BusyTask): void {
  active.set(task, (active.get(task) ?? 0) + 1)
}

export function endTask(task: BusyTask): void {
  const next = (active.get(task) ?? 0) - 1
  if (next > 0) active.set(task, next)
  else active.delete(task)
}

export function activeTaskLabels(): string[] {
  return [...active.keys()].map((task) => LABELS[task])
}

export function hasActiveTasks(): boolean {
  return active.size > 0
}

// テスト用。モジュール状態がテスト間で漏れないようにする。
export function resetTasksForTest(): void {
  active.clear()
}
