// レンダラーのコア（App/DetailPanel/Viewer 等）が参照する拡張点。
// full 版のみが読み込む video/init 等がここへ登録する。コア側はこのファイル以外、
// video/ を一切 import しない（capture ソースドロップで video/ を消しても core はそのまま動く）。
import type { ReactNode } from 'react'
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
export type SettingsTab = 'general' | 'capture' | 'tag' | 'data'
// onCapturingChange: スロットが独自にキー入力キャプチャ UI（ホットキー変更など）を
// 開いている間 true を報告する。SettingsModal はこれを見て Escape での自動クローズを
// 一時停止する（スロット側の状態は SettingsModal から見えないため、明示的に橋渡しする）。
export type SettingsSlotPlacement = 'hotkey' | 'notification'
type SettingsSlot = (props: { onCapturingChange: (capturing: boolean) => void; placement?: SettingsSlotPlacement }) => ReactNode

// クリップのコマ情報（実フレーム時刻と、コマごとの確からしさ）の取得口。コマ送りを
// 素材の実コマへ吸着させるためにビューアのプレーヤー（コア側）が使うが、取得そのものは
// video/ の IPC なのでここで橋渡しする。
// 未登録（capture 版）なら呼び出し側が fps 換算のコマ送りにフォールバックする。
type ClipFramesResolver = (imageId: number) => Promise<ClipFrames>
let clipFramesResolver: ClipFramesResolver | null = null

export function registerClipFramesResolver(fn: ClipFramesResolver): void {
  clipFramesResolver = fn
}

export function getClipFramesResolver(): ClipFramesResolver | null {
  return clipFramesResolver
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
