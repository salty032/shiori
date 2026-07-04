import { create } from 'zustand'

// 検索履歴は端末ローカルの利便性機能でしかなく、他フィルタ（DB/settings.json）とは
// 性質が異なるため localStorage に留める。同期対象にする必要はない。
const STORAGE_KEY = 'shiori.searchHistory'
const MAX_HISTORY = 8

// "from:" 等プレフィックスだけで値が空のまま確定（＝プレフィックス候補を選んで日付を
// 打つ前に blur した等）は検索として無意味なので履歴に残さない。残すと「from: が
// 日付なしのまま履歴を埋め、他の日付指定履歴と見分けが付かなくなる」問題になる。
const BARE_PREFIX_RE = /^(tag|from|to|site|type):$/i

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // ガード追加前に保存された「from:」等の値なしエントリが residual で残っている場合に
    // 備え、読み込み時にも同じ条件で除去する（保存時ガードだけだと過去データは残り続ける）。
    return parsed.filter((v): v is string => typeof v === 'string' && !BARE_PREFIX_RE.test(v.trim()))
  } catch {
    return []
  }
}

function saveHistory(history: string[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(history)) } catch { /* ストレージ無効時は履歴を諦める */ }
}

type SearchHistoryState = {
  history: string[]
  addSearch: (value: string) => void
  removeSearch: (value: string) => void
  clearHistory: () => void
}

export const useSearchHistoryStore = create<SearchHistoryState>((set, get) => ({
  history: loadHistory(),

  addSearch: (value) => {
    const trimmed = value.trim()
    if (!trimmed || BARE_PREFIX_RE.test(trimmed)) return
    const next = [trimmed, ...get().history.filter((h) => h !== trimmed)].slice(0, MAX_HISTORY)
    saveHistory(next)
    set({ history: next })
  },

  removeSearch: (value) => {
    const next = get().history.filter((h) => h !== value)
    saveHistory(next)
    set({ history: next })
  },

  clearHistory: () => {
    saveHistory([])
    set({ history: [] })
  },
}))
