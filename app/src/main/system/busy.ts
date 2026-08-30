// 中断されると困る長時間タスクの実行状況を集約する。各タスクのフラグは元々
// ipc-share / ipc-images / ipc-tagger / ipc-import に散らばっていて、
// 「今なにか走っているか」を横断で知る手段がなかった。アップデート適用（プロセス終了）
// の前にユーザーへ確認するにはその横断ビューが要るため、ここに集める。
//
// 各モジュールの既存フラグ（isShareImporting など）は二重起動防止用にそのまま残す。
// こちらは「終了してよいか」を判断するためだけの登録簿。
import { t } from './i18n'
import type { MessageKey } from '../../shared/i18n'

// 'import' はドロップ・クリップボードからの取り込み、'library-import' はライブラリ
// 丸ごとの受け渡し。**別の名前で出す**——画面ではこの 2 つを「取り込み」と「インポート」
// で呼び分けているので、更新ダイアログでどちらも「取り込み」と出ると、走っている作業と
// 押したボタンの名前が食い違う。
type BusyTask = 'import' | 'library-import' | 'export' | 'retag' | 'model-download' | 'thumb-repair' | 'capture-move'

// 表示直前に翻訳する必要があるため、ここでは辞書キーだけを持つ。
const LABEL_KEYS: Record<BusyTask, MessageKey> = {
  import: 'busy.import',
  'library-import': 'busy.libraryImport',
  export: 'busy.export',
  retag: 'busy.retag',
  'model-download': 'busy.modelDownload',
  'thumb-repair': 'busy.thumbRepair',
  'capture-move': 'busy.captureMove'
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
  return [...active.keys()].map((task) => t(LABEL_KEYS[task]))
}

export function hasActiveTasks(): boolean {
  return active.size > 0
}

// テスト用。モジュール状態がテスト間で漏れないようにする。
export function resetTasksForTest(): void {
  active.clear()
}
