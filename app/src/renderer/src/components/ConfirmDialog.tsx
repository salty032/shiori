import { useEffect, useRef, useState } from 'react'
import { font, color, modal } from '../styles'
import { XIcon } from './Icon'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useT } from '../i18n'

const CLOSE_MS = 110

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
  const [closing, setClosing] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const cancelBtnRef = useRef<HTMLButtonElement>(null)
  useFocusTrap(panelRef, true)

  useEffect(() => {
    // Enter連打による誤確定を避けるため、危険操作を伴うダイアログでは既定フォーカスを
    // 確定側ではなくキャンセル側に置く。
    cancelBtnRef.current?.focus()
  }, [])

  function close(): void {
    if (closing) return
    setClosing(true)
    window.setTimeout(onClose, CLOSE_MS)
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      e.stopPropagation()
      if (busy) return
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return
      }
      if (e.key === 'Enter' && !e.isComposing) {
        // Tab で「キャンセル」へフォーカスしてから Enter しても確定が走ってしまわないよう、
        // フォーカスがボタン上にあるときはブラウザのネイティブな Enter→click に任せる
        // （そのボタン自身の onClick が正しく呼ばれる）。
        if (document.activeElement instanceof HTMLButtonElement) return
        e.preventDefault()
        handleConfirm()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, closing])

  async function handleConfirm(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await onConfirm()
      close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ ...s.overlay, animation: closing ? 'shioriOverlayOut 0.11s ease-out forwards' : 'shioriOverlayIn 0.12s ease-out' }} onMouseDown={() => { if (!busy) close() }}>
      <div style={{ ...s.panel, animation: closing ? 'shioriPopOut 0.11s ease-out forwards' : 'shioriPopIn 0.15s ease-out' }} ref={panelRef} onMouseDown={(e) => e.stopPropagation()} data-modal>
        <div style={s.header}>
          <div style={s.title}>{title}</div>
          <button style={s.closeBtn} onClick={close} disabled={busy} title={t('action.close')}><XIcon size={16} /></button>
        </div>
        <div style={s.body}>{message}</div>
        <div style={s.actions}>
          <button ref={cancelBtnRef} style={s.cancelBtn} onClick={close} disabled={busy}>{cancelLabel ?? t('action.cancel')}</button>
          <button
            style={{ ...s.confirmBtn, ...(danger ? s.confirmDanger : s.confirmPrimary), opacity: busy ? 0.65 : 1 }}
            onClick={handleConfirm}
            disabled={busy}
          >
            {busy ? t('state.working') : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: modal.overlay,
  panel: modal.panel,
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '18px 18px 12px', borderBottom: '1px solid var(--border-default)' },
  title: { minWidth: 0, color: 'var(--text-bright)', fontSize: font.xl, fontWeight: 800, lineHeight: 1.35 },
  closeBtn: { flexShrink: 0, width: 32, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--surface-rgb), 0.5)', border: '1px solid transparent', borderRadius: 4, color: 'var(--text-secondary)', cursor: 'pointer', padding: 0 },
  body: { padding: '16px 18px 18px', color: 'var(--text-secondary)', fontSize: font.base, lineHeight: 1.65, whiteSpace: 'pre-wrap' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px 16px', background: 'var(--bg-content)', borderTop: '1px solid var(--border-default)' },
  cancelBtn: { height: 34, padding: '0 14px', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 4, color: 'var(--text-primary)', cursor: 'pointer', fontSize: font.sm, fontWeight: 800 },
  confirmBtn: { height: 34, padding: '0 14px', border: '1px solid', borderRadius: 4, cursor: 'pointer', fontSize: font.sm, fontWeight: 800 },
  confirmPrimary: { background: 'rgba(var(--accent-rgb), 0.16)', borderColor: 'rgba(var(--accent-rgb), 0.48)', color: 'var(--accent-text)' },
  confirmDanger: { background: 'rgba(var(--danger-rgb), 0.12)', borderColor: color.dangerBorder, color: color.danger },
}
