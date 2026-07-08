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
  overlay: { position: 'fixed', inset: 0, zIndex: 7000, background: 'rgba(3,5,10,0.78)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
  panel: { width: 420, maxWidth: 'calc(100vw - 48px)', background: '#0d0f14', border: '1px solid #252b38', borderRadius: 4, boxShadow: '0 24px 70px rgba(0,0,0,0.62)', overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '18px 18px 12px', borderBottom: '1px solid #20242f' },
  title: { minWidth: 0, color: '#eef1ff', fontSize: font.xl, fontWeight: 800, lineHeight: 1.35 },
  closeBtn: { flexShrink: 0, width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: '#6f778b', cursor: 'pointer', padding: 0 },
  body: { padding: '16px 18px 18px', color: '#aab3c8', fontSize: font.base, lineHeight: 1.65, whiteSpace: 'pre-wrap' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px 16px', background: '#101218', borderTop: '1px solid #20242f' },
  cancelBtn: { height: 34, padding: '0 14px', background: '#171a23', border: '1px solid #2b3243', borderRadius: 3, color: '#dce3f2', cursor: 'pointer', fontSize: font.sm, fontWeight: 800 },
  confirmBtn: { height: 34, padding: '0 14px', border: '1px solid', borderRadius: 3, cursor: 'pointer', fontSize: font.sm, fontWeight: 800 },
  confirmPrimary: { background: 'rgba(111,111,242,0.16)', borderColor: 'rgba(111,111,242,0.48)', color: '#aeb8ff' },
  confirmDanger: { background: 'rgba(255,111,122,0.12)', borderColor: color.dangerBorder, color: color.danger },
}
