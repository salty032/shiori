import { useEffect, useMemo, useState } from 'react'
import type { Settings, SmartFolder } from '../types'
import { SITE_NAME_MAP } from '../utils'
import { DEFAULT_SERVICE_ORDER } from '../services'
import { useFilterStore } from '../stores/filterStore'
import type { ShowToast } from './useToast'
import { t } from '../i18n'

export function useFilters(settings: Settings, setSettings: (updated: Settings) => void, showToast?: ShowToast) {
  // 確定フィルタの状態は filterStore が単一の真実。ここはストアを購読して
  // App と同じ形のインターフェース（フィールド＋セッター）を組み立てるだけ。
  // 旧来の state+ref ミラーや searchVersion カウンタは不要になった。
  const searchInput = useFilterStore((s) => s.searchInput)
  const committedSearch = useFilterStore((s) => s.committedSearch)
  const sites = useFilterStore((s) => s.sites)
  const tagFilters = useFilterStore((s) => s.tagFilters)
  const tagMode = useFilterStore((s) => s.tagMode)
  const allTags = useFilterStore((s) => s.allTags)
  const aiOnlyTags = useFilterStore((s) => s.aiOnlyTags)
  const sortOrder = useFilterStore((s) => s.sortOrder)
  const shuffleSeed = useFilterStore((s) => s.shuffleSeed)

  const setSearch = useFilterStore((s) => s.setSearchInput)
  const commitSearch = useFilterStore((s) => s.commitSearch)
  const setTagFilters = useFilterStore((s) => s.setTagFilters)
  const setTagMode = useFilterStore((s) => s.setTagMode)
  const setSortOrder = useFilterStore((s) => s.setSortOrder)
  const setShuffleSeed = useFilterStore((s) => s.setShuffleSeed)
  const setSites = useFilterStore((s) => s.setSites)
  const setAllTags = useFilterStore((s) => s.setAllTags)
  const tagCounts = useFilterStore((s) => s.tagCounts)
  const applySmartFolder = useFilterStore((s) => s.applySmartFolder)
  const clearAll = useFilterStore((s) => s.clearAll)
  const activeSmartFolderId = useFilterStore((s) => s.activeSmartFolderId)

  // スマートフォルダ作成 UI のローカル状態（クエリには影響しないのでストア外）
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  useEffect(() => {
    window.api.listSites().then(setSites)
    window.api.listAllTags(settings.showAiTags).then(setAllTags)
  }, [setSites, setAllTags, settings.showAiTags])

  function hasActiveFilter(): boolean {
    return tagFilters.length > 0 || searchInput !== ''
  }

  function clearAllFilters(): void {
    clearAll()
  }

  async function saveSmartFolder(name: string): Promise<void> {
    // タグ/サイトは検索欄に tag:/site: として直接入力する方式になっており、tagFilters
    // （構造化状態）は今のUIからはもう更新されない。保存時にテキストからも拾っておかないと、
    // 検索欄に tag:/site: を書いただけで保存したフォルダが絞り込み無しとして保存されてしまう。
    const tagMatches = [...searchInput.matchAll(/(?:^|\s)tag:(\S+)/gi)]
    const textTags = tagMatches.map((m) => m[1].trim().toLowerCase()).filter(Boolean)
    const siteMatch = searchInput.match(/(?:^|\s)site:(\S+)/i)
    const textSite = siteMatch ? siteMatch[1].trim().toLowerCase() : null
    const search = searchInput
      .replace(/(?:^|\s)tag:\S+/gi, '')
      .replace(/(?:^|\s)site:\S+/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
    const folder: SmartFolder = {
      id: Date.now().toString(),
      name: name.trim(),
      tags: [...new Set([...tagFilters, ...textTags])],
      tagMode,
      site: textSite,
      search,
    }
    const prev = settings
    const smartFolders = [...(settings.smartFolders ?? []), folder]
    // 楽観更新（R-5）: 先にローカル反映してから IPC を投げ、失敗時のみ戻す。
    setSettings({ ...settings, smartFolders })
    setCreatingFolder(false)
    setNewFolderName('')
    try {
      await window.api.setSettings({ smartFolders })
    } catch (err) {
      console.error('[smart-folder] save failed', err)
      setSettings(prev)
      showToast?.(t('toast.smartFolderSaveFailed'), 'error')
    }
  }

  async function deleteSmartFolder(id: string): Promise<void> {
    const prev = settings
    const smartFolders = settings.smartFolders.filter((f) => f.id !== id)
    setSettings({ ...settings, smartFolders })
    try {
      await window.api.setSettings({ smartFolders })
    } catch (err) {
      console.error('[smart-folder] delete failed', err)
      setSettings(prev)
      showToast?.(t('toast.smartFolderDeleteFailed'), 'error')
    }
  }

  async function reorderSmartFolders(smartFolders: SmartFolder[]): Promise<void> {
    const prev = settings
    setSettings({ ...settings, smartFolders })
    try {
      await window.api.setSettings({ smartFolders })
    } catch (err) {
      console.error('[smart-folder] reorder failed', err)
      setSettings(prev)
      showToast?.(t('toast.reorderSaveFailed'), 'error')
    }
  }

  function loadSmartFolder(folder: SmartFolder): void {
    // site（およびtag）は構造化状態には入れず、検索欄のテキストに tag:/site: として展開
    // するだけにする（C-5）。アクティブ判定は activeSmartFolderId で足りており、site を
    // 構造化 state と検索テキストの二重表現にすると Backspace 解除等が1回で効かなくなる。
    const composedSearch = [
      ...folder.tags.map((tag) => `tag:${tag}`),
      folder.site ? `site:${folder.site}` : '',
      folder.search,
    ].filter(Boolean).join(' ')
    applySmartFolder(folder.id, {
      search: composedSearch,
      tagFilters: folder.tags,
      tagMode: folder.tagMode,
    })
  }

  function refreshTags(): void {
    window.api.listAllTags(settings.showAiTags).then(setAllTags)
  }
  function refreshSites(): void {
    window.api.listSites().then(setSites)
  }

  const sortedSites = useMemo(() => {
    const userOrder = settings.serviceOrder ?? []
    const orderList = userOrder.length ? userOrder : DEFAULT_SERVICE_ORDER
    const indexMap = new Map(orderList.map((name, i) => [name, i]))
    const getIdx = (host: string) => indexMap.get(SITE_NAME_MAP[host] ?? '') ?? orderList.length
    return [...sites].sort((a, b) => {
      const diff = getIdx(a) - getIdx(b)
      return diff !== 0 ? diff : a.localeCompare(b)
    })
  }, [sites, settings.serviceOrder])

  return {
    // search は検索ボックスの即時値（従来どおり）。committedSearch は実際にクエリへ
    // 反映されている確定値（ハイライト表示など「今の結果が何に一致したか」を知りたい用途向け）。
    search: searchInput, committedSearch, setSearch, commitSearch,
    sites: sortedSites,
    tagFilters, setTagFilters,
    tagMode, setTagMode,
    allTags,
    aiOnlyTags,
    tagCounts,
    sortOrder, setSortOrder,
    shuffleSeed, setShuffleSeed,
    creatingFolder, setCreatingFolder,
    newFolderName, setNewFolderName,
    hasActiveFilter,
    clearAllFilters,
    activeSmartFolderId,
    saveSmartFolder, deleteSmartFolder, reorderSmartFolders, loadSmartFolder,
    refreshTags, refreshSites,
  }
}

export type Filters = ReturnType<typeof useFilters>
