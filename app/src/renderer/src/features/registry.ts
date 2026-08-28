// レンダラーのコア（App/DetailPanel/Viewer 等）が参照する拡張点。video/init がここへ登録する。
// コア側はこのファイル以外、video/ を一切 import しない（video/ を消しても core は動く）。
// 動画機能を落とした構成は今のところビルドしていない（main/feature.ts の注記を参照）。
// ただし未登録時のフォールバックは実際に効いている——登録は video/init の副作用なので、
// 初期化の順番次第で「まだ登録されていない」瞬間が存在する。
import { useSyncExternalStore, type ReactNode } from 'react'
import type { ImageRow } from '../types'
import type { ClipFrames } from '../../../shared/api.video'
import type { MenuItem } from '../components/ContextMenu'

// close: 呼び出し元がフルスクリーンのオーバーレイ（Viewer 等）で、そのアクションが
// 別のオーバーレイ（VideoTrimmer 等）を開く場合に、キー入力の二重発火を避けるため
// 先に自身を閉じたいときに渡す。DetailPanel のような非オーバーレイからは渡されない。
type MediaActionSlot = (img: ImageRow, ctx?: { close?: () => void }) => ReactNode | null
type ContextMenuSlot = (img: ImageRow) => MenuItem[]
type ModalSlot = () => ReactNode

// SettingsModal のタブ識別子。タブ自体はコアが定義するので、ここでは文字列リテラルで持つ
// （video 側から見たときの依存先を registry だけに留めるため、SettingsModal 型は import しない）。
// SettingsModal の TabId と同じ値を並べること。表示ラベルは言語で変わるので識別子には使わない。
type SettingsTab = 'general' | 'capture' | 'tag' | 'data'
// onCapturingChange: スロットが独自にキー入力キャプチャ UI（ホットキー変更など）を
// 開いている間 true を報告する。SettingsModal はこれを見て Escape での自動クローズを
// 一時停止する（スロット側の状態は SettingsModal から見えないため、明示的に橋渡しする）。
type SettingsSlotPlacement = 'hotkey' | 'notification'
type SettingsSlot = (props: { onCapturingChange: (capturing: boolean) => void; placement?: SettingsSlotPlacement }) => ReactNode

// クリップのコマ情報（実フレーム時刻と、コマごとの確からしさ）の取得口。コマ送りを
// 素材の実コマへ吸着させるためにビューアのプレーヤー（コア側）が使うが、取得そのものは
// video/ の IPC なのでここで橋渡しする。
// 未登録なら呼び出し側が fps 換算のコマ送りにフォールバックする。
type ClipFramesResolver = (imageId: number) => Promise<ClipFrames>
let clipFramesResolver: ClipFramesResolver | null = null

export function registerClipFramesResolver(fn: ClipFramesResolver): void {
  clipFramesResolver = fn
}

export function getClipFramesResolver(): ClipFramesResolver | null {
  return clipFramesResolver
}

// Web デモ版として動いているか。**コアが web/ を import しないための橋渡し**で、
// mockApi が window.api を差すときに立てる（デスクトップ本体では誰も呼ばないので false）。
//
// 必要な理由は空ライブラリの画面。デスクトップ版の初回案内は「拡張機能フォルダを開く →
// 対応サイトで動画を開く → ホットキーを押す」だが、デモではボタンを押しても
// 「デモ版では利用できません」と断るだけで、ホットキーも効かない。**案内が全部空振りする
// 画面を第一印象として出すことになる**ため、デモ専用の説明へ差し替える。
let demoMode = false

export function markDemoMode(): void {
  demoMode = true
}

export function isDemoMode(): boolean {
  return demoMode
}

// 機能側のフルスクリーンオーバーレイ（VideoTrimmer 等）が開いている間だけ立つ合図。
// コアは video/ を import しないので、開いたことをここ経由で受け取る。
//
// 無いと困るのは音。トリミング画面はビューアと詳細パネルを覆うが、覆われたプレーヤーは
// 止まらないので、裏の映像がそのまま鳴り続けてトリマーの音と重なる。**隠れた映像は止める**は
// DetailPanel の pauseWhen={viewerOpen} と VideoPlayer の visibilitychange で既に採っている
// 方針で、これはその 3 つ目。止めるだけで、閉じても再生は再開しない（上の 2 つと同じ）。
//
// 真偽値ではなく数で持つ：閉じ際に次のオーバーレイが開いて一瞬重なると、真偽値では
// 先に閉じた方が「閉じた」と書き潰してしまう。
let featureOverlayCount = 0
const featureOverlayListeners = new Set<() => void>()

// オーバーレイを開いている間に呼び、閉じるときに戻り値を呼ぶ
// （useEffect のクリーンアップにそのまま返せる形）。
export function markFeatureOverlayOpen(): () => void {
  featureOverlayCount++
  for (const fn of featureOverlayListeners) fn()
  let released = false
  return () => {
    if (released) return
    released = true
    featureOverlayCount--
    for (const fn of featureOverlayListeners) fn()
  }
}

const subscribeFeatureOverlay = (fn: () => void): (() => void) => {
  featureOverlayListeners.add(fn)
  return () => featureOverlayListeners.delete(fn)
}

export function useFeatureOverlayOpen(): boolean {
  return useSyncExternalStore(subscribeFeatureOverlay, () => featureOverlayCount > 0)
}

const mediaActionSlots: MediaActionSlot[] = []
const contextMenuSlots: ContextMenuSlot[] = []
const modalSlots: ModalSlot[] = []
const settingsSlots: Record<SettingsTab, SettingsSlot[]> = { general: [], capture: [], tag: [], data: [] }

export function registerMediaAction(fn: MediaActionSlot): void {
  mediaActionSlots.push(fn)
}

export function registerContextMenuItems(fn: ContextMenuSlot): void {
  contextMenuSlots.push(fn)
}

export function registerModal(fn: ModalSlot): void {
  modalSlots.push(fn)
}

export function registerSettingsSlot(tab: SettingsTab, fn: SettingsSlot): void {
  settingsSlots[tab].push(fn)
}

export function getMediaActions(img: ImageRow, ctx?: { close?: () => void }): ReactNode[] {
  return mediaActionSlots.map((fn) => fn(img, ctx)).filter((node): node is ReactNode => node != null)
}

export function getExtraContextMenuItems(img: ImageRow): MenuItem[] {
  return contextMenuSlots.flatMap((fn) => fn(img))
}

export function getModals(): ModalSlot[] {
  return modalSlots
}

export function getSettingsSlots(tab: SettingsTab): SettingsSlot[] {
  return settingsSlots[tab]
}
