import { useEffect, useRef, useState } from 'react'
import { control, font, modal, radius, space, weight } from '../styles'
import { XIcon } from './Icon'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useLatestRef } from '../hooks/useLatestRef'
import { useT } from '../i18n'
import { MODAL_CLOSE_MS, modalOverlayAnimation, modalPanelAnimation } from '../motion'

// どちらかを選んでもらう確認（ライブラリのインポートの「戻す／受け取る」など）。
//
// ConfirmDialog（確定とキャンセル）に選択肢を足すと、ボタンの文字が折り返し、説明を本文に
// 長々と書くことになった。**選択肢は「名前＋短い説明」の大きなボタンとして縦に並べる。**
// 選んだら閉じてから onSelect を呼ぶ（選んだ先が分単位の処理でも、確認を開いたまま待たせない）。
export type Choice = { label: string; description: string; onSelect: () => void }

type Props = {
  title: string
  message: string
  choices: Choice[]
  onClose: () => void
}

export default function ChoiceDialog({ title, message, choices, onClose }: Props) {
  const { t } = useT()
  const [closing, setClosing] = useState(false)
  const [hovered, setHovered] = useState<number | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true)

  function close(then?: () => void): void {
    if (closing) return
    setClosing(true)
    window.setTimeout(() => { onClose(); then?.() }, MODAL_CLOSE_MS)
  }

  const closeRef = useLatestRef(close)
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        closeRef.current()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [closeRef])

  return (
    <div style={{ ...s.overlay, animation: modalOverlayAnimation(closing) }} onMouseDown={() => close()}>
      <div style={{ ...s.panel, animation: modalPanelAnimation(closing) }} ref={panelRef} onMouseDown={(e) => e.stopPropagation()} data-modal>
        <div style={s.header}>
          <div style={s.title}>{title}</div>
          <button style={s.closeBtn} onClick={() => close()} title={t('action.close')}><XIcon size={16} /></button>
        </div>
        <div style={s.body}>
          <div style={s.message}>{message}</div>
          <div style={s.choices}>
            {choices.map((choice, i) => (
              <button
                key={choice.label}
                style={{ ...s.choice, ...(hovered === i ? s.choiceHover : {}) }}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => close(choice.onSelect)}
              >
                <span style={s.choiceLabel}>{choice.label}</span>
                <span style={s.choiceDescription}>{choice.description}</span>
              </button>
            ))}
          </div>
        </div>
        <div style={s.actions}>
          <button style={s.cancelBtn} onClick={() => close()}>{t('action.cancel')}</button>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: modal.overlay,
  panel: { ...modal.panel, width: 460 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.x16, padding: '18px 18px 12px', borderBottom: '1px solid var(--border-default)' },
  title: { minWidth: 0, color: 'var(--text-bright)', fontSize: font.xl, fontWeight: weight.medium, lineHeight: 1.35 },
  closeBtn: { flexShrink: 0, width: control.lg, height: control.lg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--surface-rgb), 0.5)', border: '1px solid transparent', borderRadius: radius.md, color: 'var(--text-secondary)', cursor: 'pointer', padding: 0 },
  body: { padding: '16px 18px 18px', display: 'flex', flexDirection: 'column', gap: space.x12 },
  message: { color: 'var(--text-primary)', fontSize: font.base, lineHeight: 1.6 },
  choices: { display: 'flex', flexDirection: 'column', gap: space.x8 },
  choice: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3, width: '100%', padding: '11px 14px', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, cursor: 'pointer', textAlign: 'left', transition: 'background 0.12s ease, border-color 0.12s ease' },
  choiceHover: { background: 'rgba(var(--accent-rgb), 0.10)', borderColor: 'rgba(var(--accent-rgb), 0.48)' },
  choiceLabel: { color: 'var(--text-bright)', fontSize: font.base, fontWeight: weight.medium, lineHeight: 1.4 },
  // 説明は「何をするか」と「どんなときに使うか」を改行で分けて渡す（言葉の途中で折り返さないように）。
  choiceDescription: { color: 'var(--text-secondary)', fontSize: font.sm, lineHeight: 1.55, whiteSpace: 'pre-line' },
  actions: { display: 'flex', justifyContent: 'flex-end', padding: '12px 18px 16px', background: 'var(--bg-content)', borderTop: '1px solid var(--border-default)' },
  cancelBtn: { height: control.lg, padding: '0 14px', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, color: 'var(--text-primary)', cursor: 'pointer', fontSize: font.sm, fontWeight: weight.medium, whiteSpace: 'nowrap' },
}
