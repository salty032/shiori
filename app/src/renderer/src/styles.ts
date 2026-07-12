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

// カラートークン（C-1）。まず最も不揃いだったエラー/危険系の文字色から集約する。
// 同系統の他色（成功緑・アクセント紫等）は今後段階的にここへ寄せる。
export const color = {
  danger: '#ff7f89',
  dangerBorder: '#713039',
  dangerBg: 'rgba(255,111,122,0.08)',
} as const

const LABEL_HEIGHT = 22

export const s: Record<string, CSSProperties> = {
  updateBanner: { background: '#14291f', borderBottom: '1px solid #24523e', padding: '10px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: font.base, color: '#76d7a6', flexShrink: 0 },
  updateBtn: { padding: '6px 14px', background: '#1e3f31', border: '1px solid #2f6b51', borderRadius: 4, color: '#8be2b6', cursor: 'pointer', fontSize: font.sm, fontWeight: 700, whiteSpace: 'nowrap' as const },
  root: { display: 'flex', flex: 1, background: '#0d0f14', color: '#dce3f2', fontSize: font.base, overflow: 'hidden', userSelect: 'none' },
  // Sidebar+main だけを束ねるラッパー。ビューア（position:absolute, inset:0）はこの中だけを
  // 覆うので、隣の DetailPanel は最初からレイアウト上覆われずビューア表示中も操作できる（P1）。
  viewerHost: { position: 'relative' as const, display: 'flex', flex: 1, minWidth: 0 },
  sidebar: { background: '#0b0d12', borderRight: '1px solid #20242f', flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontSize: font.base, position: 'relative' as const },
  sidebarResizeHandle: { position: 'absolute' as const, right: 0, top: 0, bottom: 0, width: 4, cursor: 'col-resize', zIndex: 10, userSelect: 'none' as const },
  sidebarScroll: { flex: 1, minHeight: 0, overflowY: 'auto' as const, padding: '18px 14px 12px' },
  sidebarHeaderRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  sidebarBrand: { minWidth: 0, display: 'flex', alignItems: 'center', gap: 7 },
  sidebarIcon: { flexShrink: 0, borderRadius: 3, display: 'block' },
  sidebarBrandName: { color: '#dce3f2', fontSize: font.sm, fontWeight: 800, letterSpacing: 0 },
  count: { color: '#7f899f', fontSize: font.sm, fontWeight: 700 },
  main: { flex: 1, overflowY: 'scroll', scrollbarGutter: 'stable' as const, padding: '0 20px 18px', position: 'relative', display: 'flex', flexDirection: 'column' as const, gap: 16, background: '#101218' },
  dropOverlay: { position: 'absolute' as const, inset: 8, zIndex: 400, pointerEvents: 'none' as const, background: 'rgba(91,112,255,0.10)', border: '2px dashed rgba(158,165,255,0.65)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  dropOverlayText: { fontSize: font.lg, fontWeight: 800, color: '#c8cff7', background: 'rgba(13,15,20,0.6)', padding: '10px 20px', borderRadius: 6 },
  stickyHeader: { position: 'sticky' as const, top: 0, zIndex: 200, background: '#101218', borderBottom: '1px solid rgba(39,44,58,0.62)', margin: '0 -20px', padding: '12px 20px 9px', display: 'flex', flexDirection: 'column' as const, gap: 8 },
  searchBar: { display: 'flex', alignItems: 'center', gap: 8 },
  searchInputWrap: { position: 'relative' as const, flex: '1 1 360px', display: 'flex', alignItems: 'center', flexWrap: 'wrap' as const, gap: 4, minWidth: 260, minHeight: 32, background: 'rgba(20,23,31,0.72)', border: '1px solid rgba(73,82,108,0.72)', borderRadius: 3, padding: '3px 24px 3px 8px', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.035)' },
  searchInputInner: { flex: '1 1 100px', position: 'relative' as const, display: 'flex', alignItems: 'center', height: 26, minWidth: 100 },
  searchInput: { flex: 1, minWidth: 0, background: 'transparent', border: 'none', color: '#e7ebf5', padding: 0, fontSize: font.sm, outline: 'none' },
  sortBtn: { height: 30, padding: '0 10px', background: 'transparent', border: 'none', borderLeft: '1px solid rgba(73,82,108,0.44)', color: '#c4ccdc', fontSize: font.sm, cursor: 'pointer', whiteSpace: 'nowrap' as const },
  sortMenu: { position: 'absolute' as const, top: 'calc(100% + 4px)', left: 0, background: '#171a23', border: '1px solid #2b3243', borderRadius: radius.sm, padding: 4, zIndex: 500, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', minWidth: 100 },
  sortMenuItem: { display: 'block', width: '100%', padding: '6px 10px', background: 'none', border: 'none', borderRadius: 2, color: '#dce3f2', fontSize: font.sm, cursor: 'pointer', textAlign: 'left' as const, whiteSpace: 'nowrap' as const },
  sortMenuItemActive: { background: 'rgba(91,112,255,0.18)', color: '#aeb8ff' },
  viewToggle: { position: 'relative' as const, display: 'flex', alignItems: 'center' },
  viewToggleBtn: { position: 'relative' as const, zIndex: 1, width: 38, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', borderRadius: 4, color: '#8a92ab', cursor: 'pointer' },
  thumbSizeControl: { position: 'relative' as const, display: 'flex', alignItems: 'center' },
  thumbSizeBtn: { position: 'relative' as const, zIndex: 1, width: 34, height: 32, background: 'none', border: 'none', borderRadius: 4, color: '#8a92ab', cursor: 'pointer', fontSize: font.xs, fontWeight: 800, padding: 0 },
  controlDivider: { flexShrink: 0, width: 1, alignSelf: 'stretch' as const, margin: '5px 3px', background: 'rgba(73,82,108,0.4)' },
  // セグメントコントロール（S/M/L・グリッド/タイムライン）の選択中ハイライト。
  // ボタン背面で transform:translateX して選択先へスライドする（「今こう変えた」を伝える）。
  segActive: { color: '#e4e7ff' },
  segSlider: { position: 'absolute' as const, top: 1, left: 1, height: 30, borderRadius: 4, background: 'rgba(91,112,255,0.42)', boxShadow: 'inset 0 0 0 1px rgba(148,160,255,0.6), 0 1px 3px rgba(0,0,0,0.35)', pointerEvents: 'none' as const, zIndex: 0, transition: 'transform 0.22s cubic-bezier(.22,1,.36,1), width 0.22s cubic-bezier(.22,1,.36,1)' },
  searchIcon: { flexShrink: 0, width: 14, height: 14, color: '#7a84a0', pointerEvents: 'none' as const },
  searchSpinner: { flexShrink: 0, width: 14, height: 14, color: '#7a84a0', pointerEvents: 'none' as const, animation: 'shioriSpin 0.7s linear infinite' },
  searchPrefixMenu: { position: 'absolute' as const, top: 'calc(100% + 1px)', left: -1, right: -1, zIndex: 201, background: 'rgba(20,23,31,0.97)', border: '1px solid rgba(73,82,108,0.58)', borderRadius: radius.sm, padding: '4px 0', boxShadow: '0 6px 14px rgba(0,0,0,0.4)' },
  searchPrefixItem: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 30, padding: '6px 12px', background: 'none', border: 'none', color: '#c4ccdc', fontSize: font.sm, cursor: 'pointer', textAlign: 'left' as const },
  searchDateHint: { padding: '6px 12px', color: '#8791a8', fontSize: font.sm },
  searchDateWarning: { padding: '6px 12px', color: '#d2ad62', fontSize: font.xs },
  searchWrapClear: { position: 'absolute' as const, right: 4, top: '50%', transform: 'translateY(-50%)', background: 'rgba(100,110,130,0.18)', border: '1px solid rgba(100,110,130,0.28)', color: '#c4ccdc', cursor: 'pointer', padding: '4px 6px', lineHeight: 1, borderRadius: 3, display: 'flex', alignItems: 'center' },
  smartFolderEmpty: { fontSize: font.sm, color: '#7f899f', padding: '3px 0 2px', lineHeight: 1.5 },
  smartFolderCreateInput: { flex: 1, minWidth: 0, height: 32, background: '#101218', border: '1px solid #3b4355', borderRadius: 4, color: '#dce3f2', padding: '0 9px', fontSize: font.sm, fontWeight: 700, outline: 'none', boxSizing: 'border-box' as const },
  smartFolderAddIconBtn: { width: 32, height: 32, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(34,197,145,0.12)', border: '1px solid rgba(34,197,145,0.42)', borderRadius: 4, color: '#54d6a8', cursor: 'pointer', padding: 0, fontSize: 14, fontWeight: 900, lineHeight: 1, boxSizing: 'border-box' as const },
  smartFolderHeaderAddBtn: { width: 32, height: 32, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(34,197,145,0.12)', border: '1px solid rgba(34,197,145,0.42)', borderRadius: 4, color: '#54d6a8', cursor: 'pointer', padding: 0, boxSizing: 'border-box' as const },
  smartFolderHeaderAddBtnDisabled: { background: 'transparent', border: '1px solid #2a2f3d', color: '#565e73', cursor: 'default' },
  smartFolderCreateInputRow: { display: 'flex', gap: 4, width: '100%' },
  grid: { width: '100%', userSelect: 'none', position: 'relative' as const },
  selectionBox: { position: 'absolute' as const, border: '1px solid #7b7bf6', background: 'rgba(123,123,246,0.12)', pointerEvents: 'none' as const, zIndex: 20, boxSizing: 'border-box' as const },
  thumb: { position: 'relative' as const, display: 'flex', flexDirection: 'column' as const, background: '#171a23', border: '1px solid #252b38', borderRadius: 4, width: '100%', cursor: 'pointer', boxShadow: '0 1px 0 rgba(255,255,255,0.035)' },
  thumbImgWrap: { position: 'relative', width: '100%', aspectRatio: '16/9', overflow: 'hidden', flexShrink: 0 },
  thumbHovered: { border: '1px solid #3d4560', background: '#1c2030' },
  thumbSelected: { outline: '1.5px solid #8b8cff', outlineOffset: '-1.5px', boxShadow: '0 0 0 2px rgba(123,123,246,0.22)' },
  // 新着 NEW（ウィンドウ表示後の数秒だけ）。選択（インディゴ）と区別できる緑系アクセント。
  thumbNew: { outline: '1px solid rgba(84,214,168,0.9)', outlineOffset: '-1px', boxShadow: '0 0 0 2px rgba(84,214,168,0.3)', animation: 'shioriNewPulse 1.6s ease-in-out infinite' },
  // NEW表示が外れる瞬間（リング/グローをふわっとフェードアウト）
  thumbNewExit: { outline: '1px solid rgba(84,214,168,0)', outlineOffset: '-1px', boxShadow: '0 0 0 2px rgba(84,214,168,0)', transition: 'outline-color 0.9s ease, box-shadow 0.9s ease' },
  thumbNewBadge: { position: 'absolute', top: 6, left: 6, zIndex: 4, color: '#04130d', fontSize: font.xs, fontWeight: 900, letterSpacing: 0.5, background: 'linear-gradient(135deg, #6ef0bd, #36c98f)', padding: '2px 7px', borderRadius: 4, pointerEvents: 'none', boxShadow: '0 2px 8px rgba(54,201,143,0.45)' },
  thumbNewBadgeExit: { position: 'absolute', top: 6, left: 6, zIndex: 4, color: '#04130d', fontSize: font.xs, fontWeight: 900, letterSpacing: 0.5, background: 'linear-gradient(135deg, #6ef0bd, #36c98f)', padding: '2px 7px', borderRadius: 4, pointerEvents: 'none', boxShadow: '0 2px 8px rgba(54,201,143,0.45)', animation: 'shioriNewBadgeOut 0.9s ease forwards' },
  // Ctrl+矢印等の「選択を変えずにフォーカスだけ移動」時だけ表示する目印（呼び出し側で
  // focused && !selected の時だけ描画）。通常の矢印キー移動は選択とフォーカスが常に同じ
  // セルを指すため、選択ハイライトと二重表示すると常時点灯してうるさくなる。
  // outline は selected/new も使うため同じ要素に足すと上書きして消える
  // （矢印キー移動で選択枠が消えて見えるバグの原因だった）。別要素にして完全に分離する（S7-2）。
  thumbFocusFrame: { position: 'absolute', inset: -3, zIndex: 6, border: '1px solid #ffffff', borderRadius: 6, pointerEvents: 'none' },
  thumbImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block', transition: 'opacity 0.15s ease' },
  thumbFallback: { width: '100%', height: '100%', display: 'block', background: 'linear-gradient(135deg, #161a26, #0e1119)' },
  thumbLabel: { height: LABEL_HEIGHT, lineHeight: `${LABEL_HEIGHT}px`, fontSize: font.xs, fontWeight: 700, color: '#b0b8cc', padding: '0 6px', boxSizing: 'border-box', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  thumbLabelHighlight: { background: 'rgba(255,196,64,0.32)', color: '#ffe4a8', borderRadius: 2, padding: '0 1px' },
  empty: { color: '#888', display: 'flex', flexDirection: 'column' as const, gap: 12, alignItems: 'center', justifyContent: 'center', textAlign: 'center' as const, width: '100%', minHeight: 'calc(100vh - 190px)' },
  emptyTitle: { color: '#ccc', fontSize: font.xl, fontWeight: 700 },
  emptySteps: { display: 'flex', flexDirection: 'column' as const, gap: 6, color: '#999', fontSize: font.base, lineHeight: 1.6, textAlign: 'left' as const },
  emptyActions: { display: 'flex', gap: 8, flexWrap: 'wrap' as const, justifyContent: 'center' },
  emptyBtn: { padding: '7px 14px', background: '#1e2a3a', border: '1px solid #334', borderRadius: 4, color: '#9ea5ff', cursor: 'pointer', fontSize: font.base, fontWeight: 700 },
  emptyBtnSub: { background: 'transparent', color: '#8791a8', borderColor: '#343b4c' },
  emptyHint: { color: '#8791a8', fontSize: font.sm, marginTop: 4 },
  loadingMore: { textAlign: 'center', padding: 16, color: '#888', fontSize: font.base },
  filterBtn: { background: 'none', border: 'none', borderRadius: 3, cursor: 'pointer', fontSize: font.base, textAlign: 'left' as const, padding: '6px 8px' },
  smartFolderRow: { width: '100%', minWidth: 0, display: 'flex', alignItems: 'center', gap: 4, cursor: 'grab' },
  smartFolderRowDragging: { position: 'relative' as const, zIndex: 5, opacity: 0.85, background: '#232838', border: '1px solid #4a5372', borderRadius: 3, boxShadow: '0 10px 24px rgba(0,0,0,0.5)', cursor: 'grabbing' },
  smartFolderInsertLine: { height: 2, margin: '2px 0', borderRadius: 2, background: '#7b7bf6', boxShadow: '0 0 0 1px rgba(123,123,246,.18)', transition: 'opacity .08s ease' },
  smartFolderBtn: { flex: 1, minWidth: 0, minHeight: 32, display: 'flex', alignItems: 'center', gap: 7, padding: '6px 9px', background: 'rgba(23,26,35,0.48)', border: '1px solid #20242f', borderRadius: 4, color: '#a8b1c5', cursor: 'pointer', fontSize: font.sm, fontWeight: 800, textAlign: 'left' as const, overflow: 'hidden', boxSizing: 'border-box' as const },
  smartFolderDeleteBtn: { width: 32, height: 32, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', borderRadius: 4, color: '#9aa3ba', cursor: 'pointer', padding: 0, lineHeight: 1 },
  smartFolderActive: { background: 'rgba(111,111,242,0.14)', border: '1px solid rgba(111,111,242,0.46)', color: '#b9bdff' },
  siteGroup: { display: 'flex', flexDirection: 'column' as const, gap: 3, marginTop: 18 },
  siteGroupLabel: { fontSize: font.xs, color: '#6f778b', textTransform: 'uppercase' as const, letterSpacing: 0.8, marginBottom: 4, fontWeight: 800 },
  tagLabelActions: { display: 'flex', alignItems: 'center', gap: 8 },
  tagModeBtn: { minWidth: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(23,26,35,0.72)', border: '1px solid #242a38', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 800, padding: '0 6px', lineHeight: 1 },
  tagClearBtn: { width: 28, height: 28, padding: 0, justifyContent: 'center', color: '#9aa3ba', lineHeight: 1 },
  searchSuggestions: { position: 'absolute' as const, top: 'calc(100% + 1px)', left: -1, right: -1, zIndex: 201, background: 'rgba(20,23,31,0.97)', border: '1px solid rgba(73,82,108,0.58)', borderRadius: radius.sm, padding: '4px 0', boxShadow: '0 6px 14px rgba(0,0,0,0.4)', maxHeight: 200, overflowY: 'auto' as const },
  searchSuggestionItem: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 30, padding: '6px 12px', background: 'none', border: 'none', color: '#c4ccdc', fontSize: font.sm, cursor: 'pointer', textAlign: 'left' as const, whiteSpace: 'nowrap' as const, overflow: 'hidden' },
  searchSuggestionItemActive: { background: 'rgba(91,112,255,0.18)', color: '#aeb8ff' },
  searchSuggestionPlain: { minWidth: 0, color: '#b7bfd4', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  searchSuggestionValue: { flex: '0 1 132px', minWidth: 54, maxWidth: '52%', color: '#b7bfd4', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  searchSuggestionMeta: { flex: '1 1 auto', minWidth: 0, color: '#8791a8', fontSize: font.sm, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  searchSuggestionEmpty: { minHeight: 30, padding: '6px 12px', color: '#8791a8', fontSize: font.sm, display: 'flex', alignItems: 'center' },
  searchHistoryHeader: { padding: '4px 12px 2px', color: '#5c6480', fontSize: 10, fontWeight: 700, letterSpacing: '0.03em' },
  searchPrefixDivider: { height: 1, margin: '4px 0', background: 'rgba(115,124,150,0.22)' },
  searchHistoryRemove: { flexShrink: 0, marginLeft: 'auto', display: 'flex', alignItems: 'center', padding: 4, color: '#6a7290', borderRadius: 3 },
  sidebarTagList: { display: 'flex', flexWrap: 'wrap' as const, gap: 6 },
  sidebarTagChip: { maxWidth: '100%', minHeight: 30, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', background: 'rgba(23,26,35,0.6)', border: '1px solid #242a38', borderRadius: 999, color: '#8e98ad', cursor: 'pointer', fontSize: font.sm, fontWeight: 700, textAlign: 'left' as const, overflow: 'hidden', whiteSpace: 'nowrap' as const },
  sidebarTagChipText: { display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  // 由来ごとに色相を固定（手動=緑・AI=藍）。非選択=点線＋薄い色、選択=実線＋濃い色。
  // 色の濃淡に加えて「点線/実線」という非色の手掛かりでも選択状態を分け、選択で別色相に化けないよう
  // 由来別に active スタイルを持つ。
  sidebarTagChipManual: { background: 'rgba(34,197,145,0.035)', border: '1px dashed rgba(34,197,145,0.32)', color: '#5f8e7b' },
  sidebarTagChipActive: { background: 'rgba(34,197,145,0.18)', border: '1px solid rgba(34,197,145,0.6)', color: '#5fe0b0' },
  sidebarTagChipAi: { background: 'rgba(111,111,242,0.04)', border: '1px dashed rgba(111,111,242,0.34)', color: '#727699' },
  sidebarTagChipAiActive: { background: 'rgba(111,111,242,0.2)', border: '1px solid rgba(111,111,242,0.62)', color: '#aeb8ff' },
  // TagEditor と DetailPanel の一括編集で同一定義が重複していたタグチップ／追加ボタン（C-2）。
  // 色 = 由来（緑=手動 / 藍=AI）を単一/一括/サイドバーで一貫させるため、AI版もここへ集約。
  tagChipManual: { display: 'inline-flex', alignItems: 'center', padding: '5px 10px', background: 'rgba(34,197,145,0.12)', border: '1px solid rgba(34,197,145,0.45)', borderRadius: 999, color: '#54d6a8', fontSize: font.sm, fontWeight: 700, userSelect: 'text' as const },
  tagChipAi: { display: 'inline-flex', alignItems: 'center', padding: '5px 10px', background: 'rgba(111,111,242,0.14)', border: '1px solid rgba(111,111,242,0.5)', borderRadius: 999, color: '#9ea5ff', fontSize: font.sm, fontWeight: 700, userSelect: 'text' as const },
  addTagChip: { height: 32, boxSizing: 'border-box' as const, display: 'inline-flex', alignItems: 'center', padding: '0 12px', background: 'transparent', border: '1px dashed #303747', borderRadius: 999, color: '#8e98ad', fontSize: font.sm, fontWeight: 700, cursor: 'pointer', lineHeight: 1 },
  sidebarMoreBtn: { alignSelf: 'flex-start', marginTop: 2, padding: '3px 4px', background: 'transparent', border: 'none', color: '#6f778b', cursor: 'pointer', fontSize: font.xs, fontWeight: 800 },
  sidebarUtilitySection: { flexShrink: 0, padding: '10px 14px 12px', borderTop: '1px solid rgba(32,36,47,0.85)', background: 'rgba(8,10,15,0.36)', display: 'flex', flexDirection: 'column' as const, gap: 7 },
  sidebarControls: { flexShrink: 0, alignSelf: 'center', width: 192, display: 'inline-flex', alignItems: 'stretch', justifyContent: 'center', gap: 0, boxSizing: 'border-box' as const, background: 'rgba(12,14,20,0.4)', border: '1px solid rgba(73,82,108,0.3)', borderRadius: 5, padding: 2 },
  sidebarBottom: { flexShrink: 0, alignSelf: 'center', width: 192, boxSizing: 'border-box' as const, display: 'flex', gap: 6 },
  gearBtn: { flex: 1, height: 34, boxSizing: 'border-box' as const, background: 'rgba(23,26,35,0.72)', border: '1px solid transparent', borderRadius: 4, cursor: 'pointer', padding: '0 11px', display: 'flex', alignItems: 'center', gap: 9, justifyContent: 'flex-start' },
  shortcutsBtn: { flex: 'none', width: 34, padding: 0, justifyContent: 'center' },
  sidebarXBtn: { background: 'none', border: 'none', color: '#a8b1c5', cursor: 'pointer', padding: '0 0 0 4px', lineHeight: 1, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  // 通知と進捗タスクを同じ下中央スタックにまとめる。完了通知と進行中タスクが
  // 別デザインで重なる状態を避けつつ、視線移動が少ない位置に出す。
  toastStack: { position: 'fixed' as const, left: '50%', bottom: 16, transform: 'translateX(-50%)', zIndex: 5300, width: 'max-content', maxWidth: 'calc(100vw - 36px)', display: 'flex', flexDirection: 'column' as const, alignItems: 'center' as const, gap: 8, pointerEvents: 'none' as const },
  notificationCard: { position: 'relative' as const, display: 'flex', alignItems: 'stretch', gap: 10, width: 'max-content', maxWidth: 'min(380px, calc(100vw - 36px))', minHeight: 40, padding: '10px 14px 10px 18px', background: 'rgba(18,21,30,0.97)', border: 'none', borderRadius: 5, boxShadow: '0 12px 32px rgba(0,0,0,0.46), 0 2px 8px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.045)', backdropFilter: 'blur(10px)', pointerEvents: 'auto' as const, overflow: 'hidden', animation: 'shioriToastIn 0.22s ease-out', color: '#eef2ff' },
  toastIndicator: { position: 'absolute' as const, left: 0, top: 0, bottom: 0, width: 4, borderRadius: '5px 0 0 5px', flexShrink: 0, background: '#8290aa' },
  toastBody: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  toastMessage: { minWidth: 0, color: '#eef2ff', fontSize: font.sm, fontWeight: 800, lineHeight: 1.45, whiteSpace: 'normal' as const, wordBreak: 'break-word' as const },
  toastActionBtn: { flexShrink: 0, height: 32, padding: '0 12px', background: 'rgba(232,236,248,0.08)', border: '1px solid rgba(232,236,248,0.16)', borderRadius: 4, color: '#f7f9ff', cursor: 'pointer', fontSize: font.sm, fontWeight: 800, whiteSpace: 'nowrap' as const },
  toastInfo: {},
  toastSuccess: {},
  toastWarning: {},
  toastError: {},
  toastInfoMark: { background: '#8fa0ff' },
  toastSuccessMark: { background: '#54d6a8' },
  toastWarningMark: { background: '#d2ad62' },
  toastErrorMark: { background: color.danger },
  taskToast: { width: 'min(340px, calc(100vw - 36px))', flexDirection: 'column' as const, gap: 9 },
  taskHeader: { display: 'flex', alignItems: 'center', gap: 10 },
  taskLabel: { flex: 1, minWidth: 0, color: '#e2e7f3', fontSize: font.sm, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  taskBarTrack: { width: '100%', height: 4, background: 'rgba(48,55,72,0.92)', borderRadius: 999, overflow: 'hidden' },
  taskFill: { height: '100%', background: '#8fa0ff', borderRadius: 999, transition: 'width 0.25s ease' },
  taskDetail: { flexShrink: 0, color: '#98a3ba', fontSize: font.xs, fontWeight: 800, fontVariantNumeric: 'tabular-nums' as const },
  taskCancelBtn: { flexShrink: 0, height: 32, padding: '0 12px', background: 'rgba(232,236,248,0.08)', border: '1px solid rgba(232,236,248,0.16)', borderRadius: 4, color: '#f7f9ff', cursor: 'pointer', fontSize: font.sm, fontWeight: 800, whiteSpace: 'nowrap' as const },
  // ビューアは viewerHost（Sidebar+main のみを束ねるラッパー）を覆う絶対配置に変更（fixedではない）。
  // DetailPanel はレイアウト上そもそもこの外側にあるので、ビューア表示中も隠れず操作できる（P1）。
  viewer: { position: 'absolute' as const, inset: 0, background: 'rgba(0,0,0,0.93)', zIndex: 5000, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' },
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
