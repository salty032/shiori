import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import type { Filters } from '../hooks/useFilters'
import { s } from '../styles'
import { serviceLabel } from '../services'
import { XIcon, ChevronDownIcon } from './Icon'
import { useSearchHistoryStore } from '../stores/searchHistoryStore'
import { parseSearchQuery } from '../stores/imageQuery'

export type ViewMode = 'grid' | 'timeline'

const SORT_LABELS: Record<string, string> = { date_desc: '新しい順', date_asc: '古い順', random: 'ランダム' }
const SEARCH_PREFIXES = [
  { prefix: 'tag:', label: 'タグで絞り込み' },
  { prefix: 'from:', label: '開始日を指定' },
  { prefix: 'to:', label: '終了日を指定' },
  { prefix: 'site:', label: 'サービスで絞り込み' },
  { prefix: 'type:', label: '種類で絞り込み' },
] as const

type ActiveFilter = {
  onRemove: () => void
}

type ActivePrefix = 'tag' | 'site' | 'type' | null
type SuggestionPrefix = Exclude<ActivePrefix, null>
type ForcedSuggestion = { prefix: SuggestionPrefix; search: string }

// 素のキーワード入力の commitSearch（FTS 検索＋COUNT の IPC を伴う）をこの間隔でまとめる。
// 演算子確定・Enter・チップ操作は即時のまま（下記 setSearchImmediate 経由）。
const SEARCH_COMMIT_DEBOUNCE_MS = 200

const TAG_PREFIX_RE = /(?:^|\s)tag:(\S*)$/i
const SITE_PREFIX_RE = /(?:^|\s)site:(\S*)$/i
const TYPE_PREFIX_RE = /(?:^|\s)type:(\S*)$/i
const FROM_PREFIX_RE = /(?:^|\s)from:(\S*)$/i
const TO_PREFIX_RE = /(?:^|\s)to:(\S*)$/i
const PREFIX_HINT_RE = /(?:^|\s)(tag|ta|t|from|fro|fr|f|to|site|sit|si|s|type|typ|ty):?$/i

type Props = {
  filters: Filters
  searchTags: string[]
  onRemoveSearchTag: (tag: string) => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  searching?: boolean
}

// 一覧上部の固定ヘッダー：検索ボックス＋アクティブフィルタチップ、並び替え。
// 検索・ソートメニューの開閉と
// 外側クリック判定はツールバー内部の状態。複数選択バーはグリッド下部の
// フローティングバー（App 側）に分離し、選択時にヘッダー高が変わって
// 一覧が下にズレるのを防いでいる。
export default forwardRef<HTMLDivElement, Props>(function Toolbar({
  filters, searchTags, onRemoveSearchTag, searchInputRef, searching,
}, ref) {
  const searchHistory = useSearchHistoryStore((s) => s.history)
  const addSearchHistory = useSearchHistoryStore((s) => s.addSearch)
  const removeSearchHistory = useSearchHistoryStore((s) => s.removeSearch)
  const [searchFocused, setSearchFocused] = useState(false)
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  // Esc でサジェスト枠だけ閉じる。検索文字列が変わったらまた表示してよい状態に戻す。
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false)
  const [forcedSuggestion, setForcedSuggestion] = useState<ForcedSuggestion | null>(null)
  const sortMenuRef = useRef<HTMLDivElement>(null)
  const searchWrapRef = useRef<HTMLDivElement>(null)
  const suggestionsRef = useRef<HTMLDivElement>(null)
  const commitDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (commitDebounceRef.current) clearTimeout(commitDebounceRef.current) }, [])

  const searchInteractionActive = searchFocused || forcedSuggestion !== null
  const suggestionSearch = forcedSuggestion?.search ?? filters.search

  const tagSuggestions = useMemo(() => {
    if (!searchInteractionActive) return []
    const match = suggestionSearch.match(TAG_PREFIX_RE)
    if (!match) return []
    const partial = match[1].toLowerCase()
    const activeSet = new Set([...filters.tagFilters, ...searchTags].map((t) => t.toLowerCase()))
    return filters.allTags.filter((t) => !activeSet.has(t.toLowerCase()) && t.toLowerCase().includes(partial))
  }, [searchInteractionActive, suggestionSearch, filters.allTags, filters.tagFilters, searchTags])

  const activePrefix = useMemo<ActivePrefix>(() => {
    if (forcedSuggestion) return forcedSuggestion.prefix
    if (!searchInteractionActive) return null
    if (filters.search.match(TAG_PREFIX_RE)) return 'tag'
    if (filters.search.match(SITE_PREFIX_RE)) return 'site'
    if (filters.search.match(TYPE_PREFIX_RE)) return 'type'
    return null
  }, [filters.search, forcedSuggestion, searchInteractionActive])

  const siteSuggestions = useMemo(() => {
    if (!searchInteractionActive) return []
    const match = suggestionSearch.match(SITE_PREFIX_RE)
    if (!match) return []
    const partial = match[1].toLowerCase()
    return filters.sites
      .filter((host) => host.toLowerCase().includes(partial) || serviceLabel(host).toLowerCase().includes(partial))
      .slice(0, 8)
  }, [suggestionSearch, filters.sites, searchInteractionActive])

  const typeSuggestions = useMemo(() => {
    if (!searchInteractionActive) return []
    const match = suggestionSearch.match(TYPE_PREFIX_RE)
    if (!match) return []
    const partial = match[1].toLowerCase()
    if (partial === 'image' || partial === 'video' || partial === '画像' || partial === '動画') return []
    return ([
      { value: 'image', label: '画像' },
      { value: 'video', label: '動画' },
    ] as const).filter(({ value, label }) => value.startsWith(partial) || label.includes(partial))
  }, [suggestionSearch, searchInteractionActive])

  const prefixSuggestions = useMemo(() => {
    if (!searchFocused || filters.search.match(TAG_PREFIX_RE) || filters.search.match(SITE_PREFIX_RE) || filters.search.match(TYPE_PREFIX_RE) || filters.search.match(FROM_PREFIX_RE) || filters.search.match(TO_PREFIX_RE)) return []
    if (!filters.search.trim()) return SEARCH_PREFIXES
    const match = filters.search.match(PREFIX_HINT_RE)
    if (!match) return []
    const partial = match[1].toLowerCase()
    return SEARCH_PREFIXES.filter(({ prefix }) => prefix.startsWith(partial))
  }, [filters.search, searchFocused])

  // 検索欄が空でフォーカス中のときだけ、直近の検索履歴をプレフィックス候補の上に出す。
  // 何か入力し始めたら（tag: 等の途中でも）消える —— 通常の絞り込み候補と競合させないため。
  const historySuggestions = useMemo(() => {
    if (!searchFocused || filters.search.trim()) return []
    return searchHistory
  }, [searchFocused, filters.search, searchHistory])

  // from:/to: の入力直後だけ出す書式ガイド（表示のみ・選択不可）。
  // 値を入力し始めたら邪魔にならないよう消す。他の4種のサジェストとは排他。
  const dateHint = useMemo<{ kind: 'guide' } | null>(() => {
    if (!searchFocused) return null
    const match = filters.search.match(FROM_PREFIX_RE) ?? filters.search.match(TO_PREFIX_RE)
    if (!match) return null
    const partial = match[1]
    if (!partial) return { kind: 'guide' }
    return null
  }, [filters.search, searchFocused])

  // tag/site/プレフィックスの3種は排他表示なので、現在表示中のものを単一リストに正規化し、
  // ↑↓/Enter/Escape をこのリストに対して動かす（キーボード操作の実体は表示中のリストが何であれ共通）。
  const activeSuggestions = useMemo(() => {
    if (activePrefix === 'tag') return tagSuggestions.map((tag) => ({ key: tag, onConfirm: () => confirmTag(tag) }))
    if (activePrefix === 'site') return siteSuggestions.map((host) => ({ key: host, onConfirm: () => confirmSite(host) }))
    if (activePrefix === 'type') return typeSuggestions.map(({ value }) => ({ key: value, onConfirm: () => replaceSearchSuffix(TYPE_PREFIX_RE, `type:${value}`, true) }))
    if (activePrefix === null) return [
      ...prefixSuggestions.map(({ prefix }) => ({ key: prefix, onConfirm: () => confirmPrefix(prefix) })),
      ...historySuggestions.map((h) => ({ key: `history:${h}`, onConfirm: () => setSearchImmediate(h) })),
    ]
    return []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePrefix, tagSuggestions, siteSuggestions, typeSuggestions, historySuggestions, prefixSuggestions])

  useEffect(() => { setHighlightedIndex(-1) }, [activeSuggestions])
  useEffect(() => {
    setSuggestionsDismissed(false)
  }, [filters.search])

  // Esc 1回目でサジェスト枠を閉じた状態かどうか（S7-14）。
  const suggestionsVisible = !suggestionsDismissed
  const hasOpenMenu = suggestionsVisible && (activeSuggestions.length > 0 || dateHint !== null)

  function setSearchImmediate(next: string): void {
    if (commitDebounceRef.current) { clearTimeout(commitDebounceRef.current); commitDebounceRef.current = null }
    setForcedSuggestion(null)
    filters.setSearch(next)
    filters.commitSearch(next)
  }

  // tag:/site:/type:/from:/to: の演算子トークンを含まない、素のキーワード検索（空欄も含む）
  // かどうか。演算子は候補選択やサジェスト確定を経て意図した値になるまで反映を待ちたいが、
  // 素のキーワードはリアルタイムに反映してよい。
  function isPureKeywordSearch(value: string): boolean {
    const { tags, site, mediaType, fromDate, toDate } = parseSearchQuery(value)
    return tags.length === 0 && site === null && mediaType === null && fromDate === null && toDate === null
  }

  function updateSearchImmediate(updater: (prev: string) => string): string {
    const next = updater(filters.search)
    setSearchImmediate(next)
    return next
  }

  useEffect(() => {
    if (highlightedIndex < 0 || !suggestionsRef.current) return
    const el = suggestionsRef.current.children[highlightedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex])

  // tag:/site: は確定した値をテキストから消さずそのまま残す。
  // 以前は tagFilters/siteFilter という別状態に移し替えてテキストからは消していたが、
  // それだと検索欄を見ても何が絞り込まれているか分からなくなる（情報が別状態に散逸する）。
  function confirmTag(tag: string): void {
    replaceSearchSuffix(TAG_PREFIX_RE, `tag:${tag}`, true)
  }

  function confirmSite(host: string): void {
    replaceSearchSuffix(SITE_PREFIX_RE, `site:${host}`, true)
  }

  function replaceSearchSuffix(pattern: RegExp, value: string, immediate = false): void {
    const updater = (prev: string): string => prev.replace(pattern, (match) => {
      const leadingSpace = match.startsWith(' ') ? ' ' : ''
      return leadingSpace + value
    })
    if (immediate) updateSearchImmediate(updater)
    else {
      setForcedSuggestion(null)
      filters.setSearch(updater)
    }
    searchInputRef.current?.focus()
  }

  function confirmPrefix(prefix: string): void {
    setSearchFocused(true)
    const next = filters.search.trim()
      ? filters.search.replace(PREFIX_HINT_RE, (match) => {
        const leadingSpace = match.startsWith(' ') ? ' ' : ''
        return leadingSpace + prefix
      })
      : prefix
    if (prefix === 'tag:') setForcedSuggestion({ prefix: 'tag', search: next })
    else if (prefix === 'site:') setForcedSuggestion({ prefix: 'site', search: next })
    else setForcedSuggestion(null)
    setSuggestionsDismissed(false)
    setHighlightedIndex(-1)
    filters.setSearch(next)
    searchInputRef.current?.focus()
  }

  useEffect(() => {
    if (!sortMenuOpen) return
    const handler = (e: MouseEvent): void => {
      if (!sortMenuRef.current?.contains(e.target as Node)) setSortMenuOpen(false)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [sortMenuOpen])

  useEffect(() => {
    if (!searchFocused) return
    const handler = (e: MouseEvent): void => {
      if (searchWrapRef.current?.contains(e.target as Node)) return
      setSearchFocused(false)
      setForcedSuggestion(null)
      searchInputRef.current?.blur()
    }
    // capture フェーズで判定する。bubble フェーズだと、サジェスト項目のクリックで
    // その項目自身が(候補の入れ替えにより)先に DOM から消えてしまい、判定時には
    // e.target が既に外れた要素になっていて「外側クリック」と誤判定してしまう
    // （マウスで候補を選ぶと選んだ直後に候補が消える不具合の原因だった）。
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [searchFocused, searchInputRef])

  const activeFilterChips = useMemo<ActiveFilter[]>(() => {
    const chips: ActiveFilter[] = []
    const siteMatch = filters.search.match(/(?:^|\s)site:(\S+)/i)
    const typed = siteMatch?.[1]?.trim().toLowerCase()
    // 実在するサイトと完全一致した場合のみ「絞り込み済み」扱いにする（入力途中の断片や
    // 存在しない値では出さない。tag: と違い site: は候補から選ぶ想定のため）。
    const searchSite = typed ? filters.sites.find((host) => host.toLowerCase() === typed) : undefined
    if (searchSite) {
      chips.push({ onRemove: () => updateSearchImmediate((prev) => prev.replace(/(?:^|\s)site:\S+/i, '').replace(/\s+/g, ' ').trim()) })
    }
    const activeTags = [...new Set([...filters.tagFilters, ...searchTags])]
    for (const tag of activeTags) {
      chips.push({
        onRemove: () => {
          filters.setTagFilters((prev) => prev.filter((t) => t !== tag))
          onRemoveSearchTag(tag)
        },
      })
    }
    return chips
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.search, filters.sites, filters.tagFilters, searchTags])

  return (
    <div ref={ref} style={s.stickyHeader}>
      <div style={s.searchBar}>
        <div ref={searchWrapRef} className="shiori-search-input-wrap" style={s.searchInputWrap}>
          {searching ? (
            <svg style={s.searchSpinner} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M14.5 8a6.5 6.5 0 1 1-2-4.7" />
            </svg>
          ) : (
            <svg style={s.searchIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="6.5" cy="6.5" r="5" /><line x1="10" y1="10" x2="14.5" y2="14.5" />
            </svg>
          )}
          <div style={s.searchInputInner}>
            <input ref={searchInputRef} className="shiori-search-input" style={s.searchInput} value={filters.search}
              onChange={(e) => {
                setForcedSuggestion(null)
                const next = e.target.value
                filters.setSearch(next)
                if (commitDebounceRef.current) { clearTimeout(commitDebounceRef.current); commitDebounceRef.current = null }
                if (!(e.nativeEvent as InputEvent).isComposing && isPureKeywordSearch(next)) {
                  commitDebounceRef.current = setTimeout(() => {
                    commitDebounceRef.current = null
                    filters.commitSearch(next)
                  }, SEARCH_COMMIT_DEBOUNCE_MS)
                }
              }}
              onFocus={() => { setSearchFocused(true); setSuggestionsDismissed(false) }}
              onBlur={() => {
                // blur 時点で確定を待たせたままにしない（デバウンス未発火のまま履歴に古い値が
                // 積まれるのを防ぐ）。
                if (commitDebounceRef.current) { clearTimeout(commitDebounceRef.current); commitDebounceRef.current = null; filters.commitSearch(filters.search) }
                addSearchHistory(filters.search)
              }}
              onKeyDown={(e) => {
                // Esc は他の早期 return より前で拾い、開いているものに応じて1段階ずつ動作させる。
                // 1. サジェスト/日付ヒントが開いていれば閉じるだけ（テキスト維持）
                // 2. テキストがあればクリア（チップは維持）
                // 3. テキストが空なら blur して検索から抜ける
                if (e.key === 'Escape') {
                  e.preventDefault()
                  if (hasOpenMenu) { setSuggestionsDismissed(true); return }
                  if (filters.search !== '') { setSearchImmediate(''); return }
                  setSearchFocused(false)
                  searchInputRef.current?.blur()
                  return
                }
                if (e.key === 'Backspace' && filters.search === '' && activeFilterChips.length > 0) {
                  e.preventDefault()
                  activeFilterChips[activeFilterChips.length - 1].onRemove()
                  return
                }
                // 素のキーワードは onChange で毎打鍵 commit 済みだが、tag:/site: 等の演算子は
                // 確定まで反映を待つため、Enter で明示的に commit する。サジェストを選択中
                // （highlightedIndex >= 0）の場合は下の分岐で「そのサジェストを確定」する従来動作を優先する。
                if (e.key === 'Enter' && !e.nativeEvent.isComposing
                  && !(suggestionsVisible && activeSuggestions.length > 0 && highlightedIndex >= 0)) {
                  e.preventDefault()
                  if (commitDebounceRef.current) { clearTimeout(commitDebounceRef.current); commitDebounceRef.current = null }
                  filters.commitSearch(filters.search)
                  return
                }
                if (!suggestionsVisible || activeSuggestions.length === 0) return
                if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightedIndex((i) => (i + 1) % activeSuggestions.length) }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightedIndex((i) => (i <= 0 ? activeSuggestions.length - 1 : i - 1)) }
                else if (e.key === 'Enter' && highlightedIndex >= 0 && !e.nativeEvent.isComposing) { e.preventDefault(); activeSuggestions[highlightedIndex].onConfirm() }
              }}
              placeholder={activeFilterChips.length > 0 ? '' : 'タイトルやメモを検索  / でフォーカス'}
              title="/ で検索にフォーカス" />
          </div>
          {(filters.search || activeFilterChips.length > 0) && (
            <button style={s.searchWrapClear} onClick={() => {
              if (commitDebounceRef.current) { clearTimeout(commitDebounceRef.current); commitDebounceRef.current = null }
              setForcedSuggestion(null)
              filters.clearAllFilters()
            }} title="検索をクリア"><XIcon size={11} strokeWidth={2.2} /></button>
          )}
          {searchInteractionActive && suggestionsVisible && activePrefix === 'tag' && (
            <div ref={suggestionsRef} style={s.searchSuggestions}>
              {tagSuggestions.length > 0 ? tagSuggestions.map((tag, i) => (
                <button
                  key={tag}
                  className="shiori-menu-item"
                  style={{ ...s.searchSuggestionItem, ...(i === highlightedIndex ? s.searchSuggestionItemActive : {}) }}
                  onMouseDown={(e) => { e.preventDefault(); confirmTag(tag) }}
                >
                  <span style={s.searchSuggestionPlain}>{tag}</span>
                </button>
              )) : (
                <div style={s.searchSuggestionEmpty}>候補がありません</div>
              )}
            </div>
          )}
          {searchInteractionActive && suggestionsVisible && activePrefix === 'site' && (
            <div ref={suggestionsRef} style={s.searchSuggestions}>
              {siteSuggestions.length > 0 ? siteSuggestions.map((host, i) => (
                <button
                  key={host}
                  className="shiori-menu-item"
                  style={{ ...s.searchSuggestionItem, ...(i === highlightedIndex ? s.searchSuggestionItemActive : {}) }}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    confirmSite(host)
                  }}
                >
                  <span style={s.searchSuggestionValue}>{host}</span>
                  <span style={s.searchSuggestionMeta}>{serviceLabel(host)}</span>
                </button>
              )) : (
                <div style={s.searchSuggestionEmpty}>候補がありません</div>
              )}
            </div>
          )}
          {searchInteractionActive && suggestionsVisible && activePrefix === 'type' && typeSuggestions.length > 0 && (
            <div ref={suggestionsRef} style={s.searchSuggestions}>
              {typeSuggestions.map(({ value, label }, i) => (
                <button
                  key={value}
                  className="shiori-menu-item"
                  style={{ ...s.searchSuggestionItem, ...(i === highlightedIndex ? s.searchSuggestionItemActive : {}) }}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    replaceSearchSuffix(TYPE_PREFIX_RE, `type:${value}`, true)
                  }}
                >
                  <span style={s.searchSuggestionValue}>{value}</span>
                  <span style={s.searchSuggestionMeta}>{label}</span>
                </button>
              ))}
            </div>
          )}
          {searchFocused && suggestionsVisible && activePrefix === null && (historySuggestions.length > 0 || prefixSuggestions.length > 0) && (
            <div ref={suggestionsRef} style={s.searchPrefixMenu}>
              {prefixSuggestions.map(({ prefix, label }, i) => (
                <button
                  key={prefix}
                  className="shiori-menu-item"
                  style={{ ...s.searchPrefixItem, ...(i === highlightedIndex ? s.searchSuggestionItemActive : {}) }}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    confirmPrefix(prefix)
                  }}
                >
                  <span style={s.searchSuggestionValue}>{prefix}</span>
                  <span style={s.searchSuggestionMeta}>{label}</span>
                </button>
              ))}
              {historySuggestions.length > 0 && (
                <>
                  {prefixSuggestions.length > 0 && <div style={s.searchPrefixDivider} />}
                  <div style={s.searchHistoryHeader}>最近の検索</div>
                  {historySuggestions.map((h, i) => {
                    const idx = prefixSuggestions.length + i
                    return (
                      <button
                        key={`history:${h}`}
                        className="shiori-menu-item"
                        style={{ ...s.searchPrefixItem, ...(idx === highlightedIndex ? s.searchSuggestionItemActive : {}) }}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          setSearchImmediate(h)
                        }}
                      >
                        <span style={s.searchSuggestionPlain}>{h}</span>
                        <span
                          style={s.searchHistoryRemove}
                          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); removeSearchHistory(h) }}
                          title="履歴から削除"
                        >
                          <XIcon size={10} strokeWidth={2} />
                        </span>
                      </button>
                    )
                  })}
                </>
              )}
            </div>
          )}
          {searchFocused && suggestionsVisible && activePrefix === null && prefixSuggestions.length === 0 && dateHint && (
            <div style={s.searchPrefixMenu}>
              <div style={s.searchDateHint}>
                日付で絞り込み — 例: 2026-01-01 / 2026-01 / 2026
              </div>
            </div>
          )}
        </div>
        <div ref={sortMenuRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button style={{ ...s.sortBtn, display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={() => setSortMenuOpen((v) => !v)}>
            {SORT_LABELS[filters.sortOrder]} <ChevronDownIcon size={10} />
          </button>
          {sortMenuOpen && (
            <div style={s.sortMenu}>
              {(['date_desc', 'date_asc', 'random'] as const).map((opt) => (
                <button key={opt}
                  className="shiori-menu-item"
                  style={{ ...s.sortMenuItem, ...(filters.sortOrder === opt ? s.sortMenuItemActive : {}) }}
                  onClick={() => {
                    if (opt === 'random') filters.setShuffleSeed(Date.now())
                    filters.setSortOrder(opt)
                    setSortMenuOpen(false)
                  }}>{SORT_LABELS[opt]}</button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
})
