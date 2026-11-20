import { create } from 'zustand'
import type { SortOrder, TagMode, TagWithCount } from '../types'

type Setter<T> = T | ((prev: T) => T)
function resolve<T>(value: Setter<T>, prev: T): T {
  return typeof value === 'function' ? (value as (p: T) => T)(prev) : value
}

export type CommittedFilters = {
  search: string
  tagMode: TagMode
}

type FilterState = {
  searchInput: string
  committedSearch: string
  tagMode: TagMode
  sortOrder: SortOrder
  shuffleSeed: number
  sites: string[]
  // allTags はオートコンプリート用の「タグ名の配列」（従来どおり）。集約表示での手動/AI
  // 色分け用に、AI専用（手動が1件も無い）タグ名の集合を aiOnlyTags として並行して持つ。
  // 三者は setAllTags で同一の TagWithCount[] から一度に導出するのでズレない。
  allTags: string[]
  aiOnlyTags: Set<string>
  // タグ名 -> そのタグが付いている画像の枚数。サイドバーは順位ではなくこの枚数で
  // 表示を打ち切る（順位で切ると、画像を足すたびに順位が動いて境界のタグが消える）。
  tagCounts: Record<string, number>

  setSearchInput: (v: Setter<string>) => void
  commitSearch: (v: string) => void
  setTagMode: (v: Setter<TagMode>) => void
  setSortOrder: (v: SortOrder) => void
  setShuffleSeed: (v: number) => void
  setSites: (v: string[]) => void
  setAllTags: (v: TagWithCount[]) => void
  clearAll: () => void
}

export const useFilterStore = create<FilterState>((set) => ({
  searchInput: '',
  committedSearch: '',
  tagMode: 'and',
  sortOrder: 'date_desc',
  shuffleSeed: Date.now(),
  sites: [],
  allTags: [],
  tagCounts: {},
  aiOnlyTags: new Set(),

  setSearchInput: (v) => set((s) => ({ searchInput: resolve(v, s.searchInput) })),
  commitSearch: (v) => set({ committedSearch: v }),
  setTagMode: (v) => set((s) => ({ tagMode: resolve(v, s.tagMode) })),
  setSortOrder: (v) => set({ sortOrder: v }),
  setShuffleSeed: (v) => set({ shuffleSeed: v }),
  setSites: (v) => set({ sites: v }),
  setAllTags: (v) => set({
    allTags: v.map((t) => t.name),
    aiOnlyTags: new Set(v.filter((t) => t.source === 'ai').map((t) => t.name)),
    tagCounts: Object.fromEntries(v.map((t) => [t.name, t.count])),
  }),

  clearAll: () => set({
    searchInput: '',
    committedSearch: '',
    // AND / OR のボタンはタグが 2 つ以上のときしか出ない。ここで戻さないと、OR にして解除した後、
    // 次に 2 つで絞ったとき黙って OR になる。
    tagMode: 'and',
  }),
}))

export function hasCommittedFilter(s: FilterState): boolean {
  return s.committedSearch !== ''
}

export function getCommitted(s: FilterState): CommittedFilters {
  return {
    search: s.committedSearch,
    tagMode: s.tagMode,
  }
}

export function selectQueryKey(s: FilterState): string {
  return JSON.stringify([
    s.committedSearch,
    s.tagMode, s.sortOrder,
  ])
}

// 書き換えたら画面ごと読み直す（理由は imageStore.ts の末尾）。
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload())
