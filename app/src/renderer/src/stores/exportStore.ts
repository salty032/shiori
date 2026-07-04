import { create } from 'zustand'

// images:export と share:export は export:progress チャンネルを共用するため、
// 進捗の受け口も1つに集約する。呼び出し元（useSelection の exportSelected /
// SettingsModal の shareExport ハンドラ）は完了時（成功・失敗いずれも）に
// 自分で null へ戻す。main 側に「完了」イベントがないための素朴な設計。
type ExportProgress = { current: number; total: number } | null
// 中止ボタンがどちらの export をキャンセルすべきか判別するためのタグ。
// 呼び出し元が invoke() 直前に startExport() でセットし、完了時に clearExport() で戻す。
export type ExportKind = 'images' | 'share'

type ExportState = {
  exportProgress: ExportProgress
  exportKind: ExportKind | null
  setExportProgress: (p: ExportProgress) => void
  startExport: (kind: ExportKind) => void
  clearExport: () => void
}

export const useExportStore = create<ExportState>((set) => ({
  exportProgress: null,
  exportKind: null,
  setExportProgress: (p) => set({ exportProgress: p }),
  startExport: (kind) => set({ exportKind: kind }),
  clearExport: () => set({ exportProgress: null, exportKind: null }),
}))
