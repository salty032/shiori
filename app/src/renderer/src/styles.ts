import type { CSSProperties } from 'react'

export const font = {
  xs: 12,
  sm: 13,
  base: 14,
  lg: 15,
  xl: 17,
  xxl: 20,
} as const

// 角丸は4種類だけ。以前は 2/3/4/5/6/999 が混在し、同じ役割の部品でも場所ごとに
// 丸みが違っていた（メニューは3、チップは999、カードは4、通知は5）。
//   sm  = サムネの上に重なる小さなバッジ（NEW・尺）・検索語のハイライト・挿入線
//   md  = 入力欄・ボタン・カード・メニュー・サムネイル（画面のほとんど）
//   lg  = モーダル・浮くパネル（画面の手前に出るものだけ大きく取る）
//   pill= タグ・トグル
//
// **面が大きいほど丸くする。** md=4 の頃は画面のほぼ全部が直角に見えていて、資料アプリ
// らしい硬さになっていた。いちど md=10 まで上げたが今度は丸すぎたので、その中間で止めてある。
// sm を md より小さく残しているのは、高さ 18px 程度のバッジに md を当てると角丸が
// 高さの半分に近づいて隣のタグチップ（pill）と見分けがつかなくなるため。
//
// 例外は「N px 外側へずらしたリング」だけ（サムネのフォーカス枠・ツアーのハイライト）。
// 内側の角と平行にするには md + N が要るので、md を変えたらこの2箇所も一緒に動く
// （どちらも radius.md からの式で書いてある）。
// すき間（gap・margin）はこの 6 段から選ぶ。以前は 0/1/2/3/4/5/6/7/8/9/10/12/14/16/18 が
// 混在し、隣り合う領域で 6 と 8、9 と 10 のように 1〜2px だけ違っていた。1 つ 1 つは
// 気づかないが、画面全体では「なんとなく揃っていない」としか言えない状態になる。
// **名前は px そのもの。** 意味で名付ける（sm/md/lg）と、段を足したいときに名前の並びが
// 破綻するか、既存の名前の指す値を変えることになって全画面が黙って動く。
// 実際 4 と 8 の間が要る場所（折り返すチップの行間、サムネイルの格子）が出て 6 を足した。
//   x2  = 密着させたい小物同士（アイコンの並び、行の中の詰め）
//   x4  = 一覧の行と行
//   x6  = 折り返して並ぶものの行間、サムネイルの格子
//   x8  = 部品どうし（ボタンとボタン、アイコンと文字）
//   x12 = 小見出しとその中身
//   x16 = セクションとセクション
//   x24 = 画面の大きな区切り
export const space = {
  x2: 2,
  x4: 4,
  x6: 6,
  x8: 8,
  x12: 12,
  x16: 16,
  x24: 24,
} as const

// 押せる部品の高さはこの 3 段だけ。以前は 24/25/26/28/30/32/34/36 が混在し、同じ
// 「押せる横長のもの」が場所ごとに 2px ずつ違っていた。横に並ぶと上下がずれて見える。
//   sm = 行に添える小さな四角ボタン（削除の ✕ など）
//   md = 一覧の行・チップ・補助的な入力欄
//   lg = 主要なボタン・検索欄
// 正方形のアイコンボタンは width も同じトークンで指定すること（片方だけ変えると歪む）。
export const control = {
  sm: 24,
  md: 28,
  lg: 32,
} as const

export const radius = {
  sm: 4,
  md: 7,
  lg: 11,
  pill: 999,
} as const

// サムネイルの四隅に重ねるバッジ（NEW・尺・再生時刻）の余白。左右と上下で値が違う。
//
// 左右: セルの大きさに比例させる。固定値だとサムネイルを大きくしたとき相対的に
// 端に張り付き、小さくしたとき内側に浮いて見える。
//
// 上下: 左右より小さくする。セルは横長（16:9）なので、上下に左右と同じ値を使うと
// 「辺までの距離が枠に占める割合」が上下だけ約1.8倍になり、バッジが上下だけ
// 内側に浮いて見える。比率どおりに詰めると（左右の約0.56倍）隅に張り付きすぎるので、
// その手前で止めている。
const BADGE_INSET_X_RATIO = 6 / 160
const BADGE_INSET_Y_RATIO = BADGE_INSET_X_RATIO * 0.65

type BadgeInset = { x: number; y: number }

export function badgeInset(cellWidth: number): BadgeInset {
  const clamp = (value: number, min: number, max: number): number =>
    Math.round(Math.min(max, Math.max(min, value)))
  return {
    x: clamp(cellWidth * BADGE_INSET_X_RATIO, 4, 10),
    y: clamp(cellWidth * BADGE_INSET_Y_RATIO, 3, 7),
  }
}

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
  // overscrollBehavior は全モーダル共通で contain。前面に何か出している間、ホイールが
  // 背後の一覧やサイドバーへ渡って裏が動くのを止める（設定・変更点・確認ダイアログの
  // どれでも同じことが起きるので、器の側で 1 回だけ決める）。
  overlay: { position: 'fixed' as const, inset: 0, zIndex: 7000, overscrollBehavior: 'contain' as const, background: 'rgba(var(--scrim-rgb), 0.78)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
  panel: { width: 420, maxWidth: 'calc(100vw - 48px)', background: 'var(--bg-modal)', border: '1px solid var(--border-default)', borderRadius: radius.lg, boxShadow: '0 24px 70px rgba(var(--scrim-rgb), 0.62)', overflow: 'hidden' },
}

// サムネイル 1 枚の「絵より下と外」の合計。App.tsx が仮想リストの行の高さを出すのに使う。
// **ここを変えたら行の高さも自動で追従する。** 以前は App.tsx が別に 20 を持っていて、
// 実際の 22 とずれたうえ枠線 2px×2 も数えておらず、行の隙間が指定の 10px ではなく
// 4px しか空いていなかった（サムネが上下に詰まって見えていた原因）。
export const LABEL_HEIGHT = 22
export const THUMB_BORDER = 2
export const THUMB_CHROME = LABEL_HEIGHT + THUMB_BORDER * 2

export const s: Record<string, CSSProperties> = {
  updateBanner: { background: 'rgba(var(--success-rgb), 0.14)', borderBottom: '1px solid rgba(var(--success-rgb), 0.32)', padding: '10px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: font.base, color: 'var(--success)', flexShrink: 0 },
  updateBtn: { padding: '6px 14px', background: 'rgba(var(--success-rgb), 0.22)', border: '1px solid rgba(var(--success-rgb), 0.45)', borderRadius: radius.md, color: 'var(--success)', cursor: 'pointer', fontSize: font.sm, fontWeight: 700, whiteSpace: 'nowrap' as const },
  root: { display: 'flex', flex: 1, background: 'var(--bg-page)', color: 'var(--text-primary)', fontSize: font.base, overflow: 'hidden', userSelect: 'none' },
  // Sidebar+main だけを束ねるラッパー。ビューア（position:absolute, inset:0）はこの中だけを
  // 覆うので、隣の DetailPanel は最初からレイアウト上覆われずビューア表示中も操作できる（P1）。
  viewerHost: { position: 'relative' as const, display: 'flex', flex: 1, minWidth: 0 },
  sidebar: { background: 'var(--bg-well)', flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'visible', fontSize: font.base, position: 'relative' as const },
  // 掴める幅は見た目の線より広く取る（線は境界の 1px、当たり判定は 8px）。
  // 4px だと狙って掴む必要があり、掴めないと「動かせないパネル」に見える。
  // **境界線の真上に置く**（右へ 4px はみ出させて左右 4px ずつ）。内側だけに寄せると、
  // 掴める側とそうでない側ができて「片側からしか掴めない」感じになる。
  // はみ出させるため sidebar 側の overflow は visible（中身は sidebarScroll が自前で切る）。
  sidebarResizeHandle: { position: 'absolute' as const, right: -4, top: 0, bottom: 0, width: 8, cursor: 'col-resize', zIndex: 10, userSelect: 'none' as const },
  sidebarScroll: { flex: 1, minHeight: 0, overflowY: 'auto' as const, padding: '16px 12px 12px' },
  // 「Shiori ◯枚」の下は大きく空ける。**アプリの名前と中身の一覧をくっつけない。**
  // ここが詰まると、スマートフォルダやタグの見出しがアプリ名にぶら下がった小見出しに
  // 見えて、どこからが中身か読めなくなる。
  // なお**この値と、下に続く siteGroup の marginTop は足し算にならない**（隣り合う
  // 上下マージンは大きいほうだけが残る）。12 と 16 で 28px 空けているつもりが 16px だった。
  // ここを縮めても siteGroup の 16px より下には行かないので、詰めたいときは両方を見ること。
  sidebarHeaderRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.x24 },
  sidebarBrand: { minWidth: 0, display: 'flex', alignItems: 'center', gap: space.x8 },
  sidebarIcon: { flexShrink: 0, borderRadius: radius.md, display: 'block' },
  sidebarBrandName: { color: 'var(--text-primary)', fontSize: font.sm, fontWeight: 800, letterSpacing: 0 },
  count: { color: 'var(--text-secondary)', fontSize: font.sm, fontWeight: 700 },
  main: { flex: 1, overflowY: 'scroll', scrollbarGutter: 'stable' as const, padding: '0 20px 18px', position: 'relative', display: 'flex', flexDirection: 'column' as const, gap: space.x16, background: 'var(--bg-content)' },
  // ドロップ受け口はウィンドウ全体なので、枠も端まで詰める（inset/角丸を入れると
  // 「枠の外側は受け付けない」ように見えてしまうが、実際はそこも受け付ける）。
  dropOverlay: { position: 'absolute' as const, inset: 0, zIndex: 400, pointerEvents: 'none' as const, background: 'rgba(var(--accent-rgb), 0.12)', border: '2px dashed rgba(var(--accent-rgb), 0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  dropOverlayText: { fontSize: font.lg, fontWeight: 800, color: 'var(--accent-text)', background: 'rgba(var(--scrim-rgb), 0.6)', padding: '10px 20px', borderRadius: radius.md },
  stickyHeader: { position: 'sticky' as const, top: 0, zIndex: 200, background: 'var(--bg-content)', borderBottom: '1px solid var(--border-soft)', margin: '0 -20px', padding: '12px 20px 9px', display: 'flex', flexDirection: 'column' as const, gap: space.x8 },
  searchBar: { display: 'flex', alignItems: 'center', gap: space.x8 },
  searchInputWrap: { position: 'relative' as const, flex: '1 1 360px', display: 'flex', alignItems: 'center', flexWrap: 'wrap' as const, gap: space.x4, minWidth: 260, minHeight: control.lg, background: 'rgba(var(--surface-rgb), 0.72)', border: '1px solid rgba(var(--hairline-rgb), 0.72)', borderRadius: radius.md, padding: '3px 24px 3px 8px', boxShadow: 'inset 0 1px 0 rgba(var(--text-rgb), 0.035)' },
  searchInputInner: { flex: '1 1 100px', position: 'relative' as const, display: 'flex', alignItems: 'center', height: control.sm, minWidth: 100 },
  searchInput: { flex: 1, minWidth: 0, background: 'transparent', border: 'none', color: 'var(--text-primary)', padding: 0, fontSize: font.sm, outline: 'none' },
  sortBtn: { height: control.md, padding: '0 10px', background: 'transparent', border: 'none', borderLeft: '1px solid rgba(var(--hairline-rgb), 0.44)', color: 'var(--text-primary)', fontSize: font.sm, cursor: 'pointer', whiteSpace: 'nowrap' as const },
  sortMenu: { position: 'absolute' as const, top: 'calc(100% + 4px)', left: 0, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, padding: 4, zIndex: 500, boxShadow: '0 8px 24px rgba(var(--scrim-rgb), 0.5)', minWidth: 100 },
  sortMenuItem: { display: 'block', width: '100%', padding: '6px 10px', background: 'none', border: 'none', borderRadius: radius.md, color: 'var(--text-primary)', fontSize: font.sm, cursor: 'pointer', textAlign: 'left' as const, whiteSpace: 'nowrap' as const },
  sortMenuItemActive: { background: 'rgba(var(--accent-rgb), 0.18)', color: 'var(--accent-text)' },
  viewToggle: { position: 'relative' as const, display: 'flex', alignItems: 'center' },
  viewToggleBtn: { position: 'relative' as const, zIndex: 1, width: 38, height: control.lg, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', borderRadius: radius.md, color: 'var(--text-secondary)', cursor: 'pointer' },
  thumbSizeControl: { position: 'relative' as const, display: 'flex', alignItems: 'center' },
  thumbSizeBtn: { position: 'relative' as const, zIndex: 1, width: 34, height: control.lg, background: 'none', border: 'none', borderRadius: radius.md, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: font.xs, fontWeight: 700, padding: 0 },
  controlDivider: { flexShrink: 0, width: 1, alignSelf: 'stretch' as const, margin: '5px 3px', background: 'rgba(var(--hairline-rgb), 0.4)' },
  // セグメントコントロール（S/M/L・グリッド/タイムライン）の選択中ハイライト。
  // ボタン背面で transform:translateX して選択先へスライドする（「今こう変えた」を伝える）。
  segActive: { color: 'var(--accent-text)' },
  segSlider: { position: 'absolute' as const, top: 1, left: 1, height: control.md, borderRadius: radius.md, background: 'rgba(var(--accent-rgb), 0.42)', boxShadow: 'inset 0 0 0 1px rgba(var(--accent-rgb), 0.6), 0 1px 3px rgba(var(--scrim-rgb), 0.35)', pointerEvents: 'none' as const, zIndex: 0, transition: 'transform 0.22s cubic-bezier(.22,1,.36,1), width 0.22s cubic-bezier(.22,1,.36,1)' },
  searchIcon: { flexShrink: 0, width: 14, height: 14, color: 'var(--text-secondary)', pointerEvents: 'none' as const },
  searchSpinner: { flexShrink: 0, width: 14, height: 14, color: 'var(--text-secondary)', pointerEvents: 'none' as const, animation: 'shioriSpin 0.7s linear infinite' },
  searchPrefixMenu: { position: 'absolute' as const, top: 'calc(100% + 1px)', left: -1, right: -1, zIndex: 201, background: 'rgba(var(--surface-rgb), 0.97)', border: '1px solid rgba(var(--hairline-rgb), 0.58)', borderRadius: radius.md, padding: '4px 0', boxShadow: '0 6px 14px rgba(var(--scrim-rgb), 0.4)' },
  searchPrefixItem: { display: 'flex', alignItems: 'center', gap: space.x8, width: '100%', minHeight: control.md, padding: '6px 12px', background: 'none', border: 'none', color: 'var(--text-primary)', fontSize: font.sm, cursor: 'pointer', textAlign: 'left' as const },
  searchDateHint: { padding: '6px 12px', color: 'var(--text-secondary)', fontSize: font.sm },
  searchDateWarning: { padding: '6px 12px', color: 'var(--warning)', fontSize: font.xs },
  searchWrapClear: { position: 'absolute' as const, right: 4, top: '50%', transform: 'translateY(-50%)', background: 'rgba(var(--hairline-rgb), 0.22)', border: '1px solid rgba(var(--hairline-rgb), 0.32)', color: 'var(--text-primary)', cursor: 'pointer', padding: '4px 6px', lineHeight: 1, borderRadius: radius.md, display: 'flex', alignItems: 'center' },
  smartFolderEmpty: { fontSize: font.sm, color: 'var(--text-secondary)', padding: '3px 0 2px', lineHeight: 1.5 },
  smartFolderCreateInput: { flex: 1, minWidth: 0, height: control.lg, background: 'var(--bg-content)', border: '1px solid var(--border-strong)', borderRadius: radius.md, color: 'var(--text-primary)', padding: '0 9px', fontSize: font.sm, fontWeight: 700, outline: 'none', boxSizing: 'border-box' as const },
  smartFolderAddIconBtn: { width: control.lg, height: control.lg, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--success-rgb), 0.12)', border: '1px solid rgba(var(--success-rgb), 0.42)', borderRadius: radius.md, color: 'var(--success)', cursor: 'pointer', padding: 0, fontSize: 14, fontWeight: 900, lineHeight: 1, boxSizing: 'border-box' as const },
  // 見出しの「＋」は、フォルダの行より一段小さくする。同じ大きさにすると、見出しの帯が
  // 行と同じ厚みになって「もう 1 行あるように」見える。見出しの中で一番大きいものが
  // これなので、ここの大きさが見出しの帯の高さをそのまま決める。
  // （作成中に入力欄の隣へ出る smartFolderAddIconBtn は別物。あちらは入力欄と同じ control.lg）
  smartFolderHeaderAddBtn: { width: control.md, height: control.md, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--success-rgb), 0.12)', border: '1px solid rgba(var(--success-rgb), 0.42)', borderRadius: radius.md, color: 'var(--success)', cursor: 'pointer', padding: 0, boxSizing: 'border-box' as const },
  smartFolderHeaderAddBtnDisabled: { background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-muted)', cursor: 'default' },
  smartFolderCreateInputRow: { display: 'flex', gap: space.x4, width: '100%' },
  grid: { width: '100%', userSelect: 'none', position: 'relative' as const },
  selectionBox: { position: 'absolute' as const, border: '1px solid var(--accent)', background: 'rgba(var(--accent-rgb), 0.12)', pointerEvents: 'none' as const, zIndex: 20, boxSizing: 'border-box' as const },
  thumb: { position: 'relative' as const, display: 'flex', flexDirection: 'column' as const, background: 'var(--bg-surface)', border: '2px solid var(--border-default)', borderRadius: radius.md, width: '100%', cursor: 'pointer', boxShadow: '0 1px 0 rgba(var(--text-rgb), 0.035)' },
  // 上側の角はカードの内側の丸みに合わせる（カードの角丸 - 枠線 2px）。四角いままだと
  // 角の三角形だけカードの地が覗き、選択枠を出したときに「枠と絵がずれている」ように見える。
  thumbImgWrap: { position: 'relative', width: '100%', aspectRatio: '16/9', overflow: 'hidden', flexShrink: 0, borderRadius: `${radius.md - 2}px ${radius.md - 2}px 0 0` },
  // 縦長画像（Shorts等）は16:9セルからはみ出るため cover→contain に切り替え、
  // 余白は viewer と同様に画像鑑賞用途として意図的に非テーマの暗色で埋める
  thumbImgWrapVertical: { background: '#0d0d0d' },
  thumbVideoPlay: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.95)', fontSize: 28, pointerEvents: 'none', textShadow: '0 6px 20px rgba(0,0,0,0.7)' },
  thumbVideoDuration: { position: 'absolute', right: 6, top: 6, zIndex: 3, color: '#fff', fontSize: font.xs, fontWeight: 800, background: 'rgba(6,8,12,0.82)', padding: '2px 6px', borderRadius: radius.sm, pointerEvents: 'none', fontVariantNumeric: 'tabular-nums' },
  thumbHovered: { border: '2px solid var(--border-strong)', background: 'var(--bg-surface-hover)' },
  // 選択は**タイルそのものを染める。** 枠線の色も変わるが、太さは未選択と同じ 2px のまま。
  // エクスプローラーや Finder と同じで、一覧の中で選んだ項目は「地が塗られている」のが定番。
  // 絵で隠れていない部分（枠の内側と下の題名の帯）が染まるので、離れて見ても分かる。
  // **太さを変えるときは未選択・ホバー・選択・NEW・スケルトンを必ず同じ値で動かすこと。**
  // 選択時だけ太くすると、その 1 枚だけ絵が縮んで枠の内側へ沈む。
  //
  // 過去に3回外している。(1) 線を外側（outline）だけに出したら、内側に残った灰色の
  // 枠線が「アクセントの線 → 灰色 1px → 絵」となり、枠が絵から浮いて見えた。
  // (2) それを消そうと内側の枠線にも色を付けたら、外側 1.5px + 内側 1px で枠が 2.5px に
  // 太り、今度は絵が枠の内側に沈んで見えた。**太さを変えた時点で負け。**
  // (3) 枠の外にもう 1 本淡い輪を足して視認性を稼いだ。二重の輪は本来キーボードの
  // フォーカス表示の手法で、一覧の選択に使うものではない（フォーカス枠と役割が被る）。
  thumbSelected: { border: '2px solid rgba(var(--accent-rgb), 0.72)', background: 'rgba(var(--accent-rgb), 0.18)' },
  // 染めた地の上でも読めるよう選択中は一段だけ明るくする。
  thumbLabelSelected: { color: 'var(--text-primary)' },
  // 新着 NEW（ウィンドウ表示後の数秒だけ）。選択（インディゴ）と区別できる緑系アクセント。
  thumbNew: { border: '2px solid rgba(var(--success-rgb), 0.9)', boxShadow: '0 0 0 2px rgba(var(--success-rgb), 0.3)', animation: 'shioriNewPulse 1.6s ease-in-out infinite' },
  // NEW表示が外れる瞬間（リング/グローをふわっとフェードアウト）
  thumbNewExit: { boxShadow: '0 0 0 2px rgba(var(--success-rgb), 0)', transition: 'border-color 0.9s ease, box-shadow 0.9s ease' },
  // バッジ自体は彩度の高い緑グラデーション地に固定文字色で、どちらのテーマでも
  // そのまま視認できるため意図的にテーマ非依存（var化しない）。
  thumbNewBadge: { position: 'absolute', top: 6, left: 6, zIndex: 4, color: '#04130d', fontSize: font.xs, fontWeight: 900, letterSpacing: 0.5, background: 'linear-gradient(135deg, #6ef0bd, #36c98f)', padding: '2px 7px', borderRadius: radius.sm, pointerEvents: 'none', boxShadow: '0 2px 8px rgba(54,201,143,0.45)' },
  thumbNewBadgeExit: { position: 'absolute', top: 6, left: 6, zIndex: 4, color: '#04130d', fontSize: font.xs, fontWeight: 900, letterSpacing: 0.5, background: 'linear-gradient(135deg, #6ef0bd, #36c98f)', padding: '2px 7px', borderRadius: radius.sm, pointerEvents: 'none', boxShadow: '0 2px 8px rgba(54,201,143,0.45)', animation: 'shioriNewBadgeOut 0.9s ease forwards' },
  // 「選択されていないのに、次のキー操作の起点になっている 1 枚」の目印（呼び出し側で
  // focused && !selected の時だけ重ねる）。矢印キーでの移動は選択とフォーカスが常に同じ
  // セルを指すため、選択ハイライトと二重表示すると常時点灯してうるさくなる。
  // いま食い違うのは、Ctrl+クリックで選択から外した 1 枚と、範囲選択で選択が別の場所へ
  // 移った後の 2 つ（Ctrl+矢印は廃止した。useSelection の GRID_NAV_KEYS 節を参照）。
  //
  // **選択と同じ形（枠の色＋タイルの地）にして、色だけ変える。** 以前はタイルの 3px 外側に
  // 白い輪を別要素で描いていた。選択が「タイルを染める」形になったあとは、輪と塗りという
  // 別の言語が 1 つの一覧に並ぶことになり、同じ「今どこ」を指す印なのに読み方が 2 通りあった。
  // いまは 選ばれている＝アクセント色 / 起点なだけ＝無彩色、と色だけで読ませる。
  // 別要素をやめて同じ要素に重ねられるのは、focused && !selected が呼び出し側の条件で
  // 保証されていて、selected の枠色と衝突しないため（spread の順序も selected が後）。
  // 濃さは控えめに。アクセントが彩度の低い藍なので、無彩色でも濃いと選択中と見分けが
  // つかない。ただしホバーの枠（--border-strong）まで落とすと今度はホバーと紛れる。
  thumbFocused: { border: '2px solid rgba(var(--text-rgb), 0.45)', background: 'rgba(var(--text-rgb), 0.055)' },
  thumbImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block', transition: 'opacity 0.15s ease' },
  thumbImgVertical: { objectFit: 'contain' as const },
  // サムネが読めなかったとき。**無地で済ませない**——ファイルが消えたのか読み込み中なのかが
  // 画面から分からず、黙って欠けた状態になる。一番小さいセル（横120px）では文字が折り返す。
  thumbFallback: { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 8px', boxSizing: 'border-box' as const, background: 'linear-gradient(135deg, var(--bg-surface), var(--bg-page))' },
  thumbFallbackText: { color: 'var(--text-muted)', fontSize: font.xs, fontWeight: 700, textAlign: 'center' as const, lineHeight: 1.35 },
  // 題名は本文より一段落とす（--text-label）。以前は --text-secondary で、サムネイルを
  // 大きくしてからは薄すぎて読めなかった。逆に本文と同じ濃さまで上げると明るすぎる
  // （ダークで一度そこまで寄って、題名だけが主張して見えた。global.css の --text-label 参照）。
  // 選択中はさらに一段明るくするので（thumbLabelSelected）、濃さの段は 2 つ残る。
  thumbLabel: { height: LABEL_HEIGHT, lineHeight: `${LABEL_HEIGHT}px`, fontSize: font.xs, fontWeight: 700, color: 'var(--text-label)', padding: '0 6px', boxSizing: 'border-box', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  thumbLabelHighlight: { background: 'rgba(var(--warning-rgb), 0.32)', color: 'var(--warning)', borderRadius: radius.sm, padding: '0 1px' },
  // 初回ロード中（まだ1枚も届いていない）に実グリッドと同じ寸法で敷くプレースホルダ。
  // 以前はここが完全な空白で、画面下の「読み込み中...」だけが手掛かりだった。
  skeletonCell: { background: 'var(--bg-surface)', border: '2px solid var(--border-default)', borderRadius: radius.md, animation: 'shioriSkeletonPulse 1.4s ease-in-out infinite' },
  empty: { color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column' as const, gap: space.x12, alignItems: 'center', justifyContent: 'center', textAlign: 'center' as const, width: '100%', minHeight: 'calc(100vh - 190px)' },
  emptyTitle: { color: 'var(--text-primary)', fontSize: font.xl, fontWeight: 700 },
  emptySteps: { display: 'flex', flexDirection: 'column' as const, gap: space.x4, color: 'var(--text-secondary)', fontSize: font.base, lineHeight: 1.6, textAlign: 'left' as const },
  emptyActions: { display: 'flex', gap: space.x8, flexWrap: 'wrap' as const, justifyContent: 'center' },
  emptyBtn: { padding: '7px 14px', background: 'rgba(var(--accent-rgb), 0.16)', border: '1px solid rgba(var(--accent-rgb), 0.4)', borderRadius: radius.md, color: 'var(--accent-text)', cursor: 'pointer', fontSize: font.base, fontWeight: 700 },
  emptyBtnSub: { background: 'transparent', color: 'var(--text-secondary)', borderColor: 'var(--border-strong)' },
  emptyHint: { color: 'var(--text-secondary)', fontSize: font.sm, marginTop: 4 },
  // 空画面に段落を置くとき用（Web デモ版の説明）。emptyHint は一言用で幅の指定が無く、
  // 数行の文章を入れるとグリッド幅いっぱいに伸びて 1 行が長くなりすぎる。
  emptyLead: { color: 'var(--text-secondary)', fontSize: font.base, lineHeight: 1.75, maxWidth: 520, textAlign: 'center' as const },
  loadingMore: { textAlign: 'center', padding: 16, color: 'var(--text-secondary)', fontSize: font.base },
  filterBtn: { background: 'none', border: 'none', borderRadius: radius.md, cursor: 'pointer', fontSize: font.base, textAlign: 'left' as const, padding: '6px 8px' },
  // スマートフォルダの 1 行。**これ以上小さくしない。** 縦に詰めたくて一番小さい段
  // （control.sm）まで落としたことがあるが、行が痩せて別物になっただけだった。
  // 実際に縦を食っていたのは行の大きさではなく、行の前に常に置いてある挿入線
  // （smartFolderInsertLine）が無条件に 6px 取っていたことと、游ゴシックの行送り。
  // 箱と ✕ の間は詰めすぎない。2px まで詰めたら ✕ が箱に貼り付いて、箱の一部なのか
  // 別のボタンなのか読めなかった。
  smartFolderRow: { width: '100%', minWidth: 0, display: 'flex', alignItems: 'center', gap: space.x4, cursor: 'grab' },
  smartFolderRowDragging: { position: 'relative' as const, zIndex: 5, opacity: 0.85, background: 'var(--bg-surface-hover)', border: '1px solid var(--border-strong)', borderRadius: radius.md, boxShadow: '0 10px 24px rgba(var(--scrim-rgb), 0.5)', cursor: 'grabbing' },
  // 並べ替え中に「ここに入る」を示す線。**場所を取らせない。**
  // 各行の前に 1 本ずつ常に置いてあり、ふだんは opacity: 0 で見えないだけ。以前は
  // height 2 + margin 2px 上下 = 1 行につき 6px を無条件に消費していて、行間の指定が
  // 2px でも実際には 10px 空いていた（「高さを下げても詰まらない」の残りの原因）。
  // 上下の margin を半分ずつ負にして、占める高さを差し引きゼロにする。線が出るときは
  // 隣の行へ 1px ずつ食い込むが、行の間に引く線なので見え方は変わらない。
  smartFolderInsertLine: { height: 2, margin: '-1px 0', borderRadius: radius.sm, background: 'var(--accent)', boxShadow: '0 0 0 1px rgba(var(--accent-rgb), 0.18)', transition: 'opacity .08s ease' },
  smartFolderBtn: { flex: 1, minWidth: 0, minHeight: control.lg, display: 'flex', alignItems: 'center', gap: space.x8, padding: '6px 10px', background: 'rgba(var(--surface-rgb), 0.48)', border: '1px solid var(--border-default)', borderRadius: radius.md, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: font.sm, fontWeight: 800, textAlign: 'left' as const, overflow: 'hidden', boxSizing: 'border-box' as const, transition: 'background 0.12s ease, border-color 0.12s ease, color 0.12s ease' },
  smartFolderDeleteBtn: { width: control.lg, height: control.lg, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', borderRadius: radius.md, color: 'var(--text-secondary)', cursor: 'pointer', padding: 0, lineHeight: 1 },
  smartFolderActive: { background: 'rgba(var(--accent-rgb), 0.14)', border: '1px solid rgba(var(--accent-rgb), 0.46)', color: 'var(--accent-text)' },
    // セクションどうしの間。8px まで詰めたら上の見出し（Shiori ◯枚）と地続きに見えた。
  // サイドバーのセクション（スマートフォルダ・タグ）の中身の並び。
  // **枠のある箱を縦に並べるところなので、素の一覧の行間より広く取る。** 2px だった頃は
  // スマートフォルダが 1 つの大きな箱に横線が入っているように見え、どこからどこまでが
  // 1 つのフォルダか読めなかった（箱と箱の間より、箱の中の上下の余白のほうが広かった）。
  // 見出しと中身の間もこの値が効くが、見出しは自前の marginBottom を持っているので
  // 足して 10px 前後になり、小見出しとその中身の間隔（x12）の手前に収まる。
  siteGroup: { display: 'flex', flexDirection: 'column' as const, gap: space.x6, marginTop: space.x16 },
    // **lineHeight を 1 にする。** 見出しの文字と右端のボタンは大きさが違うので、
  // 上下中央で揃える（呼び出し側が alignItems: center を付けている）。ただし游ゴシックは
  // 上下の余白が非対称で、既定の行送りのままだと行の箱の中で文字が上寄りに座る。
  // 箱を中央に置いても文字は中央に見えない。行の箱を文字にぴったり合わせて初めて揃う。
  siteGroupLabel: { fontSize: font.xs, lineHeight: 1, color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: 0.8, marginBottom: space.x4, fontWeight: 800 },
  tagLabelActions: { display: 'flex', alignItems: 'center', gap: space.x8 },
  tagModeBtn: { minWidth: 28, height: control.md, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--surface-rgb), 0.72)', border: '1px solid var(--border-default)', borderRadius: radius.md, cursor: 'pointer', fontSize: 11, fontWeight: 800, padding: '0 6px', lineHeight: 1 },
  tagClearBtn: { width: control.md, height: control.md, padding: 0, justifyContent: 'center', color: 'var(--text-secondary)', lineHeight: 1 },
  searchSuggestions: { position: 'absolute' as const, top: 'calc(100% + 1px)', left: -1, right: -1, zIndex: 201, background: 'rgba(var(--surface-rgb), 0.97)', border: '1px solid rgba(var(--hairline-rgb), 0.58)', borderRadius: radius.md, padding: '4px 0', boxShadow: '0 6px 14px rgba(var(--scrim-rgb), 0.4)', maxHeight: 200, overflowY: 'auto' as const },
  searchSuggestionItem: { display: 'flex', alignItems: 'center', gap: space.x8, width: '100%', minHeight: control.md, padding: '6px 12px', background: 'none', border: 'none', color: 'var(--text-primary)', fontSize: font.sm, cursor: 'pointer', textAlign: 'left' as const, whiteSpace: 'nowrap' as const, overflow: 'hidden' },
  searchSuggestionItemActive: { background: 'rgba(var(--accent-rgb), 0.18)', color: 'var(--accent-text)' },
  searchSuggestionPlain: { minWidth: 0, color: 'var(--text-secondary)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  searchSuggestionValue: { flex: '0 1 132px', minWidth: 54, maxWidth: '52%', color: 'var(--text-secondary)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  searchSuggestionMeta: { flex: '1 1 auto', minWidth: 0, color: 'var(--text-secondary)', fontSize: font.sm, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  searchSuggestionEmpty: { minHeight: control.md, padding: '6px 12px', color: 'var(--text-secondary)', fontSize: font.sm, display: 'flex', alignItems: 'center' },
  searchHistoryHeader: { padding: '4px 12px 2px', color: 'var(--text-muted)', fontSize: 10, fontWeight: 700, letterSpacing: '0.03em' },
  searchPrefixDivider: { height: 1, margin: '4px 0', background: 'rgba(var(--hairline-rgb), 0.22)' },
  searchHistoryRemove: { flexShrink: 0, marginLeft: 'auto', display: 'flex', alignItems: 'center', padding: 4, color: 'var(--text-muted)', borderRadius: radius.md },
    // **上下と左右で違う値を使う。** チップは横に並んで折り返すので、左右は詰めたほうが
  // 1 行に多く入る。上下を同じだけ詰めると行同士がくっついて塊に見える。
  sidebarTagList: { display: 'flex', flexWrap: 'wrap' as const, rowGap: space.x6, columnGap: space.x4 },
  sidebarTagChip: { maxWidth: '100%', minHeight: control.md, display: 'inline-flex', alignItems: 'center', gap: space.x4, padding: '6px 11px', background: 'rgba(var(--surface-rgb), 0.6)', border: '1px solid var(--border-default)', borderRadius: 999, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: font.sm, fontWeight: 700, textAlign: 'left' as const, overflow: 'hidden', whiteSpace: 'nowrap' as const, transition: 'background 0.12s ease, border-color 0.12s ease, color 0.12s ease' },
  sidebarTagChipText: { display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  // **由来は色、選択は塗りつぶし。** 手動=緑、AI=灰（無彩色）で、これは選んでいても
  // 変わらない。選んだかどうかは「地が塗ってあるか」で読む——非選択は地が完全に透明で
  // 点線の枠だけ、選択は地をしっかり塗って枠も実線になる。
  //
  // 一度は「非選択は由来にかかわらず無彩色」にしたが、そうすると由来を枠線の色だけが
  // 背負うことになり、手動と AI が見分けられなくなった。逆に濃さだけで選択を示していた
  // 頃（非選択も選択も緑で、地の濃さが 0.05 と 0.18）は、選択が読めなかった。
  // **同じ手掛かりに 2 つの意味を持たせないこと。** 色＝由来、塗り＝選択で分けてある。
  //
  // AI に藍を持たせないのは、藍がアクセント色（選択・フォーカス・進捗・CTA）で、
  // AI タグを常時その色にすると「AI がこのアプリの主役」に見えていたため。
  sidebarTagChipManual: { background: 'transparent', border: '1px dashed rgba(var(--success-rgb), 0.5)', color: 'var(--tag-manual)' },
  sidebarTagChipActive: { background: 'rgba(var(--success-rgb), 0.3)', border: '1px solid rgba(var(--success-rgb), 0.75)', color: 'var(--tag-manual)' },
  sidebarTagChipAi: { background: 'transparent', border: '1px dashed var(--border-strong)', color: 'var(--text-secondary)' },
  sidebarTagChipAiActive: { background: 'rgba(var(--accent-rgb), 0.3)', border: '1px solid rgba(var(--accent-rgb), 0.75)', color: 'var(--accent-text)' },
  // TagEditor と DetailPanel の一括編集で同一定義が重複していたタグチップ／追加ボタン（C-2）。
  // 色 = 由来（緑=手動 / 灰=AI）を単一/一括/サイドバーで一貫させるため、AI版もここへ集約。
  tagChipManual: { display: 'inline-flex', alignItems: 'center', padding: '5px 10px', background: 'rgba(var(--success-rgb), 0.12)', border: '1px solid rgba(var(--success-rgb), 0.45)', borderRadius: 999, color: 'var(--tag-manual)', fontSize: font.sm, fontWeight: 700, userSelect: 'text' as const },
  tagChipAi: { display: 'inline-flex', alignItems: 'center', padding: '5px 10px', background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 999, color: 'var(--text-secondary)', fontSize: font.sm, fontWeight: 700, userSelect: 'text' as const },
  addTagChip: { height: control.lg, boxSizing: 'border-box' as const, display: 'inline-flex', alignItems: 'center', padding: '0 12px', background: 'transparent', border: '1px dashed var(--border-strong)', borderRadius: 999, color: 'var(--text-secondary)', fontSize: font.sm, fontWeight: 700, cursor: 'pointer', lineHeight: 1 },
  sidebarMoreBtn: { alignSelf: 'flex-start', marginTop: 2, padding: '3px 4px', background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: font.xs, fontWeight: 800 },
  sidebarUtilitySection: { flexShrink: 0, padding: '10px 14px 12px', borderTop: '1px solid var(--border-inset)', background: 'var(--bg-inset)', display: 'flex', flexDirection: 'column' as const, gap: space.x8 },
  // サイドバー下部（セットアップ・サイズ・表示切替・設定）は毎日押すものではないのに、
  // 面と枠を持っていて上のスマートフォルダやタグ一覧より目立っていた。地と枠を外す。
  // セットアップだけは未完了のときに面を持たせる（済んだら普通のリンクまで落ちる）。
  // 下部の 3 つは**枠だけ描く。地は塗らない。** 枠も地も透明だと押せるものが宙に浮くが、
  // 地まで塗ると、帯の上に明るい箱が 3 つ乗って面の数が増える（ライトでは白地に白い箱で、
  // 押せる場所と押せない場所の差だけが目立つ）。枠 1 本で「押せる」は伝わる。
  //
  // **線の濃さは default と strong の中間（--border-inset）。** この帯は --bg-inset で
  // 一段沈めてあるため、--border-default をそのまま置くと沈んだ地との差が足りず、
  // --border-strong まで上げると 3 つ並んだ枠が主張して帯が騒がしくなる。
  // 以前は --border-rgb を 0.8 で薄めて中間を作っていたが、薄めた枠は乗っている地に
  // 混ざるので、ライトでは明るい地に溶けて消えていた（global.css の --border-inset 参照）。
  sidebarSetupBtn: { alignSelf: 'center', width: 192, minHeight: control.lg, boxSizing: 'border-box' as const, display: 'flex', alignItems: 'center', gap: space.x8, padding: '6px 10px', background: 'transparent', border: '1px solid var(--border-inset)', borderRadius: radius.md, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: font.sm, fontWeight: 600, textAlign: 'left' as const },
  sidebarSetupBtnTodo: { background: 'rgba(var(--surface-rgb), 0.52)', border: '1px solid var(--border-default)', fontWeight: 700 },
  sidebarSetupMark: { flexShrink: 0, width: 19, height: 19, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 999, background: 'rgba(var(--accent-rgb), 0.14)', border: '1px solid rgba(var(--accent-rgb), 0.42)', color: 'var(--accent-text)', fontSize: 10, fontWeight: 900 },
  sidebarSetupMarkDone: { background: 'rgba(var(--success-rgb), 0.12)', borderColor: 'rgba(var(--success-rgb), 0.4)', color: 'var(--success)' },
  sidebarControls: { flexShrink: 0, alignSelf: 'center', width: 192, display: 'inline-flex', alignItems: 'stretch', justifyContent: 'center', gap: 0, boxSizing: 'border-box' as const, background: 'transparent', border: '1px solid var(--border-inset)', borderRadius: radius.md, padding: 2 },
  sidebarBottom: { flexShrink: 0, alignSelf: 'center', width: 192, boxSizing: 'border-box' as const, display: 'flex', gap: space.x4 },
  gearBtn: { flex: 1, height: control.lg, boxSizing: 'border-box' as const, background: 'transparent', border: '1px solid var(--border-inset)', borderRadius: radius.md, cursor: 'pointer', padding: '0 11px', display: 'flex', alignItems: 'center', gap: space.x8, justifyContent: 'flex-start', transition: 'color 0.12s ease' },
  shortcutsBtn: { flex: 'none', width: 34, padding: 0, justifyContent: 'center' },
  // 設定ボタンの下に置く小さなリンク列（変更点・不具合報告）。常に見えることが目的なので
  // 隠さないが、毎回押すものではないので文字サイズと色で視線の重さを下げる。
  // **リンクは単語の途中で折らない。** 幅 192px にリンクが 2〜3 個並ぶので、放っておくと
  // 「不具合・要望を報／告」のように行の途中で切れる。1 個ずつを塊として扱い、入らなければ
  // 塊ごと次の行へ送る（rowGap を入れて 2 行になっても読めるようにしてある）。
  sidebarLinks: { flexShrink: 0, alignSelf: 'center', width: 192, boxSizing: 'border-box' as const, display: 'flex', flexWrap: 'wrap' as const, alignItems: 'center', justifyContent: 'center', columnGap: space.x4, rowGap: space.x2, paddingTop: 6 },
  sidebarLink: { padding: 0, background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: font.xs, fontFamily: 'inherit', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', whiteSpace: 'nowrap' as const },
  // リンクの区切り。**文字ではなく細い縦線。** 「・」を使うと「不具合・要望を報告」の
  // 中の「・」と同じ形になり、2 つのリンクが 3 つに見える。
  sidebarLinkSep: { width: 1, height: 10, background: 'rgba(var(--hairline-rgb), 0.6)' },
  sidebarXBtn: { background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0 0 0 4px', lineHeight: 1, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  // 通知と進捗タスクを同じ下中央スタックにまとめる。完了通知と進行中タスクが
  // 別デザインで重なる状態を避けつつ、視線移動が少ない位置に出す。
  // zIndex はアプリ内の最前面（モーダル/フライアウト/ビューアより上）に固定する。
  // 動画トリミング(6000)やタグ入力(6100)、確認ダイアログ(7000)の裏で通知が
  // 見えなくなるのを防ぐため。
  toastStack: { position: 'fixed' as const, left: '50%', bottom: 16, transform: 'translateX(-50%)', zIndex: 8000, width: 'max-content', maxWidth: 'calc(100vw - 36px)', display: 'flex', flexDirection: 'column' as const, alignItems: 'center' as const, gap: space.x8, pointerEvents: 'none' as const },
  // トースト/タスクカードもテーマに従う。以前はライトでも黒い地に白文字で固定しており、
  // 明るい画面で通知が出た瞬間だけ別のアプリが顔を出したように見えていた。
  // 「浮いている」ことは色ではなく、枠と濃い影とぼかしで出す（溶け込ませない目的は同じ）。
  notificationCard: { position: 'relative' as const, display: 'flex', alignItems: 'stretch', gap: space.x8, width: 'max-content', maxWidth: 'min(380px, calc(100vw - 36px))', minHeight: 40, padding: '10px 14px 10px 18px', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, boxShadow: '0 12px 32px rgba(var(--scrim-rgb), 0.42), 0 2px 8px rgba(var(--scrim-rgb), 0.3)', backdropFilter: 'blur(10px)', pointerEvents: 'auto' as const, overflow: 'hidden', animation: 'shioriToastIn 0.22s ease-out', color: 'var(--text-primary)' },
  toastIndicator: { position: 'absolute' as const, left: 0, top: 0, bottom: 0, width: 4, flexShrink: 0, background: 'var(--text-secondary)' },
  toastBody: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.x12 },
  toastMessage: { minWidth: 0, color: 'var(--text-primary)', fontSize: font.sm, fontWeight: 800, lineHeight: 1.45, whiteSpace: 'normal' as const, wordBreak: 'break-word' as const },
  toastActionBtn: { flexShrink: 0, height: control.lg, padding: '0 12px', background: 'rgba(var(--text-rgb), 0.08)', border: '1px solid rgba(var(--text-rgb), 0.18)', borderRadius: radius.md, color: 'var(--text-primary)', cursor: 'pointer', fontSize: font.sm, fontWeight: 800, whiteSpace: 'nowrap' as const },
  toastInfo: {},
  toastSuccess: {},
  toastWarning: {},
  toastError: {},
  toastInfoMark: { background: 'var(--accent)' },
  toastSuccessMark: { background: 'var(--success)' },
  toastWarningMark: { background: 'var(--warning)' },
  toastErrorMark: { background: color.danger },
  taskToast: { width: 'min(340px, calc(100vw - 36px))', flexDirection: 'column' as const, gap: space.x8 },
  taskHeader: { display: 'flex', alignItems: 'center', gap: space.x8 },
  taskLabel: { flex: 1, minWidth: 0, color: 'var(--text-primary)', fontSize: font.sm, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  taskBarTrack: { width: '100%', height: 4, background: 'rgba(var(--text-rgb), 0.14)', borderRadius: 999, overflow: 'hidden' },
  taskFill: { height: '100%', background: 'var(--accent)', borderRadius: 999, transition: 'width 0.25s ease' },
  taskDetail: { flexShrink: 0, color: 'var(--text-secondary)', fontSize: font.xs, fontWeight: 800, fontVariantNumeric: 'tabular-nums' as const },
  taskCancelBtn: { flexShrink: 0, height: control.lg, padding: '0 12px', background: 'rgba(var(--text-rgb), 0.08)', border: '1px solid rgba(var(--text-rgb), 0.18)', borderRadius: radius.md, color: 'var(--text-primary)', cursor: 'pointer', fontSize: font.sm, fontWeight: 800, whiteSpace: 'nowrap' as const },
  // ビューアは viewerHost（Sidebar+main のみを束ねるラッパー）を覆う絶対配置に変更（fixedではない）。
  // DetailPanel はレイアウト上そもそもこの外側にあるので、ビューア表示中も隠れず操作できる（P1）。
  // overflow:hidden 必須: ズーム時の scale() で拡大された画像は箱をはみ出すが、ビューアは
  // zIndex 5000 なので、クリップしないと右隣の DetailPanel の上に画像が描画されてしまう。
  // ビューア配下（このキーから filmstrip 系まで）は画像鑑賞用の常時暗転オーバーレイであり、
  // ライトモードでも意図的にダークのまま固定する（テーマ非依存）。
  viewer: { position: 'absolute' as const, inset: 0, overflow: 'hidden', background: 'rgba(0,0,0,0.93)', zIndex: 5000, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' },
  viewerTopBar: { position: 'absolute' as const, top: 0, left: 0, right: 0, zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.x16, minHeight: 46, padding: '8px 14px 8px 24px', boxSizing: 'border-box' as const, background: 'linear-gradient(rgba(0,0,0,0.74), rgba(0,0,0,0))' },
  // 100vw/100vh ではなく自身の箱（= viewerHost の実サイズ）基準にする。ビューアはもはや
  // フルビューポート幅ではない（DetailPanel 分だけ狭い）ため、100vw を使うとはみ出す。
  viewerMediaStack: { width: 'calc(100% - clamp(48px, 6vw, 112px))', height: 'calc(100% - clamp(136px, 18vh, 188px))', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', gap: space.x8 },
  viewerMediaFrame: { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  viewerImg: { width: '100%', height: '100%', objectFit: 'contain' as const, display: 'block', transformOrigin: 'center' },
  viewerTitle: { minWidth: 0, flex: 1, color: '#d6dbea', fontSize: font.sm, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, textShadow: '0 2px 10px rgba(0,0,0,0.9)' },
  viewerActions: { flexShrink: 0, display: 'flex', alignItems: 'center', gap: space.x8 },
  viewerCounter: { color: 'rgba(255,255,255,0.46)', fontSize: font.base, fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' as const, letterSpacing: 0.5 },
  viewerClose: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', color: '#999', cursor: 'pointer', lineHeight: 1, padding: '2px 6px' },
  viewerZoomHud: { position: 'absolute' as const, top: 58, left: '50%', transform: 'translateX(-50%)', zIndex: 3, display: 'inline-flex', alignItems: 'center', minHeight: control.sm, padding: '2px 8px', background: 'rgba(13,15,20,0.48)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 999, pointerEvents: 'none' as const },
  viewerZoomValue: { color: 'rgba(232,236,248,0.68)', fontSize: font.xs, fontWeight: 800, fontVariantNumeric: 'tabular-nums', minWidth: 36, textAlign: 'center' as const },
  filmstrip: { position: 'absolute' as const, bottom: 0, left: 0, right: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: space.x4, padding: '30px 80px 18px', background: 'linear-gradient(transparent, rgba(0,0,0,0.82))', zIndex: 1 },
  filmstripThumb: { width: 64, height: control.lg, objectFit: 'cover' as const, borderRadius: radius.md, cursor: 'pointer', border: '2px solid transparent', flexShrink: 0, opacity: 0.6 },
  filmstripThumbPlaceholder: { width: 64, height: control.lg, border: '2px solid transparent', flexShrink: 0, opacity: 0, pointerEvents: 'none' as const },
  // 今表示している 1 枚。押しても同じ画像が開くだけなので、指の形にはしない
  //（<img> なので button[data-current] の共通規則が効かず、ここで個別に戻す）。
  filmstripThumbActive: { border: '2px solid rgba(255,255,255,0.9)', opacity: 1, cursor: 'default' },
  viewerArrow: { position: 'absolute' as const, top: '50%', transform: 'translateY(-50%)', width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: radius.md, color: '#fff', cursor: 'pointer', zIndex: 1 },
}
