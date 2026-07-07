import { create } from 'zustand'
import type { SortOrder, TagMode } from '../types'

type Setter<T> = T | ((prev: T) => T)
function resolve<T>(value: Setter<T>, prev: T): T {
  return typeof value === 'function' ? (value as (p: T) => T)(prev) : value
}

export type CommittedFilters = {
  search: string
  tagFilters: string[]
  tagMode: TagMode
}

type FilterState = {
  searchInput: string
  committedSearch: string
  searchComposing: boolean
  tagFilters: string[]
  tagMode: TagMode
  sortOrder: SortOrder
  shuffleSeed: number
  sites: string[]
  allTags: string[]
  // フォルダを開いた直後〜条件を手で触るまでの近似的な「アクティブ」表示用。
  // 厳密な条件一致判定ではない（例えば同じ内容を手動で再現しても付かない）。
  activeSmartFolderId: string | null

  setSearchInput: (v: Setter<string>) => void
  commitSearch: (v: string) => void
  setSearchComposing: (v: boolean) => void
  setTagFilters: (v: Setter<string[]>) => void
  setTagMode: (v: Setter<TagMode>) => void
  setSortOrder: (v: SortOrder) => void
  setShuffleSeed: (v: number) => void
  setSites: (v: string[]) => void
  setAllTags: (v: string[]) => void
  applySmartFolder: (id: string, f: CommittedFilters) => void
  clearAll: () => void
}

export const useFilterStore = create<FilterState>((set) => ({
  searchInput: '',
  committedSearch: '',
  searchComposing: false,
  tagFilters: [],
  tagMode: 'and',
  sortOrder: 'date_desc',
  shuffleSeed: Date.now(),
  sites: [],
  allTags: [],
  activeSmartFolderId: null,

  setSearchInput: (v) => set((s) => ({ searchInput: resolve(v, s.searchInput), activeSmartFolderId: null })),
  commitSearch: (v) => set({ committedSearch: v }),
  setSearchComposing: (v) => set({ searchComposing: v }),
  setTagFilters: (v) => set((s) => ({ tagFilters: resolve(v, s.tagFilters), activeSmartFolderId: null })),
  setTagMode: (v) => set((s) => ({ tagMode: resolve(v, s.tagMode), activeSmartFolderId: null })),
  setSortOrder: (v) => set({ sortOrder: v }),
  setShuffleSeed: (v) => set({ shuffleSeed: v }),
  setSites: (v) => set({ sites: v }),
  setAllTags: (v) => set({ allTags: v }),

  applySmartFolder: (id, f) => set({
    searchInput: f.search,
    committedSearch: f.search,
    tagFilters: f.tagFilters,
    tagMode: f.tagMode,
    activeSmartFolderId: id,
  }),

  clearAll: () => set({
    searchInput: '',
    committedSearch: '',
    tagFilters: [],
    activeSmartFolderId: null,
  }),
}))

export function hasCommittedFilter(s: FilterState): boolean {
  return s.tagFilters.length > 0 || s.committedSearch !== ''
}

export function getCommitted(s: FilterState): CommittedFilters {
  return {
    search: s.committedSearch,
    tagFilters: s.tagFilters,
    tagMode: s.tagMode,
  }
}

export function selectQueryKey(s: FilterState): string {
  return JSON.stringify([
    s.committedSearch,
    s.tagFilters, s.tagMode, s.sortOrder,
  ])
}
