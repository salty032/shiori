import { useEffect, useRef, useState } from 'react'
import { useFocusTrap } from './useFocusTrap'
import { useLatestRef } from './useLatestRef'
import { MODAL_CLOSE_MS } from '../motion'

// モーダル（確認・選択・設定・変更点・初回の案内）に共通の振る舞い。以前は 5 つがそれぞれ自前で書いていた。
//
// - **キーはいちばん上のモーダルだけが受け取る。** 開いた順に積み、document の bubble で 1 つだけ受けて
//   一番上へ渡し、背後（一覧・サイドバーの window のキー操作）へは流さない。設定の上に確認や変更点が
//   重なったとき、Escape で閉じるのは上の 1 つだけ。bubble で受けるのは、モーダルの中の入力欄や
//   ボタン（React のキー操作・フォーカスの閉じ込め）へ先に届けるため。以前は設定画面以外が
//   capture で止めていて、フォーカスの閉じ込め（パネルで受ける）にもキーが届いていなかった。
// - **開いている間、モーダルの外で回したホイールは捨てる。** 幕はスクロールしないので
//   overscroll-behavior が効かず、幕の上で回すと背後の一覧が動いていた（以前は設定画面だけが塞いでいた）。
//   モーダルの中（data-modal）は通す。重なったモーダルの中の一覧も動かせるように。
// - 閉じるときは閉じる動き（MODAL_CLOSE_MS）を見せてから onClose を呼ぶ。

type Entry = { onKey: (e: KeyboardEvent) => void }
const stack: Entry[] = []

function handleKeyDown(e: KeyboardEvent): void {
  const top = stack[stack.length - 1]
  if (!top) return
  e.stopPropagation()
  top.onKey(e)
}

function handleWheel(e: WheelEvent): void {
  if ((e.target as HTMLElement | null)?.closest?.('[data-modal]')) return
  e.preventDefault()
}

function push(entry: Entry): void {
  stack.push(entry)
  if (stack.length !== 1) return
  document.addEventListener('keydown', handleKeyDown)
  // React が付けるホイールは passive なので preventDefault が効かない。capture かつ passive: false で受ける。
  document.addEventListener('wheel', handleWheel, { passive: false, capture: true })
}

function remove(entry: Entry): void {
  const i = stack.indexOf(entry)
  if (i >= 0) stack.splice(i, 1)
  if (stack.length !== 0) return
  document.removeEventListener('keydown', handleKeyDown)
  document.removeEventListener('wheel', handleWheel, { capture: true })
}

export interface ModalOptions {
  /** いま閉じてよいか（処理中・キー入力を待っている間は false）。Escape と幕のクリックの両方に効く */
  canClose?: () => boolean
  /** Escape 以外のキー（確認ダイアログの Enter など）。true を返したら Escape の扱いもしない */
  onKey?: (e: KeyboardEvent) => boolean | void
  /** 閉じ始めた瞬間に呼ぶ（閉じる動きを待たずに済ませたいこと） */
  onClosing?: () => void
}

export interface ModalHandle {
  closing: boolean
  panelRef: React.RefObject<HTMLDivElement | null>
  /** 閉じる動きを見せてから onClose、続けて then を呼ぶ。canClose は見ない（ボタンからの明示的な閉じる） */
  close: (then?: () => void) => void
  /** canClose を見てから閉じる（Escape・幕のクリック） */
  requestClose: () => void
}

export function useModal(onClose: () => void, options: ModalOptions = {}): ModalHandle {
  const [closing, setClosing] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true)

  const closingRef = useRef(false)
  const latest = useLatestRef({ onClose, ...options })
  const close = (then?: () => void): void => {
    if (closingRef.current) return
    closingRef.current = true
    latest.current.onClosing?.()
    setClosing(true)
    window.setTimeout(() => { latest.current.onClose(); then?.() }, MODAL_CLOSE_MS)
  }
  const requestClose = (): void => {
    if (latest.current.canClose && !latest.current.canClose()) return
    close()
  }
  const requestCloseRef = useLatestRef(requestClose)

  useEffect(() => {
    const entry: Entry = {
      onKey: (e) => {
        if (latest.current.onKey?.(e)) return
        if (e.key === 'Escape') {
          e.preventDefault()
          requestCloseRef.current()
        }
      },
    }
    push(entry)
    return () => remove(entry)
  }, [latest, requestCloseRef])

  return { closing, panelRef, close, requestClose }
}
