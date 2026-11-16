// トリミング画面（VideoTrimmer.tsx）の見た目。画面の動きとは関係しないので分けてある。
import type { CSSProperties } from 'react'
import { color, control, font, radius, space, weight } from '../styles'

export const trimmerStyles: Record<string, CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(var(--scrim-rgb), 0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 6000 },
  // 器はアプリの他のダイアログ（設定・確認・変更点）と同じ作りにする。ここだけ radius.md の
  // 硬い角＋--bg-page の地だったので、手前に浮いているのに一番角張って見えていた。
  modal: { background: 'var(--bg-modal)', border: '1px solid var(--border-default)', borderRadius: radius.lg, width: 'calc(100vw - clamp(48px, 6vw, 112px))', maxWidth: 1280, maxHeight: '96vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 70px rgba(0,0,0,0.64)' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.x12, padding: '10px 16px', borderBottom: '1px solid var(--border-default)', flexShrink: 0 },
  fileTitle: { minWidth: 0, color: 'var(--text-primary)', fontSize: font.lg, fontWeight: weight.medium, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  // ConfirmDialog / WhatsNewModal と同一。裸の「✕」文字だけがこの画面の作りだった。
  closeBtn: { flexShrink: 0, width: control.lg, height: control.lg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--surface-rgb), 0.5)', border: '1px solid transparent', borderRadius: radius.md, color: 'var(--text-secondary)', cursor: 'pointer', padding: 0 },
  videoWrap: { position: 'relative', flexShrink: 1, minHeight: 0, display: 'flex', justifyContent: 'center', background: '#000' },
  // 190 → 260: タイムライン上の IN/OUT フラグ用の余白と、カード化した IN/OUT 行の
  // 分だけ映像以外の高さが増えたぶんを反映する（ここがズレると縦スクロールが出る）。
  video: { width: '100%', maxHeight: 'calc(96vh - 260px)', aspectRatio: '16/9', background: '#000', display: 'block', objectFit: 'contain' as const, cursor: 'pointer' },
  // タイムラインの上に IN/OUT のフラグを出す余白。フラグはハンドル(handleTab)の
  // 子なので、ドラッグで left% が動けば一緒に動く（追加の ref を持たなくてよい）。
  timelineWrap: { padding: '26px 16px 0', flexShrink: 0 },
  // 地はモーダル（--bg-modal）の上なので --bg-inset 側。--bg-inset-strong はカードの上に
  // 置く溝用で、沈む面の上ではその深さが出ない（global.css の --bg-inset 参照）。
  timeline: { position: 'relative', height: 52, background: 'var(--bg-inset)', border: '1px solid var(--border-default)', cursor: 'crosshair', borderRadius: radius.md },
  timelineStrip: { position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: radius.md },
  // 範囲外は「暗くする」だけでなく彩度も落とす。選択範囲だけが色を保つので、
  // どこを切り出すのかがサムネイルの色の有無で一目で分かる。
  timelineDim: { position: 'absolute', top: 0, bottom: 0, background: 'rgba(var(--scrim-rgb), 0.62)', backdropFilter: 'grayscale(1) brightness(0.72)', WebkitBackdropFilter: 'grayscale(1) brightness(0.72)', pointerEvents: 'none' } as CSSProperties,
  // 選択範囲は塗りを載せない（サムネイルの色をそのまま見せる）。上下のレールだけで
  // 帯を示す。IN=緑 / OUT=赤 に色を割り当てているので、ここに 3 色目の色相を
  // 足さないようレールは無彩色にする。
  selectionBorder: { position: 'absolute', top: 0, bottom: 0, borderTop: '2px solid rgba(255,255,255,0.92)', borderBottom: '2px solid rgba(255,255,255,0.92)', pointerEvents: 'none', zIndex: 1 },
  handleTab: { position: 'absolute', top: -1, bottom: -1, width: 4, transform: 'translateX(-50%)', pointerEvents: 'none', zIndex: 2, boxShadow: '0 0 0 1px rgba(var(--scrim-rgb), 0.55)' },
  handleTabIn: { background: 'var(--success)', borderRadius: '2px 0 0 2px' },
  handleTabOut: { background: 'var(--danger)', borderRadius: '0 2px 2px 0' },
  handleFlag: { position: 'absolute', bottom: 'calc(100% + 5px)', left: '50%', transform: 'translateX(-50%)', padding: '1px 6px', borderRadius: radius.md, fontSize: 10, fontWeight: weight.strong, letterSpacing: 0.5, lineHeight: '15px', whiteSpace: 'nowrap' as const },
  handleFlagIn: { background: 'var(--success)', color: 'var(--bg-page)' },
  handleFlagOut: { background: 'var(--danger)', color: 'var(--bg-page)' },
  dragHandle: { position: 'absolute', top: 0, bottom: 0, width: 22, marginLeft: -11, cursor: 'ew-resize', zIndex: 3 },
  playhead: { position: 'absolute', top: -3, bottom: -3, width: 2, background: '#fff', transform: 'translateX(-50%)', pointerEvents: 'none', boxShadow: '0 0 0 1px rgba(0,0,0,0.55)' },
  controls: { padding: '12px 16px 8px', display: 'flex', flexDirection: 'column', gap: space.x8, flexShrink: 0 },
  // 左右の間は x24（画面の大きな区切り）。枠を外したので、詰めると 2 組が 1 本の長い行に
  // 見えて、どこまでが開始側なのか読めなくなる。
  boundaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: space.x24 },
  // 列: バッジ / 時刻 / コマ送り(右寄せ) / 設定ボタン(固定幅)。
  // 2 枚で同一なので左右で必ず揃う。
  //
  // カードの枠と左端の色帯は外してある。中に IN/OUT のバッジがあり、さらに真上の
  // タイムラインにも同じ色の旗が出ているので、「ここは開始の行」を 3 回言っていた。
  // 左右の padding も 0 にして、タイムラインの左端と縦に揃える。
  boundaryCard: { display: 'grid', gridTemplateColumns: '38px 74px 1fr auto', alignItems: 'center', gap: space.x8, minWidth: 0 },
  badge: { boxSizing: 'border-box' as const, height: 20, lineHeight: '18px', borderRadius: radius.md, fontSize: 10, fontWeight: weight.strong, letterSpacing: 0.5, textAlign: 'center' as const },
  badgeIn: { background: 'rgba(var(--success-rgb), 0.16)', border: '1px solid rgba(var(--success-rgb), var(--edge-base))', color: 'var(--success)' },
  badgeOut: { background: 'rgba(var(--danger-rgb), 0.16)', border: '1px solid rgba(var(--danger-rgb), var(--edge-base))', color: 'var(--danger)' },
  time: { fontSize: font.base, fontWeight: weight.medium, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' as const, letterSpacing: 0.2 },
  // コマ送りは 2 つの独立したボタンではなく、枠を共有するセグメントにする
  // （個別のピルが並ぶと右端が揃わずガタついて見えた）。
  stepper: { justifySelf: 'end', display: 'inline-flex', alignItems: 'stretch', height: control.md, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, overflow: 'hidden' },
  stepBtn: { width: 46, padding: 0, background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: font.sm, fontWeight: weight.medium, fontVariantNumeric: 'tabular-nums' as const, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  stepBtnRight: { borderLeft: '1px solid var(--border-strong)' },
  // IN/OUT の色は付けない。すぐ上のタイムラインに緑の IN 旗・赤の OUT 旗が出ており、
  // 同じ意味の色をこのボタンでもう一度鳴らすと、画面の下半分が色だらけになる。
  // ここはフッターのキャンセルと同じ無彩色の枠ボタン。
  setBtn: { boxSizing: 'border-box' as const, width: 88, height: control.md, padding: 0, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, color: 'var(--text-primary)', cursor: 'pointer', fontSize: font.sm, fontWeight: weight.medium, whiteSpace: 'nowrap' as const },
  infoRow: { display: 'flex', alignItems: 'center', gap: space.x12, minHeight: 18 },
  duration: { color: 'var(--text-primary)', fontSize: font.xs, fontWeight: weight.medium, fontVariantNumeric: 'tabular-nums' as const, whiteSpace: 'nowrap' as const },
  ptsStatus: { color: 'var(--text-secondary)', fontSize: font.xs, fontStyle: 'italic' },
  ptsWarn: { color: 'var(--warning)', fontSize: font.xs, fontStyle: 'italic' },
  errorMsg: { color: color.danger, fontSize: font.sm },
  // キーの一覧だけ右端へ逃がす（marginLeft:auto）。左詰めだと選択範囲・解析中・
  // 短すぎ警告と 1 本の団子になり、どれが今の状態でどれが操作説明なのか読めない。
  shortcutHint: { marginLeft: 'auto', color: 'var(--text-muted)', fontSize: font.xs, letterSpacing: 0.2, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' },
  // ボタン列の帯は一段沈める（他のダイアログの actions / footer と同じ --bg-content）。
  footer: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: space.x8, padding: '10px 16px', background: 'var(--bg-content)', borderTop: '1px solid var(--border-default)', flexShrink: 0 },
  // フッターの 2 ボタンは ConfirmDialog と同じ組み合わせにする。以前この保存ボタンだけが
  // var(--accent) のベタ塗り＋白文字で、明るい藤色に白を載せるためコントラストが約 2:1 しか
  // 出ず濁って見えていた（かつアプリ内で唯一の見た目でもあった）。ティント地＋アクセント文字なら
  // 地に対して文字が十分明るく、ライト/ダークどちらでも成立する。
  cancelBtn: { boxSizing: 'border-box' as const, height: control.lg, padding: '0 16px', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, color: 'var(--text-primary)', cursor: 'pointer', fontSize: font.sm, fontWeight: weight.medium },
  trimBtn: { boxSizing: 'border-box' as const, height: control.lg, padding: '0 20px', background: 'rgba(var(--accent-rgb), 0.2)', border: '1px solid rgba(var(--accent-rgb), var(--edge-base))', borderRadius: radius.md, color: 'var(--accent-text)', cursor: 'pointer', fontSize: font.sm, fontWeight: weight.medium },
  trimDisabled: { opacity: 0.4, cursor: 'not-allowed' },
}
