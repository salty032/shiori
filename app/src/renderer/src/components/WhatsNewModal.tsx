import { useEffect, useRef, useState } from 'react'
import { control, font, modal as modalStyles, radius, space, weight } from '../styles'
import { ChevronDownIcon, XIcon } from './Icon'
import ModalFrame from './ModalFrame'
import { useModal } from '../hooks/useModal'
import { useT } from '../i18n'
import type { ReleaseNoteEntry } from '../../../shared/releaseNotes'

type Props = {
  entries: ReleaseNoteEntry[]
  onClose: () => void
}

// 更新直後に勝手に出るときは entries が 1 件（その版だけ）、設定から開いたときは収録分すべて。
// **1 件のときに版の見出しを出さない。** 出す文面は 1 つしかないのに「Shiori v1.4.0」の帯が
// 題と本文の間に挟まり、同じ版番号が 2 行続く。
export default function WhatsNewModal({ entries, onClose }: Props) {
  const { t } = useT()
  // 先頭（いちばん新しい版）だけ開いておく。全部開くと、いちばん読みたい版のうしろに
  // 過去の版が全部つながって出る（1.2.0 だけで 13 項目ある）。
  const [open, setOpen] = useState<string[]>(entries[0] ? [entries[0].version] : [])
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const modal = useModal(onClose)

  useEffect(() => {
    closeBtnRef.current?.focus()
  }, [])

  function toggle(version: string): void {
    setOpen((cur) => (cur.includes(version) ? cur.filter((v) => v !== version) : [...cur, version]))
  }

  const single = entries.length === 1

  return (
    <ModalFrame modal={modal}>
        <div style={modalStyles.header}>
          <div style={modalStyles.title}>{single ? t('whatsNew.title', { version: entries[0].version }) : t('whatsNew.historyTitle')}</div>
          <button ref={closeBtnRef} style={modalStyles.closeBtn} onClick={() => modal.close()} title={t('action.close')}><XIcon size={16} /></button>
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
        <div style={modalStyles.actions}>
          <button style={s.closeAction} onClick={() => modal.close()}>{t('action.close')}</button>
        </div>
    </ModalFrame>
  )
}

const s: Record<string, React.CSSProperties> = {
  body: { maxHeight: '50vh', overflowY: 'auto', padding: '4px 0' },
  versionBtn: { display: 'flex', alignItems: 'center', gap: space.x8, width: '100%', padding: '9px 18px', background: 'none', border: 'none', color: 'var(--text-bright)', cursor: 'pointer', fontSize: font.base, fontWeight: weight.medium, textAlign: 'left' },
  chevron: { display: 'inline-flex', color: 'var(--text-secondary)', transition: 'transform 0.12s ease-out' },
  list: { margin: 0, padding: '4px 18px 14px 34px', color: 'var(--text-secondary)', fontSize: font.base, lineHeight: 1.75 },
  item: { marginBottom: 4 },
  closeAction: { height: control.lg, padding: '0 14px', background: 'rgba(var(--accent-rgb), 0.16)', border: '1px solid rgba(var(--accent-rgb), var(--edge-base))', borderRadius: radius.md, color: 'var(--accent-text)', cursor: 'pointer', fontSize: font.sm, fontWeight: weight.medium },
}
