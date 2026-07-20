import { useEffect, useRef, useState } from 'react'
import { font, modal } from '../styles'
import { XIcon } from './Icon'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useT } from '../i18n'

const CLOSE_MS = 110

type Props = {
  version: string
  notes: string[]
  onClose: () => void
}

export default function WhatsNewModal({ version, notes, onClose }: Props) {
  const { t } = useT()
  const [closing, setClosing] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  useFocusTrap(panelRef, true)

  useEffect(() => {
    closeBtnRef.current?.focus()
  }, [])

  function close(): void {
    if (closing) return
    setClosing(true)
    window.setTimeout(onClose, CLOSE_MS)
  }

  useEffect(() => {
    // 背後のグリッド（useSelection の window keydown ハンドラ）に Ctrl+A/Escape/Ctrl+Z 等が
    // 素通りしないよう、ConfirmDialog と同様に document capture で全キーを止める。
    const handler = (e: KeyboardEvent): void => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing])

  return (
    <div style={{ ...s.overlay, animation: closing ? 'shioriOverlayOut 0.11s ease-out forwards' : 'shioriOverlayIn 0.12s ease-out' }} onMouseDown={close}>
      <div style={{ ...s.panel, animation: closing ? 'shioriPopOut 0.11s ease-out forwards' : 'shioriPopIn 0.15s ease-out' }} ref={panelRef} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="whats-new-title">
        <div style={s.header}>
          <div id="whats-new-title" style={s.title}>{t('whatsNew.title', { version })}</div>
          <button ref={closeBtnRef} style={s.closeBtn} onClick={close} title={t('action.close')}><XIcon size={16} /></button>
        </div>
        <ul style={s.list}>
          {notes.map((note, i) => (
            <li key={i} style={s.item}>{note}</li>
          ))}
        </ul>
        <div style={s.actions}>
          <button style={s.closeAction} onClick={close}>{t('action.close')}</button>
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
  list: { margin: 0, padding: '16px 18px 18px 34px', color: 'var(--text-secondary)', fontSize: font.base, lineHeight: 1.75, maxHeight: '50vh', overflowY: 'auto' },
  item: { marginBottom: 4 },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px 16px', background: 'var(--bg-content)', borderTop: '1px solid var(--border-default)' },
  closeAction: { height: 34, padding: '0 14px', background: 'rgba(var(--accent-rgb), 0.16)', border: '1px solid rgba(var(--accent-rgb), 0.48)', borderRadius: 3, color: 'var(--accent-text)', cursor: 'pointer', fontSize: font.sm, fontWeight: 800 },
}
