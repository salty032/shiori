import type React from 'react'
import { color, control, font, modal, radius, space, weight } from '../styles'

// 各種設定スロットが見た目を揃えるために再利用する共通スタイル。
//
// ── 崩すと「統一感がない」に戻る約束 ─────────────────────────────
// 1. 器はひとつ。タブの中身は必ず group（区切り線＋余白）で組む。背景付きのカードは使わない。
//    以前は「データ」タブだけが背景付きカード(dataBlock)で、他3タブの区切り線と別物に見えていた。
// 2. 文字は 3 段だけ: section(xs/secondary) > label(base/primary) > hint(sm/secondary)。
//    label を section より大きくしないこと。以前は label が lg(15) で見出し xs(12) より
//    目立ち、階層が反転していた。
// 3. 角丸は radius トークンのみ。操作部品(ボタン・入力・バッジ)= sm、器(パネル・タイル)= md。
//    以前は 3 と 4 が根拠なく混在していた。
// 4. ボタンは btnBase で高さ・角丸・字送りを固定し、色だけで役割を分ける。
//    以前は addBtn/sizeBtn/cancelBtn/deleteBtn が全部別の padding と font-size を持っていた。
const btnBase: React.CSSProperties = {
  height: control.lg, boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  flexShrink: 0, padding: '0 14px', borderRadius: radius.md, fontSize: font.base, fontWeight: weight.medium,
  cursor: 'pointer', whiteSpace: 'nowrap' as const,
}

export const s: Record<string, React.CSSProperties> = {
  overlay: { ...modal.overlay, background: 'rgba(var(--scrim-rgb), 0.88)', zIndex: 2000, padding: 0 },
  panel: { ...modal.panel, width: 860, maxWidth: '90vw', height: 520, maxHeight: '88vh', display: 'flex', flexDirection: 'column' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '24px 24px 16px', flexShrink: 0, borderBottom: '1px solid var(--border-default)' },
  sidebar: { width: 124, padding: '8px 10px', gap: space.x2, flexShrink: 0, background: 'var(--bg-well)', borderRight: '1px solid var(--border-default)', display: 'flex', flexDirection: 'column', alignSelf: 'stretch' },
  tabBtn: { display: 'flex', justifyContent: 'flex-start', alignItems: 'center', fontSize: font.base, fontWeight: weight.medium, color: 'var(--text-secondary)', padding: '7px 10px', borderRadius: radius.md, background: 'transparent', border: 'none', cursor: 'pointer', width: '100%' },
  tabBtnActive: { color: 'var(--accent-text)', background: 'rgba(var(--accent-rgb), 0.16)', fontWeight: weight.medium },
  // overscrollBehavior: タブの中身を端まで送ったあと、続きのホイールが背後の一覧へ
  // 渡って**設定を開いたまま裏がスクロールしていた**。contain で連鎖を止める。
  tabContent: { overflowY: 'auto' as const, overscrollBehavior: 'contain' as const, flex: 1, padding: '0 28px 28px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' },
  title: { fontSize: font.xxl, fontWeight: weight.medium, color: 'var(--text-bright)' },
  close: { ...btnBase, width: 32, padding: 0, background: 'rgba(var(--surface-rgb), 0.5)', border: '1px solid transparent', color: 'var(--text-secondary)' },
  // 区切り線は 2 つ目以降の group にだけ出す。1 つ目に出すとヘッダーの下線と重なって
  // 二重線に見えるため、各タブの先頭 group には groupFirst を重ねること。
  // **タブごとに構造を変えない。** どのタブも「group を縦に並べるだけ」の 1 段で揃える。
  // 一度データタブだけカテゴリの段を足したが、他のタブは中身が 2〜4 つしかなく、同じ形に
  // すると子が 1 つだけのカテゴリができる。優先度の問題（バージョン・クレジットが
  // ライブラリへの操作と同列に並んでいた）は、それらを情報タブへ分けたことで解いている。
  group: { borderTop: '1px solid var(--border-default)', padding: '22px 0', display: 'flex', flexDirection: 'column', gap: space.x12, width: '100%', maxWidth: 620 },
  groupFirst: { borderTop: 'none' },
  // **章・項目・説明を、濃さで 3 段の階段にする。** 以前は章が 12px の灰色、説明が 13px の
  // 灰色で、1px しか違わなかった。濃い行は項目だけなので、どの灰色が見出しでどれが補足か
  // 読めない（「章だけ小さくて薄い」＝親より子が目立つ状態だった）。
  //   章   = 項目と同じ大きさ・一番濃い・中太
  //   項目 = 濃い・普通の太さ
  //   説明 = 一番薄い・小さい
  // 大きさで分けるのは説明だけにする。章と項目まで大きさを変えると、章が見出しではなく
  // 「大きい項目」に見えて、同じ列に並んでいるように読めてしまう。
  section: { fontSize: font.base, color: 'var(--text-bright)', fontWeight: weight.medium },
  toggleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.x16 },
  // row と toggleRow は同一。外部の設定スロットが両方の名前を使っているため別名で残す。
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.x16 },
  label: { fontSize: font.base, color: 'var(--text-primary)', fontWeight: weight.normal },
  sizeBtn: { ...btnBase, padding: '0 16px', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', fontWeight: weight.medium, transition: 'all 0.1s' },
  hint: { fontSize: font.xs, color: 'var(--text-muted)', lineHeight: 1.7 },
  creditLink: { padding: 0, background: 'none', border: 'none', color: 'var(--accent-text)', fontSize: font.sm, fontFamily: 'inherit', cursor: 'pointer', textDecoration: 'underline' },
  hotkeyBadge: { ...btnBase, cursor: 'default', padding: '0 12px', background: 'var(--bg-surface)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', fontFamily: 'monospace', fontWeight: weight.normal },
  // hotkeyBadge と同じ「値そのものを見せる枠」。パスは省略すると意味を失う（どこか分からなく
  // なるのが元の問題）ので、切らずに折り返して全文を出し、選択してコピーできるようにする。
  pathBox: { flex: 1, minWidth: 0, padding: '7px 10px', background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: radius.md, color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: font.sm, lineHeight: 1.5, wordBreak: 'break-all' as const, userSelect: 'text' as const },
  // 使用量の数値。行の左は hint（説明側）なので、右の数字だけ primary で拾えるようにする。
  usageValue: { fontSize: font.base, fontWeight: weight.medium, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' as const },
  hotkeyCapture: { ...btnBase, cursor: 'text', padding: '0 12px', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', color: 'var(--accent-text)', fontFamily: 'monospace', fontWeight: weight.normal, minWidth: 140, outline: 'none' },
  toggleSwitch: { width: 44, height: control.md, padding: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-start', flexShrink: 0, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 999, cursor: 'pointer', transition: 'background 0.16s ease, border-color 0.16s ease' },
  toggleSwitchOn: { background: 'rgba(var(--accent-rgb), 0.24)', borderColor: 'rgba(var(--accent-rgb), 0.6)' },
  toggleKnob: { width: 20, height: 20, borderRadius: 999, background: 'var(--text-secondary)', boxShadow: '0 1px 3px rgba(var(--scrim-rgb), 0.45)', transition: 'transform 0.16s cubic-bezier(.22,1,.36,1), background 0.16s ease' },
  toggleKnobOn: { background: 'var(--accent-text)' },
  statusBadge: { display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 8px', borderRadius: 999, fontSize: font.xs, fontWeight: weight.strong, border: '1px solid', whiteSpace: 'nowrap' as const },
  statusOk: { color: 'var(--success)', background: 'rgba(var(--success-rgb), 0.12)', borderColor: 'rgba(var(--success-rgb), 0.35)' },
  statusMuted: { color: 'var(--text-secondary)', background: 'rgba(var(--text-rgb), 0.05)', borderColor: 'var(--border-soft)' },
  statusWarn: { color: 'var(--warning)', background: 'rgba(var(--warning-rgb), 0.12)', borderColor: 'rgba(var(--warning-rgb), 0.4)' },
  inputRow: { display: 'flex', gap: space.x8 },
  input: { flex: 1, height: control.lg, boxSizing: 'border-box' as const, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, color: 'var(--text-primary)', padding: '0 10px', fontSize: font.base, outline: 'none' },
  actionRow: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.x16 },
  addBtn: { ...btnBase, background: 'rgba(var(--accent-rgb), 0.18)', border: '1px solid rgba(var(--accent-rgb), var(--edge-base))', color: 'var(--accent-text)' },
  patternEmpty: { color: 'var(--text-secondary)', fontSize: font.base },
  patternList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: space.x4 },
  patternItem: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.x8, background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: radius.md, padding: '6px 10px' },
  code: { fontFamily: 'monospace', fontSize: font.sm, color: 'var(--text-secondary)', flex: 1 },
  removeBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px', flexShrink: 0 },
  deleteBtn: { ...btnBase, background: color.dangerBg, border: `1px solid ${color.dangerBorder}`, color: color.danger },
  cancelBtn: { ...btnBase, background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' },
  progressWrap: { display: 'flex', alignItems: 'center', gap: space.x8 },
  progressBar: { flex: 1, height: 6, background: 'var(--border-default)', borderRadius: radius.md, overflow: 'hidden' },
  progressFill: { height: '100%', background: 'var(--accent)', borderRadius: radius.md, transition: 'width 0.3s' },
  progressLabel: { color: 'var(--text-secondary)', fontSize: font.sm, width: 36, textAlign: 'right' as const },
  statusLine: { fontSize: font.sm, fontWeight: weight.normal },
  statusLineOk: { color: 'var(--success)' },
  statusLineError: { color: color.danger },
}
