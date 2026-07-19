# 動画UIのデザイン統一・操作領域拡大 設計

## 背景・目的

動画機能（録画クリップ・トリミング・インライン再生）の UI は後付けで移植されたため、
アプリ本体のデザイン基盤から外れている。

1. **テーマ非連動**: アプリ本体は [styles.ts](../../../app/src/renderer/src/styles.ts) と
   [global.css](../../../app/src/renderer/global.css) の CSS 変数トークンで統一され、ライト/ダークに
   自動追従する。しかし動画UIは `font` と `color.danger` 以外の色を**ベタ書き**しており、
   ライトモードにしても動画UIだけ暗色のまま浮く。
2. **アクセント色の不統一**: `#6f6ff2` / `#7b7bf6` / `#9ea5ff` の3種の藍が混在し、
   本体の `--accent` とも微妙に違う。IN/OUT も Material 由来の `#4caf50` / `#f44336`。
3. **クリック対象が小さい**: 特にビューア/詳細パネルの再生バーは
   [VideoPlayer.tsx](../../../app/src/renderer/src/components/VideoPlayer.tsx) のシークトラックが
   **height 3px**、再生/ミュートボタンが `padding: 2px 3px`（実質14px角）で、マウスでも掴みにくい。

本設計は動画UIをアプリ本体のトークンに寄せて視覚的に統一し、あわせて動画コントロールの
操作領域（ヒットターゲット）を拡大する。

## ゴール / 非ゴール

**ゴール**
- 動画UIのベタ書き色を CSS 変数・`radius`・`color` トークンへ置換し、ライト/ダークに追従させる。
- 藍3種・IN/OUT 色をアプリ本体の `--accent` / `--success` / `--danger` に統一する。
- 動画コントロール（再生バー・音量・トリマーの各ボタン/ドラッグ掴み）のヒットターゲットを拡大する。

**非ゴール**
- `font` トークン（アプリ全体が参照）の変更はしない。文字サイズの底上げは今回やらない
  （「小さい」の正体はクリック対象、というユーザー判断による）。
- 動画*表示エリア*そのものの暗色は維持する（画像鑑賞と同じく意図的な非テーマ暗色）。
- レイアウト構造・機能・キーボード操作の挙動は変えない（見た目と寸法のみ）。
- [ClipHotkeySettings.tsx](../../../app/src/renderer/src/video/ClipHotkeySettings.tsx) は既に
  SettingsModal の共有 `s` と `color`/`font` トークンのみを使いテーマ連動済みのため対象外。

## スコープ（対象3ファイル）

- [app/src/renderer/src/components/videoControls.tsx](../../../app/src/renderer/src/components/videoControls.tsx)
- [app/src/renderer/src/components/VideoPlayer.tsx](../../../app/src/renderer/src/components/VideoPlayer.tsx)
- [app/src/renderer/src/video/VideoTrimmer.tsx](../../../app/src/renderer/src/video/VideoTrimmer.tsx)

## 設計の中心概念: 「2層」でトークン化を分ける

全要素を単純にテーマ連動にすると、動画の上に重なる操作系がライトモードで白くなり映像に埋もれる。
アプリ本体の既存思想（ビューア/フィルムストリップは意図的に非テーマ暗色。[styles.ts](../../../app/src/renderer/src/styles.ts) の
`viewer` 系コメント参照）に合わせ、動画UIも2層に切り分ける。

### A層: 映像の上に重なる要素 → 両テーマとも暗色固定（現状の思想を維持）

対象:
- 映像エリアの黒背景（`videoWrap` / `video` の `#000`）
- コントロールバー `vcBar`、その中の再生/ミュートボタン・時刻ラベル
- 音量ポップアップ／スライダー（`vcVolPopup` / `vcVolTrack` / `vcVolThumb` / `vcVolFill`）
- 再生バーのシークトラック／フィル／つまみ
- トリマーのタイムライン帯（サムネイル表示）・プレイヘッド・IN/OUTタブ・dim オーバーレイ

方針: 背景・境界の暗色はベタ値のまま残してよい（映像の上での視認性のため）。
ただし**アクセント色だけは A層でも統一する**（フィル/つまみ/選択枠 → `rgba(var(--accent-rgb), x)`）。
A層の暗色ベタ値は「意図的な非テーマ暗色」であることをコメントで明示する。

### B層: 映像の外側のクローム → トークン化してテーマ連動

対象（すべて VideoTrimmer）:
- モーダル外枠: `overlay`（scrim）、`modal`（背景/枠）、`header`、`footer`
- タイムライン下の操作パネル: `badge`（IN/OUT）、`time`、`frameNum`、`frameBtn`、`setBtn`、
  `boundaryActions` の区切り線、`duration`、`ptsStatus`、`ptsWarn`、`shortcutHint`、`errorMsg`
- `cancelBtn`、`trimBtn`（CTA）、`closeBtn`

## 1. 色マッピング

| ベタ書き | → トークン | 層 |
|---|---|---|
| `#6f6ff2` / `#7b7bf6`（藍・塗り） | `var(--accent)` / `rgba(var(--accent-rgb), 1)` | A/B |
| `#9ea5ff` / `#8585ff`（藍・明） | `var(--accent-text)` | A/B |
| `rgba(123,123,246, x)`（藍・半透明） | `rgba(var(--accent-rgb), x)` | A/B |
| IN `#4caf50` | `var(--success)` | A/B |
| OUT `#f44336` | `var(--danger)` | A/B |
| `#0d0f14`（modal 背景） | `var(--bg-page)` | B |
| `#20242f`（境界） | `var(--border-default)` | B |
| `#272c3a` / `#2b3243` / `#33445e`（強境界） | `var(--border-strong)` | B |
| `#171a23`（frameBtn 背景など） | `var(--bg-surface)` | B |
| `rgba(3,5,10,0.88)`（scrim） | `rgba(var(--scrim-rgb), 0.88)` | B |
| `#dce3f2` / `#e3e8f6`（主要テキスト） | `var(--text-primary)` | B |
| `#6f778b` / `#8a94aa` / `#7f899f` / `#b9c2d6`（副次テキスト） | `var(--text-secondary)` | B |
| `#58627f`（薄いヒント） | `var(--text-muted)` | B |
| `#e67e22`（pts 警告） | `var(--warning)` | B |
| 角丸 `2` / `3` / `4`（ベタ） | `radius.sm(3)` / `radius.md(4)` | B |

補足:
- `setBtn`（`#1e2a3a` 背景 / `#33445e` 枠 / `#9ea5ff` 文字）はアプリの `emptyBtn` 流儀に合わせ
  `rgba(var(--accent-rgb), 0.14)` 背景 / `rgba(var(--accent-rgb), 0.4)` 枠 / `var(--accent-text)` 文字。
- `trimBtn`（CTA）はベタ塗り藍を維持しつつ `var(--accent)` 背景 / `rgba(var(--accent-rgb), 0.7)` 枠 /
  `#fff` 文字 / `boxShadow` は `rgba(var(--accent-rgb), 0.26)`。ライトの `--accent`（#4b4fd0）でも
  白文字のコントラストは十分。
- `cancelBtn` は `var(--border-strong)` 枠 / `var(--text-secondary)` 文字（アプリのキャンセル流儀）。
- IN/OUT バッジは背景 `var(--success)` / `var(--danger)`・文字 `#fff` を維持。
  ライトの success(#167a56)/danger(#c22a3e) でも白文字は視認可能。
- A層の `#000` 映像背景・`vcBar` の `rgba(13,15,20,0.82)` 等の暗色は変更しない（意図的非テーマ）。
  `radius` も A層は現状のベタ値で可（視覚差が無く、統一の主眼はB層）。

## 2. ヒットターゲット拡大

### 2-1. `vcBar` の共有化（前提リファクタ）

現状 `vcBar` は [VideoPlayer.tsx](../../../app/src/renderer/src/components/VideoPlayer.tsx) と
[VideoTrimmer.tsx](../../../app/src/renderer/src/video/VideoTrimmer.tsx) が別々に同一定義を持つ。
片方だけ直して食い違う事故（過去レビュー V-20 / U-7 と同種）を防ぐため、
`vcBar` のスタイルを [videoControls.tsx](../../../app/src/renderer/src/components/videoControls.tsx) に
`vcBarStyle` として集約し、両者から import する。VideoPlayer のシークトラック関連
（`vcSeekTrack` / `vcSeekFill` / `vcSeekThumb`）も videoControls 側へ寄せて一元管理する。

### 2-2. 寸法変更

| 要素 | 現状 | → 変更後 |
|---|---|---|
| `vcBar` 高さ | 28px | 34px |
| シークトラック 見た目高さ | 3px | 6px |
| シークトラック 掴める高さ | 3px | 透明ヒット領域で実効16px（`padding` 上下＋`background-clip`、または高さ16pxの透明トラック内に6pxの可視バー） |
| シークつまみ | 8px | 12px |
| 再生/ミュートボタン（`vcBtnStyle`） | `padding: 2px 3px`（≒14px角） | 最小 30×30px（`minWidth`/`minHeight: 30`, `padding` 調整） |
| 音量スライダートラック幅 | 3px | 6px |
| 音量スライダーつまみ | 10px | 12px |
| 音量スライダートラック高さ | 52px | 60px |
| トリマー `frameBtn` / `setBtn` | `padding: 2px 7px`・font.sm | `padding: 5px 10px`・font.base、最小高28px |
| トリマー IN/OUT ドラッグ掴み（`dragHandle`） | 幅18px（`marginLeft: -9`） | 幅22px（`marginLeft: -11`） |
| トリマー `closeBtn` | `padding: 0`（≒18px） | 最小28×28px（`display:inline-flex`＋中央寄せ＋`padding`） |

方針:
- 可視バーはスリムなまま、**掴める判定だけ透明領域で広げる**（バーを分厚くして間延びさせない）。
  シークトラックは「高さ16pxの透明トラック＋内部に高さ6pxの可視バーを縦中央配置」で実装し、
  ポインタ判定を16pxに広げる。つまみの上下 `marginTop` は可視バー中央基準で再計算する。
- ボタンはアイコンの `viewBox` を変えず、当たり判定（`minWidth`/`minHeight`/`padding`）だけ拡大する。
- 高さ変更に伴い、`VideoTrimmer` の `video` の `maxHeight: calc(96vh - 190px)` など、
  vcBar 高さ 28→34 の差分（+6px）で映像が数px縮む点は許容（レイアウト崩れは無い）。
  ただし実装時に `videoWrap`/`video` の高さ計算に vcBar 高さのハードコード依存が無いか確認する。

## 3. テスト方針

- 本変更はスタイル（`React.CSSProperties` 定数）中心で、ロジック分岐を含まない。
  既存の vitest はスタイル値をアサートしていないため、色/寸法変更で落ちるテストは無い想定。
- `npm run verify`（typecheck + 全 vitest）green を必須ゲートとする。
- 目視確認（実装後）:
  1. ダーク→ライト切替でトリマーのモーダル外枠・操作パネルが追従し、動画UIだけ浮かない。
  2. ライトモードでも A層（映像上の操作系）は暗色のまま映像に埋もれない。
  3. 藍・IN/OUT色がアプリ本体（サイドバーのタグチップ等）と同系で揃う。
  4. ビューア/詳細/トリマーの再生バーがマウスで確実に掴める。
- 目視確認は実装完了後にユーザーが実機（`npm run dev`）で行う。自動化はしない。

## 4. リスク・留意点

- **A/B 層の境界判断**: 「映像の上か外か」で迷う要素が出たら、映像矩形に重なるものは A層とする。
- **ライトモードでの A層コントラスト**: `var(--accent)` はライトで #4b4fd0 とやや暗い。
  映像（多くは明るい）に対しては十分だが、真っ白なフレーム上でシークフィルが見えにくい場合は
  A層のアクセントのみ固定明色に戻す余地を残す（実装時に目視で確認）。
- **vcBar 共有化の副作用**: VideoPlayer と VideoTrimmer で vcBar の内容（VideoPlayer はシークバー有り、
  VideoTrimmer は無し）が違うため、共有するのは**コンテナのスタイル定数**のみとし、
  中身の JSX は各コンポーネントに残す。
