import { useEffect, useMemo, useRef, useState } from 'react'
import type { Filters } from '../hooks/useFilters'
import type { ViewMode } from './Toolbar'
import { control, font, s, weight } from '../styles'
import { GridIcon, HelpCircleIcon, ListIcon, SettingsIcon, XIcon } from './Icon'
import ContextMenu from './ContextMenu'
import { removeSearchTokens } from '../stores/imageQuery'
import ShortcutsFlyout from './ShortcutsFlyout'
import { usePanelResize } from '../hooks/usePanelResize'
import { useWindowWidth } from '../hooks/useWindowWidth'
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_DEFAULT_WIDTH, panelLimits } from '../layout'

// 不具合・要望の報告フォーム（Tally）。**URL に載せてよいのは版と実行環境だけ**——ライブラリ
// 由来の文字列（タイトルには作品名が入る）は絶対に混ぜない。**送信経路はアプリに持たせず**、
// フォームを開くところで止める。README のプライバシー欄には、Tally を開く際に版と
// 実行環境を渡すことを明記する。GitHub Issues から移したのは、報告にアカウントを要求しないため。
const FEEDBACK_FORM_URL = 'https://tally.so/r/QK9X8G'

// UA を丸ごと渡さない。切り分けに要るのは OS と Electron の版だけで、残り（WebKit や
// Safari の版）は生々しいわりに使い道がない。取れなければ黙って省く。
function shortEnv(): string {
  const ua = navigator.userAgent
  const os = /\(([^)]+)\)/.exec(ua)?.[1]?.split(';')[0]?.trim()
  const electron = /Electron\/([\d.]+)/.exec(ua)?.[1]
  return [os, electron && `Electron ${electron}`].filter(Boolean).join(' / ') || 'unknown'
}

// フォーム側は version / env という名前の隠し項目で受ける。名前を変えると黙って空で届く。
function feedbackUrl(appVersion: string | null): string {
  const params = new URLSearchParams({ version: appVersion ?? 'unknown', env: shortEnv() })
  return `${FEEDBACK_FORM_URL}?${params}`
}
// .ico を img に渡すと最大サイズ（128px）だけが選ばれて 16px へ縮小され、ぼやける上に
// 絵が枠内でわずかに上寄りなぶんだけ文字とズレる。実寸の PNG を表示倍率ごとに渡す。
import appIcon16 from '../../../../build/icon16.png'
import appIcon24 from '../../../../build/icon24.png'
import appIcon32 from '../../../../build/icon32.png'
import { useT } from '../i18n'
import { SETUP_STEP_COUNT } from '../setupGuideState'
import { THUMB_SIZE_STEPS } from '../../../shared/settingsDefaults'

// サイドバーに出すタグの下限枚数。「上位N件」で切ると、AIタグ付けがキャプチャ1枚につき
// 十数個のタグを付けるせいで撮影・削除のたびに各タグの件数が動き、境界のタグが順位を
// 上下して出たり消えたりする（下位ほど同数タグがひしめくため、境界はほぼ常に同数集団の
// 途中を通る）。枚数で切れば、画像を足しても件数は増える一方なので押し出しが起きない。
// 表示から消えるのは「削除で枚数がこの値を割ったとき」だけになる。
const SIDEBAR_TAG_MIN_COUNT = 5
// 枚数がこの値に届くタグがまだ無い（＝ライブラリが小さい）間だけ、上位N件で代替する。
// タグ欄が空のままになるのを防ぐための下駄。
const SIDEBAR_TAG_FALLBACK_LIMIT = 12

type Props = {
  count: number
  filters: Filters
  searchTags: string[]
  onRemoveSearchTag: (tag: string) => void
  onAddSearchTag: (tag: string) => void
  settingsActive: boolean
  onToggleSettings: () => void
  setupCompleted: number
  onShowSetup: () => void
  thumbnailSize: number
  onThumbnailSize: (size: number) => void
  viewMode: ViewMode
  onViewMode: (mode: ViewMode) => void
  onDeleteTag: (tag: string) => void
}

// S/M/L のボタン。数値は THUMB_SIZE_STEPS（shared/settingsDefaults.ts）が原本
// （以前はボタン側に [['S',120],...] を別に持っており、片方だけ直すと
//   ハイライト位置と実際のサイズが黙ってズレる）。
const THUMB_SIZES = [
  { label: 'S', size: THUMB_SIZE_STEPS.S, titleKey: 'sidebar.sizeSmall' },
  { label: 'M', size: THUMB_SIZE_STEPS.M, titleKey: 'sidebar.sizeMedium' },
  { label: 'L', size: THUMB_SIZE_STEPS.L, titleKey: 'sidebar.sizeLarge' },
] as const

// 左サイドバー：件数・タグ絞り込み・設定。サービス絞り込みは検索の site: で行う。
// フィルタ操作のロジックは filters フックに集約済みで、ここは表示と委譲のみ。
// タグの「+N 表示」折りたたみだけはサイドバー固有の表示状態なので内部に持つ。
export default function Sidebar({
  count, filters,
  searchTags, onRemoveSearchTag, onAddSearchTag, settingsActive, onToggleSettings,
  setupCompleted, onShowSetup,
  thumbnailSize, onThumbnailSize, viewMode, onViewMode,
  onDeleteTag,
}: Props) {
  const { t, tp } = useT()
  const nearestThumbSize = THUMB_SIZES.reduce(
    (best, cur) => Math.abs(cur.size - thumbnailSize) < Math.abs(best.size - thumbnailSize) ? cur : best,
    THUMB_SIZES[0],
  ).size
  const [showAllTags, setShowAllTags] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const shortcutsBtnRef = useRef<HTMLButtonElement>(null)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  useEffect(() => {
    window.api.getAppVersion().then(setAppVersion).catch(() => {})
  }, [])
  const [tagCtxMenu, setTagCtxMenu] = useState<{ x: number; y: number; tag: string; keyboard?: boolean } | null>(null)
  const windowWidth = useWindowWidth()
  const { width: sidebarWidth, handleResizeStart } = usePanelResize({
    storageKey: 'shiori-sidebar-width',
    min: SIDEBAR_MIN_WIDTH,
    max: SIDEBAR_MAX_WIDTH,
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    direction: 'right',
    limit: panelLimits(windowWidth).sidebar,
  })

  // 「N枚以上のタグ」だけを出す＋「現在フィルタ中でN枚未満のタグ」も可視に保つ。
  const visibleTags = useMemo(() => {
    if (showAllTags) return filters.allTags
    // allTags は件数の降順なので、しきい値を満たすものは先頭に固まっている。
    let base = filters.allTags.filter((tag) => (filters.tagCounts[tag] ?? 0) >= SIDEBAR_TAG_MIN_COUNT)
    // まだどのタグもしきい値に届かない小さなライブラリでは、タグ欄が空になってしまうので上位N件で代替する。
    if (base.length === 0) base = filters.allTags.slice(0, SIDEBAR_TAG_FALLBACK_LIMIT)
    const shown = [...base]
    for (const tag of searchTags) {
      if (filters.allTags.includes(tag) && !shown.includes(tag)) shown.push(tag)
    }
    return shown
  }, [filters.allTags, filters.tagCounts, searchTags, showAllTags])

  const hiddenTagCount = Math.max(0, filters.allTags.length - visibleTags.length)
  return (
    <aside style={{ ...s.sidebar, width: sidebarWidth }}>
      <div style={s.sidebarResizeHandle} onPointerDown={handleResizeStart} />
      <div style={s.sidebarScroll}>
        <div style={s.sidebarHeaderRow}>
          <div style={s.sidebarBrand}>
            <img
              src={appIcon16}
              srcSet={`${appIcon16} 1x, ${appIcon24} 1.5x, ${appIcon32} 2x`}
              width={16}
              height={16}
              alt=""
              style={s.sidebarIcon}
            />
            <span style={s.sidebarBrandName}>Shiori</span>
          </div>
          <span style={s.count}>{tp('sidebar.imageCount', count)}</span>
        </div>

        {filters.allTags.length > 0 && (
          <div style={s.siteGroup}>
            <div style={{ ...s.siteGroupLabel, display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: control.md }}>
              <span>{t('tag.sectionTitle')}</span>
              <div style={s.tagLabelActions}>
                {/* タグクリックは検索欄の tag:xxx に書き込む。buildImageQuery は全タグに tagMode を適用する。 */}
                {new Set(searchTags).size >= 2 && (
                  <button className="shiori-hover-tint" onClick={() => filters.setTagMode((m) => m === 'and' ? 'or' : 'and')}
                    style={{ ...s.tagModeBtn, color: filters.tagMode === 'and' ? 'var(--success)' : 'var(--warning)' }}>
                    {filters.tagMode === 'and' ? 'AND' : 'OR'}
                  </button>
                )}
                {searchTags.length > 0 && (
                  <button className="shiori-hover-tint" onClick={() => {
                    // searchTags 由来のタグは検索欄の tag:xxx トークンなので、まとめて1回で
                    // 剥がす（onRemoveSearchTag を複数回呼ぶと毎回同じ古い filters.search を
                    // 元に計算するため、後の呼び出しが前の呼び出しの結果を上書きしてしまう）。
                    const next = removeSearchTokens(filters.search, 'tag')
                    filters.setSearch(next)
                    filters.commitSearch(next)
                  }} style={{ ...s.sidebarXBtn, ...s.tagClearBtn }} title={t('sidebar.clearTagFilters')}><XIcon size={11} strokeWidth={2} /></button>
                )}
              </div>
            </div>
            <div style={s.sidebarTagList}>
              {visibleTags.map((tag) => {
                const active = searchTags.includes(tag)
                // 手動は薄緑→濃緑、AI は灰→藍。AI に色を持たせないのは styles.ts の
                // sidebarTagChipAi のコメント参照（藍はアクセント色なので選択中だけに使う）。
                const aiOnly = filters.aiOnlyTags.has(tag)
                const chipStyle = active
                  ? (aiOnly ? s.sidebarTagChipAiActive : s.sidebarTagChipActive)
                  : (aiOnly ? s.sidebarTagChipAi : s.sidebarTagChipManual)
                return (
                  <button key={tag} className="shiori-hover-tint"
                    onClick={() => {
                      // 追加も解除も検索欄のテキスト（tag:xxx）で行う — 検索欄と表示を一致させ、
                      // 見えない場所に絞り込み状態が溜まらないようにするため。
                      if (active) {
                        onRemoveSearchTag(tag)
                      } else {
                        onAddSearchTag(tag)
                      }
                    }}
                    onContextMenu={(e) => { e.preventDefault(); setTagCtxMenu({ x: e.clientX, y: e.clientY, tag }) }}
                    onKeyDown={(e) => {
                      // キーボードからもタグ削除メニューを開けるようにする（U-6）。右クリック相当。
                      // メニューはチップ左下に出し、先頭項目を選択済みにして Enter 即実行できるようにする。
                      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                        e.preventDefault()
                        const r = e.currentTarget.getBoundingClientRect()
                        setTagCtxMenu({ x: r.left, y: r.bottom, tag, keyboard: true })
                      }
                    }}
                    style={{ ...s.sidebarTagChip, ...chipStyle }}
                    title={tag + (aiOnly ? t('sidebar.aiTagSuffix') : '') + t('sidebar.tagDeleteHint')}>
                    <span style={s.sidebarTagChipText}>{tag}</span>
                  </button>
                )
              })}
            </div>
            {hiddenTagCount > 0 && (
              <button className="shiori-hover-tint" style={s.sidebarMoreBtn} onClick={() => setShowAllTags((v) => !v)}>
                {/* UX-5: 「付けたタグが出てこない」を防ぐため、隠れている理由（枚数しきい値未満）を明示する */}
                {showAllTags ? t('sidebar.collapseTags') : t('sidebar.showHiddenTags', { count: hiddenTagCount, min: SIDEBAR_TAG_MIN_COUNT })}
              </button>
            )}
          </div>
        )}
      </div>
      {tagCtxMenu && (
        <ContextMenu
          x={tagCtxMenu.x}
          y={tagCtxMenu.y}
          items={[{ label: t('sidebar.deleteTagEverywhere', { tag: tagCtxMenu.tag }), danger: true, onClick: () => onDeleteTag(tagCtxMenu.tag) }]}
          initialHighlight={tagCtxMenu.keyboard ? 0 : -1}
          onClose={() => setTagCtxMenu(null)}
        />
      )}

      <div style={s.sidebarUtilitySection}>
        {/* 3 つ終わるまでは大きいボタンで出す（やることが残っている合図）。終わったら
            消して、下のリンク行へテキストとして移す。**完全に消しはしない**——設定を
            やり直したいときや、あとから読み返したいときの入口が無くなる。 */}
        {setupCompleted < 3 && (
          <button className="shiori-hover-tint" style={{ ...s.sidebarSetupBtn, ...s.sidebarSetupBtnTodo }} onClick={onShowSetup}>
            <span style={s.sidebarSetupMark}>{setupCompleted}</span>
            <span>{t('sidebar.setupProgress', { completed: setupCompleted, total: SETUP_STEP_COUNT })}</span>
          </button>
        )}
        <div style={s.sidebarControls}>
          <div style={s.thumbSizeControl} title={t('sidebar.thumbnailSize')}>
            {/* 選択中ハイライト（背面）。選択先のセグメントへスライドする。settings.json の
                thumbnailSize は 80-360 を許容するが UI は3択のみなので、旧値・手編集で
                ちょうど一致しない値が入っていても最も近いボタンをアクティブに見せる
                （でないと indexOf===-1 でどのボタンもハイライトされなくなる）。 */}
            <div style={{ ...s.segSlider, width: 34, transform: `translateX(${THUMB_SIZES.findIndex((v) => v.size === nearestThumbSize) * 34}px)` }} />
            {THUMB_SIZES.map(({ label, size, titleKey }) => (
              <button key={size}
                data-current={nearestThumbSize === size ? 'true' : undefined}
                style={{ ...s.thumbSizeBtn, ...(nearestThumbSize === size ? s.segActive : {}) }}
                onClick={() => onThumbnailSize(size)}
                title={t(titleKey)}>{label}</button>
            ))}
          </div>
          <div style={s.controlDivider} />
          <div style={s.viewToggle}>
            <div style={{ ...s.segSlider, width: 38, transform: `translateX(${viewMode === 'timeline' ? 38 : 0}px)` }} />
            {([['grid', <GridIcon key="i" />, t('sidebar.viewGrid')], ['timeline', <ListIcon key="i" />, t('sidebar.viewTimeline')]] as const).map(([mode, icon, label]) => (
              <button key={mode}
                data-tour={mode === 'timeline' ? 'timeline-toggle' : undefined}
                data-current={viewMode === mode ? 'true' : undefined}
                style={{ ...s.viewToggleBtn, ...(viewMode === mode ? s.segActive : {}) }}
                onClick={() => onViewMode(mode)} title={label}>{icon}</button>
            ))}
          </div>
        </div>
        <div style={s.sidebarBottom}>
          <button className="shiori-hover-tint" style={{ ...s.gearBtn, color: settingsActive ? 'var(--accent-text)' : 'var(--text-secondary)' }}
            onClick={onToggleSettings}>
            <SettingsIcon size={16} />
            <span style={{ fontSize: font.base, fontWeight: weight.medium }}>{t('menu.settings')}</span>
          </button>
          <button className="shiori-hover-tint" ref={shortcutsBtnRef} style={{ ...s.gearBtn, ...s.shortcutsBtn, color: showShortcuts ? 'var(--accent-text)' : 'var(--text-secondary)' }}
            onClick={() => setShowShortcuts((v) => !v)} title={t('shortcuts.heading')}>
            <HelpCircleIcon size={16} />
          </button>
        </div>
        {/* 使い方と報告。**この 2 つだけ常に見える場所に置く**——どちらも「困った時に
            すぐ押したい」もので、探させると届かない。
            **「変更点」はここに置かない。** 3 つ並べると幅に入らず 2 行へ折り返し、下端が
            ギザギザになっていた。更新直後は勝手に出るのでここは読み返し用でしかなく、
            版・クレジットと同じ性格なので設定の「情報」タブへ移した。
            **「?」にも混ぜない。** あれは名前どおりショートカットを出す場所で、名前と
            中身が食い違う入れ物は、押す前に何が入っているか読めなくなる。 */}
        <div style={s.sidebarLinks}>
          {setupCompleted === 3 && (
            <>
              <button style={s.sidebarLink} onClick={onShowSetup}>{t('sidebar.setupLink')}</button>
              {/* 区切りは文字ではなく縦線。「・」だと「不具合・要望を報告」の中の「・」と
                  見分けが付かず、2 つのリンクが 3 つに見えていた。 */}
              <span style={s.sidebarLinkSep} />
            </>
          )}
          <button style={s.sidebarLink} onClick={() => window.api.openUrl(feedbackUrl(appVersion))} title={t('help.feedbackHint')}>
            {t('help.feedback')}
          </button>
        </div>
      </div>
      {showShortcuts && (
        <ShortcutsFlyout anchorEl={shortcutsBtnRef.current} onClose={() => setShowShortcuts(false)} />
      )}
    </aside>
  )
}
