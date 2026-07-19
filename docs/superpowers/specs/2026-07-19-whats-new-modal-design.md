# アップデート後の「変更点」お知らせ機能 設計

## 背景・目的

Shiori はサイレント自動アップデート（`electron-updater`、`autoInstallOnAppQuit: true`）を採用しており、
更新が適用されたこと自体は起動時のトースト（「Shiori を vX.X.X に更新しました」）で分かるが、
「具体的に何が変わったのか」を知る手段が無い。更新後に開いたときに新機能・変更点が
一目で分かるお知らせ（リリースノート）モーダルを追加する。

## スコープ

- 表示は**最新バージョン分のみ**。複数バージョンを飛ばして更新された場合も、
  差分の全履歴ではなく現在のバージョンの変更点だけを見せる。
- リリースノート文面はリポジトリ内に手書きで管理する（GitHub Release 本文は流用しない。
  現状 GitHub Release は `Shiori vX.X.X` という自動プレースホルダーのみで文面が無いため）。
- 該当バージョンの文面が用意されていない場合は、モーダルを出さず従来のトースト通知に
  フォールバックする（書き忘れを "変更点なし" の空モーダルで見せない）。

## 1. データ

新規ファイル `app/src/shared/releaseNotes.ts`。

```ts
export const RELEASE_NOTES: Record<string, string[]> = {
  '1.1.4': [
    '〇〇機能を追加しました',
    '××の不具合を修正しました',
  ],
}
```

- リリースのたびに手動で1エントリ追記する運用。キーは `package.json` の `version` と一致させる。
- main（フォールバック判定）と renderer（モーダル表示）の両方から `shared/` 経由で参照する
  唯一の情報源とし、文面の二重管理をしない。

## 2. トリガー・配線

既存のバージョン差分検知（[app/src/main/bootstrap.ts:474-484](../../../app/src/main/bootstrap.ts#L474-L484)、
`Settings.lastRunVersion` を使用）をそのまま使い、通知内容だけ分岐させる。

```
前回起動バージョン ≠ 今回のバージョン かつ 前回バージョンがある（初回インストールでない）
  → RELEASE_NOTES[今回のバージョン] が存在し、空配列でない？
      Yes → CH.whatsNew で { version, notes } を renderer へ送信 → お知らせモーダル表示
      No  → 従来通りのトースト「Shiori を vX.X.X に更新しました」
```

配線の変更点:
- `app/src/shared/api.ts`
  - `CH.whatsNew = 'app:whatsNew'` を追加
  - `ShioriApi` に `onWhatsNew: (cb: (data: WhatsNewData) => void) => () => void` を追加
- `app/src/shared/types.ts` に `WhatsNewData = { version: string; notes: string[] }` を追加
  （`AppNotice` 型の並びに置く）
- `app/src/preload/api-core.ts` に `onWhatsNew` の `listen()` 実装を追加
- `app/src/main/bootstrap.ts`
  - `sendNoticeWhenRendererReady` と同じ「renderer 描画待ち」パターンを再利用する
    汎用ヘルパー（`whenRendererReady(fn)`）を切り出し、両方から使う
  - 分岐ロジックを追加し、`RELEASE_NOTES` を import

既存の「更新ダウンロード完了バナー」（`updater:downloaded` → 再起動を促すバナー、
[App.tsx:501-509](../../../app/src/renderer/src/App.tsx#L501-L509)）とは独立した別チャンネルで、
互いに干渉しない。

## 3. UI

新規コンポーネント `app/src/renderer/src/components/WhatsNewModal.tsx`。
`ConfirmDialog.tsx` と同じ「中央オーバーレイ + パネル」の見た目（`s.overlay` / `s.panel` 相当を
コンポーネント内で自前定義、既存の慣習通り）に統一し、アクションは「閉じる」の1つだけ。

```
┌─────────────────────────────────┐
│ Shiori v1.1.4 の変更点       [×] │
├─────────────────────────────────┤
│ ・〇〇機能を追加しました            │
│ ・××の不具合を修正しました          │
├─────────────────────────────────┤
│                          [閉じる] │
└─────────────────────────────────┘
```

- Props: `{ version: string; notes: string[]; onClose: () => void }`
- Esc キー・オーバーレイクリックで閉じる（`ConfirmDialog` と同じ挙動）
- `App.tsx` に `whatsNew` state（`WhatsNewData | null`）を追加し、
  `useEffect(() => window.api.onWhatsNew(setWhatsNew), [])` で購読、閉じたら `null` に戻す
- 一度閉じれば再表示されない。理由は表示条件が `lastRunVersion` の更新（bootstrap 側で
  検知と同時に保存済み）に紐づくため、次回起動では条件そのものに合致しない

## テスト方針

- `app/src/main/bootstrap.ts` の分岐ロジック（ノートあり/なし/初回起動）を検証する単体テストを追加
  （既存の `*.test.ts` の並びに準拠、`vitest`）
- `WhatsNewModal` の Esc/クリックで閉じる挙動は `ConfirmDialog` 相当のテストがあれば同様に追加、
  無ければ既存コンポーネントの慣習に合わせる
