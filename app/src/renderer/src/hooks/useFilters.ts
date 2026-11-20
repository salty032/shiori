import { useEffect, useMemo } from 'react'
import type { Settings } from '../types'
import { DEFAULT_SERVICE_ORDER, SITE_NAME_MAP } from '../services'
import { useFilterStore } from '../stores/filterStore'

export function useFilters(settings: Settings) {
  // 確定フィルタの状態は filterStore が単一の真実。ここはストアを購読して
  // App と同じ形のインターフェース（フィールド＋セッター）を組み立てるだけ。
  // 旧来の state+ref ミラーや searchVersion カウンタは不要になった。
  const searchInput = useFilterStore((s) => s.searchInput)
  const committedSearch = useFilterStore((s) => s.committedSearch)
  const sites = useFilterStore((s) => s.sites)
  const tagMode = useFilterStore((s) => s.tagMode)
  const allTags = useFilterStore((s) => s.allTags)
  const aiOnlyTags = useFilterStore((s) => s.aiOnlyTags)
  const sortOrder = useFilterStore((s) => s.sortOrder)
  const shuffleSeed = useFilterStore((s) => s.shuffleSeed)

  const setSearch = useFilterStore((s) => s.setSearchInput)
  const commitSearch = useFilterStore((s) => s.commitSearch)
  const setTagMode = useFilterStore((s) => s.setTagMode)
  const setSortOrder = useFilterStore((s) => s.setSortOrder)
  const setShuffleSeed = useFilterStore((s) => s.setShuffleSeed)
  const setSites = useFilterStore((s) => s.setSites)
  const setAllTags = useFilterStore((s) => s.setAllTags)
  const tagCounts = useFilterStore((s) => s.tagCounts)
  const clearAll = useFilterStore((s) => s.clearAll)

  useEffect(() => {
    window.api.listSites().then(setSites)
    window.api.listAllTags(settings.showAiTags).then(setAllTags)
  }, [setSites, setAllTags, settings.showAiTags])

  function hasActiveFilter(): boolean {
    return searchInput !== ''
  }

  function clearAllFilters(): void {
    clearAll()
  }

  function refreshTags(): void {
    window.api.listAllTags(settings.showAiTags).then(setAllTags)
  }
  function refreshSites(): void {
    window.api.listSites().then(setSites)
  }

  const sortedSites = useMemo(() => {
    const indexMap = new Map(DEFAULT_SERVICE_ORDER.map((name, i) => [name, i]))
    const getIdx = (host: string) => indexMap.get(SITE_NAME_MAP[host] ?? '') ?? DEFAULT_SERVICE_ORDER.length
    return [...sites].sort((a, b) => {
      const diff = getIdx(a) - getIdx(b)
      return diff !== 0 ? diff : a.localeCompare(b)
    })
  }, [sites])

  return {
    // search は検索ボックスの即時値（従来どおり）。committedSearch は実際にクエリへ
    // 反映されている確定値（ハイライト表示など「今の結果が何に一致したか」を知りたい用途向け）。
    search: searchInput, committedSearch, setSearch, commitSearch,
    sites: sortedSites,
    tagMode, setTagMode,
    allTags,
    aiOnlyTags,
    tagCounts,
    sortOrder, setSortOrder,
    shuffleSeed, setShuffleSeed,
    hasActiveFilter,
    clearAllFilters,
    refreshTags, refreshSites,
  }
}

export type Filters = ReturnType<typeof useFilters>
