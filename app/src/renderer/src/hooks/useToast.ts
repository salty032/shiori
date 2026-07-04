import { useCallback, useRef, useState } from 'react'

export type ToastTone = 'info' | 'success' | 'warning' | 'error'
export type ToastAction = { label: string; onClick: () => void }
// 戻り値は追加されたトーストの id。updateToast で同じトーストを差し替えたい呼び出し元
// （例: deleteImages の「削除中…」→完了メッセージ）が使う。
export type ShowToast = (message: string, tone?: ToastTone, ms?: number, action?: ToastAction) => number
export type UpdateToast = (id: number, message: string, tone?: ToastTone, ms?: number, action?: ToastAction) => void
export type DismissToast = (id: number) => void

export type ToastItem = {
  id: number
  message: string
  tone: ToastTone
  action: ToastAction | null
  // true の間だけ消滅アニメーション(shioriToastOut)を出す。アニメーション終了後に配列から除く。
  closing: boolean
}

// 同時に積み上げる最大件数。超えたら最古のものを落とす。
const MAX_TOASTS = 3
// 消滅アニメーションの長さ(ms)。App.tsx の shioriToastOut 指定秒数と合わせる。
const EXIT_MS = 300

// ms を明示指定しない呼び出しは全トーン共通でこの秒数に統一する。呼び出し側ごとに
// バラバラだと、素早く連続操作したときに短命なトーストだけ先に消えて
// スタックの並びが不自然にジャンプするため、トーンで分けず一律にする。
// 削除の「元に戻す」トースト（useSelection.ts の DELETE_UNDO_MS）は値こそ同じだが、
// 実際に元に戻せる猶予と表示時間を一致させる意図で個別に ms を明示している。
const DEFAULT_TOAST_MS = 4000

// 画面下中央にトーストを複数スタック表示する。以前は単一スロットで新しい通知が来ると
// 即座に置き換えていたため、削除の「元に戻す」付きトーストが表示期限の途中で
// 別の通知（キャプチャ完了など）に消されてしまう問題があった。
// アクション付きトーストも自分の期限まで他のトーストに邪魔されないよう、
// 複数を id ベースで独立管理する。
export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const idRef = useRef(0)
  const timersRef = useRef<Map<number, number>>(new Map())

  const clearTimer = (id: number): void => {
    const timer = timersRef.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }

  const removeToast = (id: number): void => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  // 即座に配列から消さず、まず closing:true にして shioriToastOut を再生してから除去する。
  const beginClose = (id: number): void => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, closing: true } : t)))
    window.setTimeout(() => removeToast(id), EXIT_MS)
  }

  const scheduleDismiss = (id: number, ms: number | undefined): void => {
    clearTimer(id)
    const duration = ms ?? DEFAULT_TOAST_MS
    const timer = window.setTimeout(() => {
      timersRef.current.delete(id)
      beginClose(id)
    }, duration)
    timersRef.current.set(id, timer)
  }

  const showToast = useCallback<ShowToast>((message, tone = 'info', ms, action) => {
    const id = ++idRef.current
    setToasts((prev) => {
      const next = [...prev, { id, message, tone, action: action ?? null, closing: false }]
      if (next.length <= MAX_TOASTS) return next
      // 上限超過分（最古側）は表示から落とし、タイマーも解除する
      const overflow = next.slice(0, next.length - MAX_TOASTS)
      overflow.forEach((t) => clearTimer(t.id))
      return next.slice(next.length - MAX_TOASTS)
    })
    scheduleDismiss(id, ms)
    return id
  }, [])

  // 「進捗中…」のように、同じ操作の続きとして既存トーストの内容を差し替える。
  // 対象の id が既に消えていた場合（タイムアウト/上限落ち）は新規追加として扱う。
  const updateToast = useCallback<UpdateToast>((id, message, tone = 'info', ms, action) => {
    setToasts((prev) => {
      if (prev.some((t) => t.id === id)) {
        return prev.map((t) => (t.id === id ? { id, message, tone, action: action ?? null, closing: false } : t))
      }
      const next = [...prev, { id, message, tone, action: action ?? null, closing: false }]
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next
    })
    scheduleDismiss(id, ms)
  }, [])

  const dismissToast = useCallback<DismissToast>((id) => {
    clearTimer(id)
    beginClose(id)
  }, [])

  return { showToast, updateToast, dismissToast, toasts }
}
