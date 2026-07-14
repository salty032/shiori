import { useEffect, useState } from 'react'
import { font, color } from '../styles'
import { XIcon } from './Icon'

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
  cancelLabel = 'キャンセル',
  danger = false,
  onConfirm,
  onClose,
}: Props) {
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      e.stopPropagation()
      if (busy) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
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
  }, [busy])

  async function handleConfirm(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await onConfirm()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={s.overlay} onMouseDown={() => { if (!busy) onClose() }}>
      <div style={s.panel} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <div style={s.header}>
          <div id="confirm-dialog-title" style={s.title}>{title}</div>
          <button style={s.closeBtn} onClick={onClose} disabled={busy} title="閉じる"><XIcon size={16} /></button>
        </div>
        <div style={s.body}>{message}</div>
        <div style={s.actions}>
          <button style={s.cancelBtn} onClick={onClose} disabled={busy}>{cancelLabel}</button>
          <button
            style={{ ...s.confirmBtn, ...(danger ? s.confirmDanger : s.confirmPrimary), opacity: busy ? 0.65 : 1 }}
            onClick={handleConfirm}
            disabled={busy}
          >
            {busy ? '処理中...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, zIndex: 7000, background: 'rgba(var(--scrim-rgb), 0.78)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
  panel: { width: 420, maxWidth: 'calc(100vw - 48px)', background: 'var(--bg-page)', border: '1px solid var(--border-default)', borderRadius: 4, boxShadow: '0 24px 70px rgba(var(--scrim-rgb), 0.62)', overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '18px 18px 12px', borderBottom: '1px solid var(--border-default)' },
  title: { minWidth: 0, color: 'var(--text-bright)', fontSize: font.xl, fontWeight: 800, lineHeight: 1.35 },
  closeBtn: { flexShrink: 0, width: 32, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--surface-rgb), 0.5)', border: '1px solid transparent', borderRadius: 4, color: 'var(--text-secondary)', cursor: 'pointer', padding: 0 },
  body: { padding: '16px 18px 18px', color: 'var(--text-secondary)', fontSize: font.base, lineHeight: 1.65, whiteSpace: 'pre-wrap' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px 16px', background: 'var(--bg-content)', borderTop: '1px solid var(--border-default)' },
  cancelBtn: { height: 34, padding: '0 14px', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 3, color: 'var(--text-primary)', cursor: 'pointer', fontSize: font.sm, fontWeight: 800 },
  confirmBtn: { height: 34, padding: '0 14px', border: '1px solid', borderRadius: 3, cursor: 'pointer', fontSize: font.sm, fontWeight: 800 },
  confirmPrimary: { background: 'rgba(var(--accent-rgb), 0.16)', borderColor: 'rgba(var(--accent-rgb), 0.48)', color: 'var(--accent-text)' },
  confirmDanger: { background: 'rgba(var(--danger-rgb), 0.12)', borderColor: color.dangerBorder, color: color.danger },
}
