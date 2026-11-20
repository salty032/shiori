import { useEffect, useRef, useState } from 'react'
import { color, control, font, modal as modalStyles, radius, weight } from '../styles'
import { XIcon } from './Icon'
import ModalFrame from './ModalFrame'
import { useModal } from '../hooks/useModal'
import { useLatestRef } from '../hooks/useLatestRef'
import { useT } from '../i18n'

type Props = {
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
  onClose: () => void
}

export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onClose,
}: Props) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const busyRef = useLatestRef(busy)
  const cancelBtnRef = useRef<HTMLButtonElement>(null)
  // 処理中は閉じない（Escape・幕のクリックとも）。キーも受け取らない。
  const modal = useModal(onClose, {
    canClose: () => !busyRef.current,
    onKey: (e) => {
      if (busyRef.current) return true
      if (e.key === 'Enter' && !e.isComposing) {
        // Tab で「キャンセル」へフォーカスしてから Enter しても確定が走ってしまわないよう、
        // フォーカスがボタン上にあるときはブラウザのネイティブな Enter→click に任せる
        // （そのボタン自身の onClick が正しく呼ばれる）。
        if (document.activeElement instanceof HTMLButtonElement) return true
        e.preventDefault()
        void confirmRef.current()
        return true
      }
      return false
    },
  })

  useEffect(() => {
    // Enter連打による誤確定を避けるため、危険操作を伴うダイアログでは既定フォーカスを
    // 確定側ではなくキャンセル側に置く。
    cancelBtnRef.current?.focus()
  }, [])

  async function handleConfirm(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await onConfirm()
      modal.close()
    } finally {
      setBusy(false)
    }
  }
  const confirmRef = useLatestRef(handleConfirm)

  return (
    <ModalFrame modal={modal}>
      <div style={modalStyles.header}>
        <div style={modalStyles.title}>{title}</div>
        <button style={modalStyles.closeBtn} onClick={() => modal.close()} disabled={busy} title={t('action.close')}><XIcon size={16} /></button>
      </div>
      <div style={s.body}>{message}</div>
      <div style={modalStyles.actions}>
        <button ref={cancelBtnRef} style={modalStyles.cancelBtn} onClick={() => modal.close()} disabled={busy}>{cancelLabel ?? t('action.cancel')}</button>
        <button
          style={{ ...s.confirmBtn, ...(danger ? s.confirmDanger : s.confirmPrimary), opacity: busy ? 0.65 : 1 }}
          onClick={handleConfirm}
          disabled={busy}
        >
          {busy ? t('state.working') : confirmLabel}
        </button>
      </div>
    </ModalFrame>
  )
}

const s: Record<string, React.CSSProperties> = {
  body: { padding: '16px 18px 18px', color: 'var(--text-secondary)', fontSize: font.base, lineHeight: 1.65, whiteSpace: 'pre-wrap' },
  confirmBtn: { height: control.lg, padding: '0 14px', border: '1px solid', borderRadius: radius.md, cursor: 'pointer', fontSize: font.sm, fontWeight: weight.medium },
  confirmPrimary: { background: 'rgba(var(--accent-rgb), 0.16)', borderColor: 'rgba(var(--accent-rgb), 0.48)', color: 'var(--accent-text)' },
  confirmDanger: { background: 'rgba(var(--danger-rgb), 0.12)', borderColor: color.dangerBorder, color: color.danger },
}
