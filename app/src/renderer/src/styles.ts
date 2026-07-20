import type { CSSProperties } from 'react'

export const font = {
  xs: 12,
  sm: 13,
  base: 14,
  lg: 15,
  xl: 17,
  xxl: 20,
} as const

// 角丸トークン（C-1）。sm=メニュー/サジェスト等の小さいポップオーバー、md=モーダル/パネル/入力欄、
// pill=チップ・トグル等の完全な丸み。既存の 2/3/4/5/999 混在から、少なくともメニュー系はここへ寄せる。
export const radius = {
  sm: 3,
  md: 4,
  pill: 999,
} as const

// カラートークン（C-1）。実体は global.css の CSS 変数（テーマごとに切り替わる）。
// ここでは JS 側から参照する名前だけを固定し、値はテーマに応じて自動で変わる。
export const color = {
  danger: 'var(--danger)',
  dangerBorder: 'var(--danger-border)',
  dangerBg: 'rgba(var(--danger-rgb), 0.08)',
} as const

// ConfirmDialog/WhatsNewModal/SettingsModal で重複していた overlay/panel の基本形を集約。
// スクリム濃度・zIndex・panel のサイズは各モーダルでスプレッド上書きする前提（C-1）。
export const modal: Record<string, CSSProperties> = {
  overlay: { position: 'fixed' as const, inset: 0, zIndex: 7000, background: 'rgba(var(--scrim-rgb), 0.78)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
  panel: { width: 420, maxWidth: 'calc(100vw - 48px)', background: 'var(--bg-page)', border: '1px solid var(--border-default)', borderRadius: 4, boxShadow: '0 24px 70px rgba(var(--scrim-rgb), 0.62)', overflow: 'hidden' },
}

const LABEL_HEIGHT = 22

export const s: Record<string, CSSProperties> = {
  updateBanner: { background: 'rgba(var(--success-rgb), 0.14)', borderBottom: '1px solid rgba(var(--success-rgb), 0.32)', padding: '10px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: font.base, color: 'var(--success)', flexShrink: 0 },
  updateBtn: { padding: '6px 14px', background: 'rgba(var(--success-rgb), 0.22)', border: '1px solid rgba(var(--success-rgb), 0.45)', borderRadius: 4, color: 'var(--success)', cursor: 'pointer', fontSize: font.sm, fontWeight: 700, whiteSpace: 'nowrap' as const },
  root: { display: 'flex', flex: 1, background: 'var(--bg-page)', color: 'var(--text-primary)', fontSize: font.base, overflow: 'hidden', userSelect: 'none' },
  // Sidebar+main だけを束ねるラッパー。ビューア（position:absolute, inset:0）はこの中だけを
  // 覆うので、隣の DetailPanel は最初からレイアウト上覆われずビューア表示中も操作できる（P1）。
  viewerHost: { position: 'relative' as const, display: 'flex', flex: 1, minWidth: 0 },
  sidebar: { background: 'var(--bg-well)', borderRight: '1px solid var(--border-default)', flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontSize: font.base, position: 'relative' as const },
  sidebarResizeHandle: { position: 'absolute' as const, right: 0, top: 0, bottom: 0, width: 4, cursor: 'col-resize', zIndex: 10, userSelect: 'none' as const },
  sidebarScroll: { flex: 1, minHeight: 0, overflowY: 'auto' as const, padding: '18px 14px 12px' },
  sidebarHeaderRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  sidebarBrand: { minWidth: 0, display: 'flex', alignItems: 'center', gap: 7 },
  sidebarIcon: { flexShrink: 0, borderRadius: 3, display: 'block' },
  sidebarBrandName: { color: 'var(--text-primary)', fontSize: font.sm, fontWeight: 800, letterSpacing: 0 },
  count: { color: 'var(--text-secondary)', fontSize: font.sm, fontWeight: 700 },
  main: { flex: 1, overflowY: 'scroll', scrollbarGutter: 'stable' as const, padding: '0 20px 18px', position: 'relative', display: 'flex', flexDirection: 'column' as const, gap: 16, background: 'var(--bg-content)' },
  // ドロップ受け口はウィンドウ全体なので、枠も端まで詰める（inset/角丸を入れると
  // 「枠の外側は受け付けない」ように見えてしまうが、実際はそこも受け付ける）。
  dropOverlay: { position: 'absolute' as const, inset: 0, zIndex: 400, pointerEvents: 'none' as const, background: 'rgba(var(--accent-rgb), 0.12)', border: '2px dashed rgba(var(--accent-rgb), 0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  dropOverlayText: { fontSize: font.lg, fontWeight: 800, color: 'var(--accent-text)', background: 'rgba(var(--scrim-rgb), 0.6)', padding: '10px 20px', borderRadius: 6 },
  stickyHeader: { position: 'sticky' as const, top: 0, zIndex: 200, background: 'var(--bg-content)', borderBottom: '1px solid rgba(var(--border-rgb), 0.62)', margin: '0 -20px', padding: '12px 20px 9px', display: 'flex', flexDirection: 'column' as const, gap: 8 },
  searchBar: { display: 'flex', alignItems: 'center', gap: 8 },
  searchInputWrap: { position: 'relative' as const, flex: '1 1 360px', display: 'flex', alignItems: 'center', flexWrap: 'wrap' as const, gap: 4, minWidth: 260, minHeight: 32, background: 'rgba(var(--surface-rgb), 0.72)', border: '1px solid rgba(var(--hairline-rgb), 0.72)', borderRadius: 3, padding: '3px 24px 3px 8px', boxShadow: 'inset 0 1px 0 rgba(var(--text-rgb), 0.035)' },
  searchInputInner: { flex: '1 1 100px', position: 'relative' as const, display: 'flex', alignItems: 'center', height: 26, minWidth: 100 },
  searchInput: { flex: 1, minWidth: 0, background: 'transparent', border: 'none', color: 'var(--text-primary)', padding: 0, fontSize: font.sm, outline: 'none' },
  sortBtn: { height: 30, padding: '0 10px', background: 'transparent', border: 'none', borderLeft: '1px solid rgba(var(--hairline-rgb), 0.44)', color: 'var(--text-primary)', fontSize: font.sm, cursor: 'pointer', whiteSpace: 'nowrap' as const },
  sortMenu: { position: 'absolute' as const, top: 'calc(100% + 4px)', left: 0, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.sm, padding: 4, zIndex: 500, boxShadow: '0 8px 24px rgba(var(--scrim-rgb), 0.5)', minWidth: 100 },
  sortMenuItem: { display: 'block', width: '100%', padding: '6px 10px', background: 'none', border: 'none', borderRadius: 2, color: 'var(--text-primary)', fontSize: font.sm, cursor: 'pointer', textAlign: 'left' as const, whiteSpace: 'nowrap' as const },
  sortMenuItemActive: { background: 'rgba(var(--accent-rgb), 0.18)', color: 'var(--accent-text)' },
  viewToggle: { position: 'relative' as const, display: 'flex', alignItems: 'center' },
  viewToggleBtn: { position: 'relative' as const, zIndex: 1, width: 38, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', borderRadius: 4, color: 'var(--text-secondary)', cursor: 'pointer' },
  thumbSizeControl: { position: 'relative' as const, display: 'flex', alignItems: 'center' },
  thumbSizeBtn: { position: 'relative' as const, zIndex: 1, width: 34, height: 32, background: 'none', border: 'none', borderRadius: 4, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: font.xs, fontWeight: 800, padding: 0 },
  controlDivider: { flexShrink: 0, width: 1, alignSelf: 'stretch' as const, margin: '5px 3px', background: 'rgba(var(--hairline-rgb), 0.4)' },
  // セグメントコントロール（S/M/L・グリッド/タイムライン）の選択中ハイライト。
  // ボタン背面で transform:translateX して選択先へスライドする（「今こう変えた」を伝える）。
  segActive: { color: 'var(--accent-text)' },
  segSlider: { position: 'absolute' as const, top: 1, left: 1, height: 30, borderRadius: 4, background: 'rgba(var(--accent-rgb), 0.42)', boxShadow: 'inset 0 0 0 1px rgba(var(--accent-rgb), 0.6), 0 1px 3px rgba(var(--scrim-rgb), 0.35)', pointerEvents: 'none' as const, zIndex: 0, transition: 'transform 0.22s cubic-bezier(.22,1,.36,1), width 0.22s cubic-bezier(.22,1,.36,1)' },
  searchIcon: { flexShrink: 0, width: 14, height: 14, color: 'var(--text-secondary)', pointerEvents: 'none' as const },
  searchSpinner: { flexShrink: 0, width: 14, height: 14, color: 'var(--text-secondary)', pointerEvents: 'none' as const, animation: 'shioriSpin 0.7s linear infinite' },
  searchPrefixMenu: { position: 'absolute' as const, top: 'calc(100% + 1px)', left: -1, right: -1, zIndex: 201, background: 'rgba(var(--surface-rgb), 0.97)', border: '1px solid rgba(var(--hairline-rgb), 0.58)', borderRadius: radius.sm, padding: '4px 0', boxShadow: '0 6px 14px rgba(var(--scrim-rgb), 0.4)' },
  searchPrefixItem: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 30, padding: '6px 12px', background: 'none', border: 'none', color: 'var(--text-primary)', fontSize: font.sm, cursor: 'pointer', textAlign: 'left' as const },
  searchDateHint: { padding: '6px 12px', color: 'var(--text-secondary)', fontSize: font.sm },
  searchDateWarning: { padding: '6px 12px', color: 'var(--warning)', fontSize: font.xs },
  searchWrapClear: { position: 'absolute' as const, right: 4, top: '50%', transform: 'translateY(-50%)', background: 'rgba(var(--hairline-rgb), 0.22)', border: '1px solid rgba(var(--hairline-rgb), 0.32)', color: 'var(--text-primary)', cursor: 'pointer', padding: '4px 6px', lineHeight: 1, borderRadius: 3, display: 'flex', alignItems: 'center' },
  smartFolderEmpty: { fontSize: font.sm, color: 'var(--text-secondary)', padding: '3px 0 2px', lineHeight: 1.5 },
  smartFolderCreateInput: { flex: 1, minWidth: 0, height: 32, background: 'var(--bg-content)', border: '1px solid var(--border-strong)', borderRadius: 4, color: 'var(--text-primary)', padding: '0 9px', fontSize: font.sm, fontWeight: 700, outline: 'none', boxSizing: 'border-box' as const },
  smartFolderAddIconBtn: { width: 32, height: 32, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--success-rgb), 0.12)', border: '1px solid rgba(var(--success-rgb), 0.42)', borderRadius: 4, color: 'var(--success)', cursor: 'pointer', padding: 0, fontSize: 14, fontWeight: 900, lineHeight: 1, boxSizing: 'border-box' as const },
  smartFolderHeaderAddBtn: { width: 32, height: 32, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--success-rgb), 0.12)', border: '1px solid rgba(var(--success-rgb), 0.42)', borderRadius: 4, color: 'var(--success)', cursor: 'pointer', padding: 0, boxSizing: 'border-box' as const },
  smartFolderHeaderAddBtnDisabled: { background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-muted)', cursor: 'default' },
  smartFolderCreateInputRow: { display: 'flex', gap: 4, width: '100%' },
  grid: { width: '100%', userSelect: 'none', position: 'relative' as const },
  selectionBox: { position: 'absolute' as const, border: '1px solid var(--accent)', background: 'rgba(var(--accent-rgb), 0.12)', pointerEvents: 'none' as const, zIndex: 20, boxSizing: 'border-box' as const },
  thumb: { position: 'relative' as const, display: 'flex', flexDirection: 'column' as const, background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 4, width: '100%', cursor: 'pointer', boxShadow: '0 1px 0 rgba(var(--text-rgb), 0.035)' },
  thumbImgWrap: { position: 'relative', width: '100%', aspectRatio: '16/9', overflow: 'hidden', flexShrink: 0 },
  // 縦長画像（Shorts等）は16:9セルからはみ出るため cover→contain に切り替え、
  // 余白は viewer と同様に画像鑑賞用途として意図的に非テーマの暗色で埋める
  thumbImgWrapVertical: { background: '#0d0f14' },
  thumbVideoPlay: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.95)', fontSize: 28, pointerEvents: 'none', textShadow: '0 6px 20px rgba(0,0,0,0.7)' },
  thumbVideoDuration: { position: 'absolute', right: 6, top: 6, zIndex: 3, color: '#fff', fontSize: font.xs, fontWeight: 800, background: 'rgba(6,8,12,0.82)', padding: '2px 6px', borderRadius: 4, pointerEvents: 'none', fontVariantNumeric: 'tabular-nums' },
  thumbHovered: { border: '1px solid var(--border-strong)', background: 'var(--bg-surface-hover)' },
  thumbSelected: { outline: '1.5px solid var(--accent)', outlineOffset: '-1.5px', boxShadow: '0 0 0 2px rgba(var(--accent-rgb), 0.22)' },
  // 新着 NEW（ウィンドウ表示後の数秒だけ）。選択（インディゴ）と区別できる緑系アクセント。
  thumbNew: { outline: '1px solid rgba(var(--success-rgb), 0.9)', outlineOffset: '-1px', boxShadow: '0 0 0 2px rgba(var(--success-rgb), 0.3)', animation: 'shioriNewPulse 1.6s ease-in-out infinite' },
  // NEW表示が外れる瞬間（リング/グローをふわっとフェードアウト）
  thumbNewExit: { outline: '1px solid rgba(var(--success-rgb), 0)', outlineOffset: '-1px', boxShadow: '0 0 0 2px rgba(var(--success-rgb), 0)', transition: 'outline-color 0.9s ease, box-shadow 0.9s ease' },
  // バッジ自体は彩度の高い緑グラデーション地に固定文字色で、どちらのテーマでも
  // そのまま視認できるため意図的にテーマ非依存（var化しない）。
  thumbNewBadge: { position: 'absolute', top: 6, left: 6, zIndex: 4, color: '#04130d', fontSize: font.xs, fontWeight: 900, letterSpacing: 0.5, background: 'linear-gradient(135deg, #6ef0bd, #36c98f)', padding: '2px 7px', borderRadius: 4, pointerEvents: 'none', boxShadow: '0 2px 8px rgba(54,201,143,0.45)' },
  thumbNewBadgeExit: { position: 'absolute', top: 6, left: 6, zIndex: 4, color: '#04130d', fontSize: font.xs, fontWeight: 900, letterSpacing: 0.5, background: 'linear-gradient(135deg, #6ef0bd, #36c98f)', padding: '2px 7px', borderRadius: 4, pointerEvents: 'none', boxShadow: '0 2px 8px rgba(54,201,143,0.45)', animation: 'shioriNewBadgeOut 0.9s ease forwards' },
  // Ctrl+矢印等の「選択を変えずにフォーカスだけ移動」時だけ表示する目印（呼び出し側で
  // focused && !selected の時だけ描画）。通常の矢印キー移動は選択とフォーカスが常に同じ
  // セルを指すため、選択ハイライトと二重表示すると常時点灯してうるさくなる。
  // outline は selected/new も使うため同じ要素に足すと上書きして消える
  // （矢印キー移動で選択枠が消えて見えるバグの原因だった）。別要素にして完全に分離する（S7-2）。
  // 色は surface に対して確実にコントラストが立つ text-bright を使う（テーマが変わっても機能する）。
  thumbFocusFrame: { position: 'absolute', inset: -3, zIndex: 6, border: '1px solid var(--text-bright)', borderRadius: 6, pointerEvents: 'none' },
  thumbImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block', transition: 'opacity 0.15s ease' },
  thumbImgVertical: { objectFit: 'contain' as const },
  thumbFallback: { width: '100%', height: '100%', display: 'block', background: 'linear-gradient(135deg, var(--bg-surface), var(--bg-page))' },
  thumbLabel: { height: LABEL_HEIGHT, lineHeight: `${LABEL_HEIGHT}px`, fontSize: font.xs, fontWeight: 700, color: 'var(--text-secondary)', padding: '0 6px', boxSizing: 'border-box', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  thumbLabelHighlight: { background: 'rgba(var(--warning-rgb), 0.32)', color: 'var(--warning)', borderRadius: 2, padding: '0 1px' },
  empty: { color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column' as const, gap: 12, alignItems: 'center', justifyContent: 'center', textAlign: 'center' as const, width: '100%', minHeight: 'calc(100vh - 190px)' },
  emptyTitle: { color: 'var(--text-primary)', fontSize: font.xl, fontWeight: 700 },
  emptySteps: { display: 'flex', flexDirection: 'column' as const, gap: 6, color: 'var(--text-secondary)', fontSize: font.base, lineHeight: 1.6, textAlign: 'left' as const },
  emptyActions: { display: 'flex', gap: 8, flexWrap: 'wrap' as const, justifyContent: 'center' },
  emptyBtn: { padding: '7px 14px', background: 'rgba(var(--accent-rgb), 0.16)', border: '1px solid rgba(var(--accent-rgb), 0.4)', borderRadius: 4, color: 'var(--accent-text)', cursor: 'pointer', fontSize: font.base, fontWeight: 700 },
  emptyBtnSub: { background: 'transparent', color: 'var(--text-secondary)', borderColor: 'var(--border-strong)' },
  emptyHint: { color: 'var(--text-secondary)', fontSize: font.sm, marginTop: 4 },
  loadingMore: { textAlign: 'center', padding: 16, color: 'var(--text-secondary)', fontSize: font.base },
  filterBtn: { background: 'none', border: 'none', borderRadius: 3, cursor: 'pointer', fontSize: font.base, textAlign: 'left' as const, padding: '6px 8px' },
  smartFolderRow: { width: '100%', minWidth: 0, display: 'flex', alignItems: 'center', gap: 4, cursor: 'grab' },
  smartFolderRowDragging: { position: 'relative' as const, zIndex: 5, opacity: 0.85, background: 'var(--bg-surface-hover)', border: '1px solid var(--border-strong)', borderRadius: 3, boxShadow: '0 10px 24px rgba(var(--scrim-rgb), 0.5)', cursor: 'grabbing' },
  smartFolderInsertLine: { height: 2, margin: '2px 0', borderRadius: 2, background: 'var(--accent)', boxShadow: '0 0 0 1px rgba(var(--accent-rgb), 0.18)', transition: 'opacity .08s ease' },
  smartFolderBtn: { flex: 1, minWidth: 0, minHeight: 32, display: 'flex', alignItems: 'center', gap: 7, padding: '6px 9px', background: 'rgba(var(--surface-rgb), 0.48)', border: '1px solid var(--border-default)', borderRadius: 4, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: font.sm, fontWeight: 800, textAlign: 'left' as const, overflow: 'hidden', boxSizing: 'border-box' as const, transition: 'background 0.12s ease, border-color 0.12s ease, color 0.12s ease' },
  smartFolderDeleteBtn: { width: 32, height: 32, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', borderRadius: 4, color: 'var(--text-secondary)', cursor: 'pointer', padding: 0, lineHeight: 1 },
  smartFolderActive: { background: 'rgba(var(--accent-rgb), 0.14)', border: '1px solid rgba(var(--accent-rgb), 0.46)', color: 'var(--accent-text)' },
  siteGroup: { display: 'flex', flexDirection: 'column' as const, gap: 3, marginTop: 18 },
  siteGroupLabel: { fontSize: font.xs, color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: 0.8, marginBottom: 4, fontWeight: 800 },
  tagLabelActions: { display: 'flex', alignItems: 'center', gap: 8 },
  tagModeBtn: { minWidth: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--surface-rgb), 0.72)', border: '1px solid var(--border-default)', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 800, padding: '0 6px', lineHeight: 1 },
  tagClearBtn: { width: 28, height: 28, padding: 0, justifyContent: 'center', color: 'var(--text-secondary)', lineHeight: 1 },
  searchSuggestions: { position: 'absolute' as const, top: 'calc(100% + 1px)', left: -1, right: -1, zIndex: 201, background: 'rgba(var(--surface-rgb), 0.97)', border: '1px solid rgba(var(--hairline-rgb), 0.58)', borderRadius: radius.sm, padding: '4px 0', boxShadow: '0 6px 14px rgba(var(--scrim-rgb), 0.4)', maxHeight: 200, overflowY: 'auto' as const },
  searchSuggestionItem: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 30, padding: '6px 12px', background: 'none', border: 'none', color: 'var(--text-primary)', fontSize: font.sm, cursor: 'pointer', textAlign: 'left' as const, whiteSpace: 'nowrap' as const, overflow: 'hidden' },
  searchSuggestionItemActive: { background: 'rgba(var(--accent-rgb), 0.18)', color: 'var(--accent-text)' },
  searchSuggestionPlain: { minWidth: 0, color: 'var(--text-secondary)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  searchSuggestionValue: { flex: '0 1 132px', minWidth: 54, maxWidth: '52%', color: 'var(--text-secondary)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  searchSuggestionMeta: { flex: '1 1 auto', minWidth: 0, color: 'var(--text-secondary)', fontSize: font.sm, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  searchSuggestionEmpty: { minHeight: 30, padding: '6px 12px', color: 'var(--text-secondary)', fontSize: font.sm, display: 'flex', alignItems: 'center' },
  searchHistoryHeader: { padding: '4px 12px 2px', color: 'var(--text-muted)', fontSize: 10, fontWeight: 700, letterSpacing: '0.03em' },
  searchPrefixDivider: { height: 1, margin: '4px 0', background: 'rgba(var(--hairline-rgb), 0.22)' },
  searchHistoryRemove: { flexShrink: 0, marginLeft: 'auto', display: 'flex', alignItems: 'center', padding: 4, color: 'var(--text-muted)', borderRadius: 3 },
  sidebarTagList: { display: 'flex', flexWrap: 'wrap' as const, gap: 6 },
  sidebarTagChip: { maxWidth: '100%', minHeight: 30, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', background: 'rgba(var(--surface-rgb), 0.6)', border: '1px solid var(--border-default)', borderRadius: 999, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: font.sm, fontWeight: 700, textAlign: 'left' as const, overflow: 'hidden', whiteSpace: 'nowrap' as const, transition: 'background 0.12s ease, border-color 0.12s ease, color 0.12s ease' },
  sidebarTagChipText: { display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  // 由来ごとに色相を固定（手動=緑・AI=藍）。非選択=点線＋薄い色、選択=実線＋濃い色。
  // 色の濃淡に加えて「点線/実線」という非色の手掛かりでも選択状態を分け、選択で別色相に化けないよう
  // 由来別に active スタイルを持つ。
  sidebarTagChipManual: { background: 'rgba(var(--success-rgb), 0.05)', border: '1px dashed rgba(var(--success-rgb), 0.4)', color: 'var(--success)' },
  sidebarTagChipActive: { background: 'rgba(var(--success-rgb), 0.18)', border: '1px solid rgba(var(--success-rgb), 0.6)', color: 'var(--success)' },
  sidebarTagChipAi: { background: 'rgba(var(--accent-rgb), 0.06)', border: '1px dashed rgba(var(--accent-rgb), 0.4)', color: 'var(--accent)' },
  sidebarTagChipAiActive: { background: 'rgba(var(--accent-rgb), 0.2)', border: '1px solid rgba(var(--accent-rgb), 0.62)', color: 'var(--accent-text)' },
  // TagEditor と DetailPanel の一括編集で同一定義が重複していたタグチップ／追加ボタン（C-2）。
  // 色 = 由来（緑=手動 / 藍=AI）を単一/一括/サイドバーで一貫させるため、AI版もここへ集約。
  tagChipManual: { display: 'inline-flex', alignItems: 'center', padding: '5px 10px', background: 'rgba(var(--success-rgb), 0.12)', border: '1px solid rgba(var(--success-rgb), 0.45)', borderRadius: 999, color: 'var(--success)', fontSize: font.sm, fontWeight: 700, userSelect: 'text' as const },
  tagChipAi: { display: 'inline-flex', alignItems: 'center', padding: '5px 10px', background: 'rgba(var(--accent-rgb), 0.14)', border: '1px solid rgba(var(--accent-rgb), 0.5)', borderRadius: 999, color: 'var(--accent-text)', fontSize: font.sm, fontWeight: 700, userSelect: 'text' as const },
  addTagChip: { height: 32, boxSizing: 'border-box' as const, display: 'inline-flex', alignItems: 'center', padding: '0 12px', background: 'transparent', border: '1px dashed var(--border-strong)', borderRadius: 999, color: 'var(--text-secondary)', fontSize: font.sm, fontWeight: 700, cursor: 'pointer', lineHeight: 1 },
  sidebarMoreBtn: { alignSelf: 'flex-start', marginTop: 2, padding: '3px 4px', background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: font.xs, fontWeight: 800 },
  sidebarUtilitySection: { flexShrink: 0, padding: '10px 14px 12px', borderTop: '1px solid rgba(var(--border-rgb), 0.85)', background: 'var(--bg-inset)', display: 'flex', flexDirection: 'column' as const, gap: 7 },
  sidebarControls: { flexShrink: 0, alignSelf: 'center', width: 192, display: 'inline-flex', alignItems: 'stretch', justifyContent: 'center', gap: 0, boxSizing: 'border-box' as const, background: 'var(--bg-inset-strong)', border: '1px solid rgba(var(--hairline-rgb), 0.3)', borderRadius: 5, padding: 2 },
  sidebarBottom: { flexShrink: 0, alignSelf: 'center', width: 192, boxSizing: 'border-box' as const, display: 'flex', gap: 6 },
  gearBtn: { flex: 1, height: 34, boxSizing: 'border-box' as const, background: 'rgba(var(--surface-rgb), 0.72)', border: '1px solid transparent', borderRadius: 4, cursor: 'pointer', padding: '0 11px', display: 'flex', alignItems: 'center', gap: 9, justifyContent: 'flex-start', transition: 'color 0.12s ease' },
  shortcutsBtn: { flex: 'none', width: 34, padding: 0, justifyContent: 'center' },
  sidebarXBtn: { background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0 0 0 4px', lineHeight: 1, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  // 通知と進捗タスクを同じ下中央スタックにまとめる。完了通知と進行中タスクが
  // 別デザインで重なる状態を避けつつ、視線移動が少ない位置に出す。
  // zIndex はアプリ内の最前面（モーダル/フライアウト/ビューアより上）に固定する。
  // 動画トリミング(6000)やタグ入力(6100)、確認ダイアログ(7000)の裏で通知が
  // 見えなくなるのを防ぐため。
  toastStack: { position: 'fixed' as const, left: '50%', bottom: 16, transform: 'translateX(-50%)', zIndex: 8000, width: 'max-content', maxWidth: 'calc(100vw - 36px)', display: 'flex', flexDirection: 'column' as const, alignItems: 'center' as const, gap: 8, pointerEvents: 'none' as const },
  // トースト/タスクカードは常に濃色地に明色文字の「エレベーテッド」な見た目で、
  // ライトモードでも意図的にダーク寄りに統一する（背景に溶け込ませず通知として即座に視認させるため）。
  notificationCard: { position: 'relative' as const, display: 'flex', alignItems: 'stretch', gap: 10, width: 'max-content', maxWidth: 'min(380px, calc(100vw - 36px))', minHeight: 40, padding: '10px 14px 10px 18px', background: 'rgba(18,21,30,0.97)', border: 'none', borderRadius: 5, boxShadow: '0 12px 32px rgba(0,0,0,0.46), 0 2px 8px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.045)', backdropFilter: 'blur(10px)', pointerEvents: 'auto' as const, overflow: 'hidden', animation: 'shioriToastIn 0.22s ease-out', color: '#eef2ff' },
  toastIndicator: { position: 'absolute' as const, left: 0, top: 0, bottom: 0, width: 4, borderRadius: '5px 0 0 5px', flexShrink: 0, background: '#8290aa' },
  toastBody: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  toastMessage: { minWidth: 0, color: '#eef2ff', fontSize: font.sm, fontWeight: 800, lineHeight: 1.45, whiteSpace: 'normal' as const, wordBreak: 'break-word' as const },
  toastActionBtn: { flexShrink: 0, height: 32, padding: '0 12px', background: 'rgba(232,236,248,0.08)', border: '1px solid rgba(232,236,248,0.16)', borderRadius: 4, color: '#f7f9ff', cursor: 'pointer', fontSize: font.sm, fontWeight: 800, whiteSpace: 'nowrap' as const },
  toastInfo: {},
  toastSuccess: {},
  toastWarning: {},
  toastError: {},
  toastInfoMark: { background: 'var(--accent)' },
  toastSuccessMark: { background: 'var(--success)' },
  toastWarningMark: { background: 'var(--warning)' },
  toastErrorMark: { background: color.danger },
  taskToast: { width: 'min(340px, calc(100vw - 36px))', flexDirection: 'column' as const, gap: 9 },
  taskHeader: { display: 'flex', alignItems: 'center', gap: 10 },
  taskLabel: { flex: 1, minWidth: 0, color: '#e2e7f3', fontSize: font.sm, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  taskBarTrack: { width: '100%', height: 4, background: 'rgba(48,55,72,0.92)', borderRadius: 999, overflow: 'hidden' },
  taskFill: { height: '100%', background: 'var(--accent)', borderRadius: 999, transition: 'width 0.25s ease' },
  taskDetail: { flexShrink: 0, color: '#98a3ba', fontSize: font.xs, fontWeight: 800, fontVariantNumeric: 'tabular-nums' as const },
  taskCancelBtn: { flexShrink: 0, height: 32, padding: '0 12px', background: 'rgba(232,236,248,0.08)', border: '1px solid rgba(232,236,248,0.16)', borderRadius: 4, color: '#f7f9ff', cursor: 'pointer', fontSize: font.sm, fontWeight: 800, whiteSpace: 'nowrap' as const },
  // ビューアは viewerHost（Sidebar+main のみを束ねるラッパー）を覆う絶対配置に変更（fixedではない）。
  // DetailPanel はレイアウト上そもそもこの外側にあるので、ビューア表示中も隠れず操作できる（P1）。
  // overflow:hidden 必須: ズーム時の scale() で拡大された画像は箱をはみ出すが、ビューアは
  // zIndex 5000 なので、クリップしないと右隣の DetailPanel の上に画像が描画されてしまう。
  // ビューア配下（このキーから filmstrip 系まで）は画像鑑賞用の常時暗転オーバーレイであり、
  // ライトモードでも意図的にダークのまま固定する（テーマ非依存）。
  viewer: { position: 'absolute' as const, inset: 0, overflow: 'hidden', background: 'rgba(0,0,0,0.93)', zIndex: 5000, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' },
  viewerTopBar: { position: 'absolute' as const, top: 0, left: 0, right: 0, zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, minHeight: 46, padding: '8px 14px 8px 24px', boxSizing: 'border-box' as const, background: 'linear-gradient(rgba(0,0,0,0.74), rgba(0,0,0,0))' },
  // 100vw/100vh ではなく自身の箱（= viewerHost の実サイズ）基準にする。ビューアはもはや
  // フルビューポート幅ではない（DetailPanel 分だけ狭い）ため、100vw を使うとはみ出す。
  viewerMediaStack: { width: 'calc(100% - clamp(48px, 6vw, 112px))', height: 'calc(100% - clamp(136px, 18vh, 188px))', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', gap: 8 },
  viewerMediaFrame: { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  viewerImg: { width: '100%', height: '100%', objectFit: 'contain' as const, display: 'block', transformOrigin: 'center' },
  viewerTitle: { minWidth: 0, flex: 1, color: '#d6dbea', fontSize: font.sm, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, textShadow: '0 2px 10px rgba(0,0,0,0.9)' },
  viewerActions: { flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10 },
  viewerCounter: { color: 'rgba(255,255,255,0.46)', fontSize: font.base, fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' as const, letterSpacing: 0.5 },
  viewerClose: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', color: '#999', cursor: 'pointer', lineHeight: 1, padding: '2px 6px' },
  viewerZoomHud: { position: 'absolute' as const, top: 58, left: '50%', transform: 'translateX(-50%)', zIndex: 3, display: 'inline-flex', alignItems: 'center', minHeight: 24, padding: '2px 8px', background: 'rgba(13,15,20,0.48)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 999, pointerEvents: 'none' as const },
  viewerZoomValue: { color: 'rgba(232,236,248,0.68)', fontSize: font.xs, fontWeight: 800, fontVariantNumeric: 'tabular-nums', minWidth: 36, textAlign: 'center' as const },
  filmstrip: { position: 'absolute' as const, bottom: 0, left: 0, right: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 4, padding: '30px 80px 18px', background: 'linear-gradient(transparent, rgba(0,0,0,0.82))', zIndex: 1 },
  filmstripThumb: { width: 64, height: 36, objectFit: 'cover' as const, borderRadius: 3, cursor: 'pointer', border: '2px solid transparent', flexShrink: 0, opacity: 0.6 },
  filmstripThumbPlaceholder: { width: 64, height: 36, border: '2px solid transparent', flexShrink: 0, opacity: 0, pointerEvents: 'none' as const },
  filmstripThumbActive: { border: '2px solid rgba(255,255,255,0.9)', opacity: 1 },
  viewerArrow: { position: 'absolute' as const, top: '50%', transform: 'translateY(-50%)', width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4, color: '#fff', cursor: 'pointer', zIndex: 1 },
}
