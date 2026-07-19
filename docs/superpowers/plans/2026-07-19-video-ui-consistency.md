# 動画UIのデザイン統一・操作領域拡大 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 動画UI（3ファイル）のベタ書き色をアプリ本体の CSS 変数トークンへ置換してライト/ダークに追従させ、あわせて動画コントロールのクリック対象を拡大する。

**Architecture:** 「2層」方式。映像に重なる要素（A層）は暗色固定のままアクセント色のみ統一、映像の外側クローム（B層）はテーマ連動トークン化。重複していた `vcBar`／シークバーのスタイルを `videoControls.tsx` に集約してから両コンシューマが参照する。

**Tech Stack:** React 19 + TypeScript、inline `React.CSSProperties` スタイル、Vite、Vitest。色は [global.css](../../../app/src/renderer/global.css) の CSS 変数、`radius`/`font`/`color` は [styles.ts](../../../app/src/renderer/src/styles.ts)。

## Global Constraints

- `font` トークン（[styles.ts](../../../app/src/renderer/src/styles.ts#L3)）は**変更しない**。アプリ全体が参照するため。
- 動画*表示エリア*の黒背景（`#000`）と A層コントロールの暗色ベタ値は**維持**（意図的な非テーマ暗色）。
- レイアウト構造・機能・キーボード挙動は変えない（見た目と寸法のみ）。
- [ClipHotkeySettings.tsx](../../../app/src/renderer/src/video/ClipHotkeySettings.tsx) は対象外（既にトークン連動済み）。
- 各タスクの無回帰ゲートは `cd app && npm run verify`（typecheck + 全 vitest、現状 343 tests green）。
- スタイル値をアサートする単体テストは新設しない（YAGNI。既存テストはスタイルを検証していない）。
- コミットのみ実施。ブランチ操作・push はユーザー確認を得るまで行わない。

---

## File Structure

- **Modify** [app/src/renderer/src/components/videoControls.tsx](../../../app/src/renderer/src/components/videoControls.tsx)
  — 共有コントロールバー／シーク／音量スタイルの単一定義。ヒットターゲット拡大とアクセント統一の起点。
- **Modify** [app/src/renderer/src/components/VideoPlayer.tsx](../../../app/src/renderer/src/components/VideoPlayer.tsx)
  — ローカル重複スタイルを削除し、videoControls の共有スタイルを参照。
- **Modify** [app/src/renderer/src/video/VideoTrimmer.tsx](../../../app/src/renderer/src/video/VideoTrimmer.tsx)
  — B層クロームのトークン化（Task 3）＋ヒットターゲット拡大と共有 vcBar 採用（Task 4）。

---

## Task 1: videoControls.tsx — 共有スタイル集約・アクセント統一・ヒットtarget拡大

**Files:**
- Modify: `app/src/renderer/src/components/videoControls.tsx`

**Interfaces:**
- Produces（他タスクが参照する新規 export）:
  - `vcBarStyle: React.CSSProperties` — コントロールバー本体コンテナ
  - `vcSeekTrackStyle: React.CSSProperties` — 透明ヒットトラック（実効16px）
  - `vcSeekBarStyle: React.CSSProperties` — 可視バー背景（高さ6px）
  - `vcSeekFillStyle: React.CSSProperties` — 再生済みフィル（幅は呼び出し側が ref で設定）
  - `vcSeekThumbStyle: React.CSSProperties` — つまみ（left は呼び出し側が ref で設定）
  - 既存 `vcBtnStyle` — 当たり判定を最小30×30pxへ拡大（シグネチャ変更なし）

- [ ] **Step 1: `vcBtnStyle` を拡大**

`vcBtnStyle` を以下に置換（`color` は A層の据え置き明るいグレー、当たり判定のみ拡大）:

```tsx
export const vcBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#94a0b7', cursor: 'pointer',
  minWidth: 30, minHeight: 30, padding: 4,
  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
}
```

- [ ] **Step 2: 共有バー／シークスタイルを追加**

`vcBtnStyle` の下に、以下の export を追加する（VideoPlayer から移設・拡大する定義。VideoTrimmer も vcBar を参照する）:

```tsx
// コントロールバー本体（映像に重なる A層＝意図的な非テーマ暗色）。
// VideoPlayer と VideoTrimmer の両方から参照する単一定義（片方だけ直す食い違いを防ぐ、V-20/U-7 と同方針）。
export const vcBarStyle: React.CSSProperties = {
  position: 'absolute', bottom: 0, left: 0, right: 0, display: 'flex', alignItems: 'center',
  gap: 6, padding: '4px 8px', background: 'rgba(13,15,20,0.82)', backdropFilter: 'blur(4px)',
  height: 34, boxSizing: 'border-box'
}

// シークバー: 可視はスリム(高さ6)のまま、掴める判定を実効16pxへ広げる。
// 透明トラック(高さ16)の中に、可視バー・フィル・つまみを縦中央配置する。
export const vcSeekTrackStyle: React.CSSProperties = {
  position: 'relative', flex: 1, height: 16, cursor: 'pointer', display: 'flex', alignItems: 'center'
}
export const vcSeekBarStyle: React.CSSProperties = {
  position: 'absolute', left: 0, right: 0, top: '50%', transform: 'translateY(-50%)',
  height: 6, background: '#272c3a', borderRadius: 3, pointerEvents: 'none'
}
export const vcSeekFillStyle: React.CSSProperties = {
  position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
  height: 6, background: 'rgba(var(--accent-rgb), 1)', borderRadius: 3, pointerEvents: 'none'
}
export const vcSeekThumbStyle: React.CSSProperties = {
  position: 'absolute', top: '50%', marginTop: -6, width: 12, height: 12, borderRadius: 999,
  background: 'var(--accent-text)', boxShadow: '0 0 0 3px rgba(var(--accent-rgb), 0.18)', pointerEvents: 'none'
}
```

- [ ] **Step 3: 音量スライダーのアクセント統一・拡大**

ファイル末尾の `s` オブジェクト内 `vcVolTrack` / `vcVolFill` / `vcVolThumb` を置換（`vcVolPopup` は A層暗色のため据え置き）:

```tsx
  vcVolTrack: { position: 'relative', width: 6, height: 60, background: '#272c3a', borderRadius: 3, cursor: 'pointer', flexShrink: 0 },
  vcVolFill: { position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(var(--accent-rgb), 1)', borderRadius: 3 },
  vcVolThumb: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', width: 12, height: 12, borderRadius: 999, background: 'var(--accent-text)', boxShadow: '0 0 0 3px rgba(var(--accent-rgb), 0.18)', pointerEvents: 'none' },
```

- [ ] **Step 4: 音量つまみの位置補正**

`VolumeControl` 内、つまみの `bottom` 計算をつまみ半径（5→6px）に合わせる。以下の行を探す:

```tsx
            <div style={{ ...s.vcVolThumb, bottom: `calc(${volPct * 100}% - 5px)` }} />
```

次に置換:

```tsx
            <div style={{ ...s.vcVolThumb, bottom: `calc(${volPct * 100}% - 6px)` }} />
```

- [ ] **Step 5: 無回帰ゲート**

Run: `cd app && npm run verify`
Expected: typecheck エラーなし、全 vitest PASS（343 tests green）。

- [ ] **Step 6: Commit**

```bash
git add app/src/renderer/src/components/videoControls.tsx
git commit -m "refactor: 動画コントロールの共有スタイルを集約しアクセント統一・当たり判定拡大"
```

---

## Task 2: VideoPlayer.tsx — 共有スタイル採用・重複削除

**Files:**
- Modify: `app/src/renderer/src/components/VideoPlayer.tsx`

**Interfaces:**
- Consumes（Task 1 から）: `vcBarStyle`, `vcSeekTrackStyle`, `vcSeekBarStyle`, `vcSeekFillStyle`, `vcSeekThumbStyle`（および既存 `vcBtnStyle`, `vcTimeLabelStyle`, `PlayPauseIcon`, `VolumeControl`, `useVcStyles`）

- [ ] **Step 1: import を差し替え**

先頭付近の import 行:

```tsx
import { useVcStyles, vcBtnStyle, vcTimeLabelStyle, PlayPauseIcon, VolumeControl } from './videoControls'
```

を以下に置換:

```tsx
import {
  useVcStyles, vcBtnStyle, vcTimeLabelStyle, PlayPauseIcon, VolumeControl,
  vcBarStyle, vcSeekTrackStyle, vcSeekBarStyle, vcSeekFillStyle, vcSeekThumbStyle
} from './videoControls'
```

- [ ] **Step 2: シークバー JSX を透明トラック構造へ更新**

現在の vcBar ブロック（`<div style={s.vcBar} ...>` 〜 対応する閉じ `</div>`）を以下に置換。可視バー背景 `vcSeekBarStyle` を1枚追加し、つまみ left の補正を `- 4px` → `- 6px` にする:

```tsx
      <div style={vcBarStyle} onClick={(e) => e.stopPropagation()}>
        <button style={vcBtnStyle} onClick={() => { const v = videoRef.current; if (!v) return; playing ? v.pause() : v.play() }}>
          <PlayPauseIcon playing={playing} />
        </button>
        <div style={vcSeekTrackStyle} onPointerDown={handleSeekPointerDown}>
          <div style={vcSeekBarStyle} />
          <div ref={seekFillRef} style={{ ...vcSeekFillStyle, width: `${(vcTimeRef.current / (vcDuration || 1)) * 100}%` }} />
          <div ref={seekThumbRef} style={{ ...vcSeekThumbStyle, left: `calc(${(vcTimeRef.current / (vcDuration || 1)) * 100}% - 6px)` }} />
        </div>
        <span ref={vcTimeLabelRef} style={vcTimeLabelStyle}>{fmtDur(vcTimeRef.current)} / {fmtDur(vcDuration)}</span>
        <VolumeControl videoRef={videoRef} volume={vcVolume} muted={vcMuted} />
      </div>
```

- [ ] **Step 3: つまみ位置更新関数の補正**

`updateVcTime` 内、つまみ left を設定する行:

```tsx
    if (seekThumbRef.current) seekThumbRef.current.style.left = `calc(${pct} - 4px)`
```

を以下に置換（つまみ幅 8→12 に伴い半径 4→6）:

```tsx
    if (seekThumbRef.current) seekThumbRef.current.style.left = `calc(${pct} - 6px)`
```

- [ ] **Step 4: ローカル重複スタイルを削除**

ファイル末尾のローカル `s` 定義（`vcBar` / `vcSeekTrack` / `vcSeekFill` / `vcSeekThumb` を持つブロック）を丸ごと削除する:

```tsx
const s: Record<string, React.CSSProperties> = {
  vcBar: { position: 'absolute', bottom: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: 'rgba(13,15,20,0.82)', backdropFilter: 'blur(4px)', height: 28, boxSizing: 'border-box' },
  vcSeekTrack: { position: 'relative', flex: 1, height: 3, background: '#272c3a', borderRadius: 2, cursor: 'pointer' },
  vcSeekFill: { position: 'absolute', left: 0, top: 0, bottom: 0, background: '#7b7bf6', borderRadius: 2, pointerEvents: 'none' },
  vcSeekThumb: { position: 'absolute', top: '50%', marginTop: -4, width: 8, height: 8, borderRadius: 999, background: '#9ea5ff', boxShadow: '0 0 0 3px rgba(123,123,246,0.18)', pointerEvents: 'none' },
}
```

削除後、`s.` への参照が残っていないことを確認する（Step 2 で `vcBar` 参照は撤去済み。他に `s.` は無い）。

- [ ] **Step 5: 無回帰ゲート**

Run: `cd app && npm run verify`
Expected: typecheck エラーなし（未使用 `s` 参照が残っていれば tsc/lint が検知）、全 vitest PASS。

- [ ] **Step 6: Commit**

```bash
git add app/src/renderer/src/components/VideoPlayer.tsx
git commit -m "refactor: VideoPlayer を共有シークバースタイルに寄せて再生バーを掴みやすく"
```

---

## Task 3: VideoTrimmer.tsx — B層クロームのトークン化＋A層アクセント統一

**Files:**
- Modify: `app/src/renderer/src/video/VideoTrimmer.tsx`

**Interfaces:**
- Consumes: `radius`（[styles.ts](../../../app/src/renderer/src/styles.ts#L14)）を新たに import。

- [ ] **Step 1: `radius` を import に追加**

```tsx
import { font, color } from '../styles'
```

を:

```tsx
import { font, color, radius } from '../styles'
```

- [ ] **Step 2: JSX 内インライン色（IN/OUT）をトークン化**

タイムラインのタブ（`handleTab`）とバッジ（`badge`）の inline `background` を置換する。

タイムラインタブ（現在）:

```tsx
              <div ref={inTabRef} style={{ ...s.handleTab, background: '#4caf50', left: pct(inSec) }} />
              <div ref={outTabRef} style={{ ...s.handleTab, background: '#f44336', left: pct(outSec) }} />
```

置換後:

```tsx
              <div ref={inTabRef} style={{ ...s.handleTab, background: 'var(--success)', left: pct(inSec) }} />
              <div ref={outTabRef} style={{ ...s.handleTab, background: 'var(--danger)', left: pct(outSec) }} />
```

IN/OUT バッジ（現在）:

```tsx
                <span style={{ ...s.badge, background: '#4caf50' }}>IN</span>
```

置換後:

```tsx
                <span style={{ ...s.badge, background: 'var(--success)' }}>IN</span>
```

同様に OUT バッジ:

```tsx
                <span style={{ ...s.badge, background: '#f44336' }}>OUT</span>
```

置換後:

```tsx
                <span style={{ ...s.badge, background: 'var(--danger)' }}>OUT</span>
```

- [ ] **Step 3: `s` オブジェクトの B層色をトークン化**

ファイル末尾の `s` 定義のうち、以下のキーを置換する（A層の `videoWrap`/`video`/`vcBar`/`timeline`/`timelineStrip`/`timelineDim`/`handleTab`/`dragHandle`/`playhead` の暗色ベタ値は据え置き。`selectionBorder` はアクセントのみ統一）。

```tsx
  overlay: { position: 'fixed', inset: 0, background: 'rgba(var(--scrim-rgb), 0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 6000 },
  modal: { background: 'var(--bg-page)', border: '1px solid var(--border-default)', borderRadius: radius.md, width: 'calc(100vw - clamp(48px, 6vw, 112px))', maxWidth: 1280, maxHeight: '96vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 70px rgba(0,0,0,0.64)' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '10px 16px', borderBottom: '1px solid var(--border-default)', flexShrink: 0 },
  fileTitle: { minWidth: 0, color: 'var(--text-primary)', fontSize: font.lg, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  closeBtn: { background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 },
```

`selectionBorder` の藍を統一（A層だがアクセントは統一対象）:

```tsx
  selectionBorder: { position: 'absolute', top: 0, bottom: 0, borderTop: '2px solid rgba(var(--accent-rgb), 0.7)', borderBottom: '2px solid rgba(var(--accent-rgb), 0.7)', pointerEvents: 'none', zIndex: 1 },
```

操作パネル（B層）のキーを置換:

```tsx
  badge: { color: '#fff', borderRadius: radius.sm, padding: '1px 5px', fontSize: font.xs, fontWeight: 800, width: 30, textAlign: 'center', flexShrink: 0 },
  time: { fontFamily: 'monospace', fontSize: font.base, color: 'var(--text-primary)', width: 68, flexShrink: 0 },
  frameNum: { fontFamily: 'monospace', fontSize: font.xs, color: 'var(--text-secondary)', width: 40, flexShrink: 0 },
  frameBtn: { padding: '2px 7px', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.sm, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: font.sm, whiteSpace: 'nowrap' as const },
  setBtn: { padding: '2px 7px', background: 'rgba(var(--accent-rgb), 0.14)', border: '1px solid rgba(var(--accent-rgb), 0.4)', borderRadius: radius.sm, color: 'var(--accent-text)', cursor: 'pointer', fontSize: font.sm, fontWeight: 700, whiteSpace: 'nowrap' as const },
  boundaryActions: { display: 'inline-flex', alignItems: 'center', gap: 4, paddingLeft: 6, borderLeft: '1px solid var(--border-strong)', flexShrink: 0 },
  duration: { color: 'var(--accent-text)', fontSize: font.xs, fontWeight: 800, fontVariantNumeric: 'tabular-nums' as const },
  ptsStatus: { color: 'var(--text-secondary)', fontSize: font.xs, fontStyle: 'italic' },
  ptsWarn: { color: 'var(--warning)', fontSize: font.xs, fontStyle: 'italic' },
  shortcutHint: { color: 'var(--text-muted)', fontSize: font.xs, letterSpacing: 0.2, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '9px 16px', borderTop: '1px solid var(--border-default)', flexShrink: 0 },
  cancelBtn: { padding: '6px 16px', background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: radius.sm, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: font.base },
  trimBtn: { padding: '6px 20px', background: 'var(--accent)', border: '1px solid rgba(var(--accent-rgb), 0.7)', borderRadius: radius.sm, color: '#fff', cursor: 'pointer', fontSize: font.base, fontWeight: 800, boxShadow: '0 6px 18px rgba(var(--accent-rgb), 0.26)' },
```

> 注: `frameBtn`/`setBtn` の `padding`・`fontSize` は Task 4 で拡大する。ここでは色のみ変更し、寸法は現状維持。

- [ ] **Step 4: 無回帰ゲート**

Run: `cd app && npm run verify`
Expected: typecheck エラーなし、全 vitest PASS。

- [ ] **Step 5: Commit**

```bash
git add app/src/renderer/src/video/VideoTrimmer.tsx
git commit -m "refactor: VideoTrimmer のクロームをテーマトークンへ統一"
```

---

## Task 4: VideoTrimmer.tsx — ヒットターゲット拡大・共有 vcBar 採用

**Files:**
- Modify: `app/src/renderer/src/video/VideoTrimmer.tsx`

**Interfaces:**
- Consumes（Task 1 から）: `vcBarStyle`（既存の `useVcStyles, vcBtnStyle, PlayPauseIcon, VolumeControl` に追加 import）

- [ ] **Step 1: `vcBarStyle` を import に追加**

現在:

```tsx
import { useVcStyles, vcBtnStyle, PlayPauseIcon, VolumeControl } from '../components/videoControls'
```

置換後:

```tsx
import { useVcStyles, vcBtnStyle, PlayPauseIcon, VolumeControl, vcBarStyle } from '../components/videoControls'
```

- [ ] **Step 2: vcBar を共有スタイルへ差し替え**

映像下のコントロールバー:

```tsx
          <div style={s.vcBar}>
```

置換後:

```tsx
          <div style={vcBarStyle}>
```

続いて `s` 定義内の `vcBar` キー行を削除する:

```tsx
  vcBar: { position: 'absolute', bottom: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: 'rgba(13,15,20,0.82)', backdropFilter: 'blur(4px)', height: 28, boxSizing: 'border-box' as const },
```

- [ ] **Step 3: ボタン／ドラッグ掴みの寸法拡大**

`s` 定義内の該当キーを置換する。

`closeBtn`（当たり判定を28×28pxへ）:

```tsx
  closeBtn: { background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0, minWidth: 28, minHeight: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
```

`frameBtn`（padding・font 拡大、最小高28px）:

```tsx
  frameBtn: { padding: '5px 10px', minHeight: 28, boxSizing: 'border-box' as const, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.sm, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: font.base, whiteSpace: 'nowrap' as const },
```

`setBtn`（padding・font 拡大、最小高28px）:

```tsx
  setBtn: { padding: '5px 10px', minHeight: 28, boxSizing: 'border-box' as const, background: 'rgba(var(--accent-rgb), 0.14)', border: '1px solid rgba(var(--accent-rgb), 0.4)', borderRadius: radius.sm, color: 'var(--accent-text)', cursor: 'pointer', fontSize: font.base, fontWeight: 700, whiteSpace: 'nowrap' as const },
```

`dragHandle`（掴み幅 18→22px）:

```tsx
  dragHandle: { position: 'absolute', top: 0, bottom: 0, width: 22, marginLeft: -11, cursor: 'ew-resize', zIndex: 3 },
```

- [ ] **Step 4: 無回帰ゲート**

Run: `cd app && npm run verify`
Expected: typecheck エラーなし（削除した `s.vcBar` への参照が残れば tsc が検知）、全 vitest PASS。

- [ ] **Step 5: Commit**

```bash
git add app/src/renderer/src/video/VideoTrimmer.tsx
git commit -m "feat: VideoTrimmer の操作系ボタン・掴みを拡大し共有vcBarを採用"
```

---

## Task 5: 目視確認（実機）

**Files:** なし（`cd app && npm run dev` で起動して確認）

- [ ] **Step 1: ダーク/ライト両テーマで確認**

`npm run dev` で起動し、設定からテーマをダーク⇄ライトに切り替えて以下を確認:
1. トリマーのモーダル外枠・ヘッダー・フッター・操作パネルがテーマに追従し、動画UIだけ浮かない。
2. ライトモードでも A層（映像上の再生バー・音量・タイムライン帯）は暗色のまま映像に埋もれない。
3. 藍・IN/OUT色がアプリ本体（サイドバーのタグチップ／emptyBtn 等）と同系で揃う。

- [ ] **Step 2: クリック対象の確認**

1. ビューア／詳細パネルの再生バー（シーク）がマウスで確実に掴める。
2. 再生/ミュート、音量スライダーが掴みやすい。
3. トリマーの ±1f・ここをIN/OUT・IN/OUT ドラッグ掴み・✕ が押しやすい。

- [ ] **Step 3: ライトモード A層コントラストの最終判断**

明るいフレーム上でシークフィル（`var(--accent)`＝ライトで #4b4fd0）が見えにくくないか確認。
見えにくければ A層のアクセントのみ固定明色へ戻す（spec「リスク・留意点」参照）を別途検討。

---

## Self-Review

**Spec coverage（spec 各節 → タスク対応）:**
- ワークストリーム① トークン統一（2層）: Task 3（B層クローム）＋ Task 1/Task 3 の A層アクセント統一 ✓
- 色マッピング表: Task 1（藍・IN/OUT・音量）＋ Task 3（modal/header/footer/操作パネル/CTA）で全項目カバー ✓
- CTA（ベタ塗り藍 var 化）: Task 3 `trimBtn` ✓
- ワークストリーム② ヒットターゲット拡大: Task 1（vcBar/シーク/ボタン/音量）＋ Task 4（トリマー各ボタン・掴み）✓
- vcBar 共有化（2-1）: Task 1 で定義 → Task 2/Task 4 で採用、重複削除 ✓
- 寸法表（2-2）: Task 1（vcBar 34・シーク実効16・つまみ12・ボタン30・音量6/12/60）＋ Task 4（frameBtn/setBtn/dragHandle/closeBtn）で全行カバー ✓
- テスト方針: 各タスク `npm run verify`、Task 5 目視 ✓
- ClipHotkeySettings 対象外: どのタスクも触れていない ✓

**Placeholder scan:** TBD/TODO/「適切に」等なし。各コード手順は完全なスタイル定義を提示済み ✓

**Type consistency:** Task 1 で定義した export 名（`vcBarStyle` / `vcSeekTrackStyle` / `vcSeekBarStyle` / `vcSeekFillStyle` / `vcSeekThumbStyle`）を Task 2 の import と JSX、Task 4 の `vcBarStyle` import で同名参照 ✓。`radius.md`/`radius.sm` は [styles.ts](../../../app/src/renderer/src/styles.ts#L14) の実在キー ✓。CSS 変数（`--accent`/`--accent-rgb`/`--accent-text`/`--success`/`--danger`/`--warning`/`--bg-page`/`--bg-surface`/`--border-default`/`--border-strong`/`--text-primary`/`--text-secondary`/`--text-muted`/`--scrim-rgb`）は全て [global.css](../../../app/src/renderer/global.css) に定義済み ✓
