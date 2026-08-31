import { useEffect, useRef, useState } from 'react'
import { control, font, modal, radius, space, weight } from '../styles'
import { ChevronDownIcon, XIcon } from './Icon'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useT } from '../i18n'
import type { ReleaseNoteEntry } from '../../../shared/releaseNotes'

const CLOSE_MS = 110

type Props = {
  entries: ReleaseNoteEntry[]
  onClose: () => void
}

// 更新直後に勝手に出るときは entries が 1 件（その版だけ）、設定から開いたときは収録分すべて。
// **1 件のときに版の見出しを出さない。** 出す文面は 1 つしかないのに「Shiori v1.4.0」の帯が
// 題と本文の間に挟まり、同じ版番号が 2 行続く。
export default function WhatsNewModal({ entries, onClose }: Props) {
  const { t } = useT()
  const [closing, setClosing] = useState(false)
  // 先頭（いちばん新しい版）だけ開いておく。全部開くと、いちばん読みたい版のうしろに
  // 過去の版が全部つながって出る（1.2.0 だけで 13 項目ある）。
  const [open, setOpen] = useState<string[]>(entries[0] ? [entries[0].version] : [])
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

  function toggle(version: string): void {
    setOpen((cur) => (cur.includes(version) ? cur.filter((v) => v !== version) : [...cur, version]))
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
  }, [closing])

  const single = entries.length === 1

  return (
    <div style={{ ...s.overlay, animation: closing ? 'shioriOverlayOut 0.11s ease-out forwards' : 'shioriOverlayIn 0.12s ease-out' }} onMouseDown={close}>
      <div style={{ ...s.panel, animation: closing ? 'shioriPopOut 0.11s ease-out forwards' : 'shioriPopIn 0.15s ease-out' }} ref={panelRef} onMouseDown={(e) => e.stopPropagation()} data-modal>
        <div style={s.header}>
          <div style={s.title}>{single ? t('whatsNew.title', { version: entries[0].version }) : t('whatsNew.historyTitle')}</div>
          <button ref={closeBtnRef} style={s.closeBtn} onClick={close} title={t('action.close')}><XIcon size={16} /></button>
        </div>
        <div style={s.body}>
          {entries.map((entry) => (
            <div key={entry.version}>
              {!single && (
                <button style={s.versionBtn} onClick={() => toggle(entry.version)}>
                  <span style={{ ...s.chevron, transform: open.includes(entry.version) ? 'rotate(0deg)' : 'rotate(-90deg)' }}>
                    <ChevronDownIcon size={11} />
                  </span>
                  <span>Shiori v{entry.version}</span>
                </button>
              )}
              {(single || open.includes(entry.version)) && (
                <ul style={s.list}>
                  {entry.notes.map((note, i) => (
                    <li key={i} style={s.item}>{note}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
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
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.x16, padding: '18px 18px 12px', borderBottom: '1px solid var(--border-default)' },
  title: { minWidth: 0, color: 'var(--text-bright)', fontSize: font.xl, fontWeight: weight.medium, lineHeight: 1.35 },
  closeBtn: { flexShrink: 0, width: control.lg, height: control.lg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--surface-rgb), 0.5)', border: '1px solid transparent', borderRadius: radius.md, color: 'var(--text-secondary)', cursor: 'pointer', padding: 0 },
  body: { maxHeight: '50vh', overflowY: 'auto', padding: '4px 0' },
  versionBtn: { display: 'flex', alignItems: 'center', gap: space.x8, width: '100%', padding: '9px 18px', background: 'none', border: 'none', color: 'var(--text-bright)', cursor: 'pointer', fontSize: font.base, fontWeight: weight.medium, textAlign: 'left' },
  chevron: { display: 'inline-flex', color: 'var(--text-secondary)', transition: 'transform 0.12s ease-out' },
  list: { margin: 0, padding: '4px 18px 14px 34px', color: 'var(--text-secondary)', fontSize: font.base, lineHeight: 1.75 },
  item: { marginBottom: 4 },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: space.x8, padding: '12px 18px 16px', background: 'var(--bg-content)', borderTop: '1px solid var(--border-default)' },
  closeAction: { height: control.lg, padding: '0 14px', background: 'rgba(var(--accent-rgb), 0.16)', border: '1px solid rgba(var(--accent-rgb), var(--edge-base))', borderRadius: radius.md, color: 'var(--accent-text)', cursor: 'pointer', fontSize: font.sm, fontWeight: weight.medium },
}
