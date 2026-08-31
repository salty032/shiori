import { useEffect, useRef, useState } from 'react'
import type { ExtensionTimecode } from '../types'
import type { SetupGuideState } from '../setupGuideState'
import { control, font, modal, radius, space, weight } from '../styles'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useT } from '../i18n'
import { XIcon } from './Icon'

const CLOSE_MS = 110
const EXTENSION_TIMEOUT_MS = 15_000

type Props = {
  state: SetupGuideState
  captureHotkey: string
  extensionStatus: { lastSeenAt: number; data: ExtensionTimecode } | null
  canStartTour: boolean
  onStartTour: () => void
  onChange: (patch: Partial<SetupGuideState>) => void
  onClose: () => void
}

export default function SetupGuideModal({ state, captureHotkey, extensionStatus, canStartTour, onStartTour, onChange, onClose }: Props) {
  const { t } = useT()
  const [closing, setClosing] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const panelRef = useRef<HTMLDivElement>(null)
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  useFocusTrap(panelRef, true)

  const extensionConnected = extensionStatus !== null && now - extensionStatus.lastSeenAt <= EXTENSION_TIMEOUT_MS
  const completed = Number(state.browserPrepared) + Number(state.extensionReady) + Number(state.firstCaptureDone)

  useEffect(() => {
    closeBtnRef.current?.focus()
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  function close(): void {
    if (closing) return
    onChange({ tutorialSeen: true })
    setClosing(true)
    window.setTimeout(onClose, CLOSE_MS)
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); close() }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing])

  const steps = [
    {
      done: state.browserPrepared,
      title: t('setup.browserTitle'),
      body: t('setup.browserBody'),
      detail: t('setup.browserDetail'),
      action: (
        <label style={s.confirmLabel}>
          <input type="checkbox" checked={state.browserPrepared} disabled={state.firstCaptureDone}
            onChange={(e) => onChange({ browserPrepared: e.target.checked })} />
          <span>{t('setup.browserConfirm')}</span>
        </label>
      ),
    },
    {
      done: state.extensionReady,
      title: t('setup.extensionTitle'),
      body: t('setup.extensionBody'),
      detail: t('setup.extensionDetail'),
      action: (
        <div style={s.actionRow}>
          <button style={s.primaryBtn} onClick={() => window.api.showExtensionFolder()}>{t('onboarding.openExtensionFolder')}</button>
          <span style={{ ...s.status, ...(extensionConnected ? s.statusLive : state.extensionReady ? s.statusDone : {}) }}>
            {t(extensionConnected ? 'setup.receiving' : state.extensionReady ? 'setup.detectedBefore' : 'setup.waiting')}
          </span>
        </div>
      ),
    },
    {
      done: state.firstCaptureDone,
      title: t('setup.captureTitle'),
      body: t('setup.captureBody'),
      detail: t('setup.captureDetail', { hotkey: captureHotkey }),
      action: (
        <span style={{ ...s.status, ...(state.firstCaptureDone ? s.statusDone : {}) }}>
          {t(state.firstCaptureDone ? 'setup.captureDone' : 'setup.captureWaiting')}
        </span>
      ),
    },
  ]

  return (
    <div style={{ ...s.overlay, animation: closing ? 'shioriOverlayOut 0.11s ease-out forwards' : 'shioriOverlayIn 0.12s ease-out' }} onMouseDown={close}>
      <div ref={panelRef} style={{ ...s.panel, animation: closing ? 'shioriPopOut 0.11s ease-out forwards' : 'shioriPopIn 0.15s ease-out' }} onMouseDown={(e) => e.stopPropagation()} data-modal>
        <div style={s.header}>
          <div>
            <div style={s.title}>{t('setup.title')}</div>
            <div style={s.subtitle}>{t('setup.progress', { completed, total: 3 })}</div>
          </div>
          <button ref={closeBtnRef} style={s.closeBtn} onClick={close} title={t('action.close')}><XIcon size={16} /></button>
        </div>
        <div style={s.content}>
          <div style={s.intro}>{t('setup.intro')}</div>
          {steps.map((step, index) => (
            <section key={index} style={{ ...s.step, ...(step.done ? s.stepDone : {}) }}>
              <div style={{ ...s.stepNumber, ...(step.done ? s.stepNumberDone : {}) }}>{step.done ? '✓' : index + 1}</div>
              <div style={s.stepContent}>
                <div style={s.stepTitle}>{step.title}</div>
                <div style={s.stepBody}>{step.body}</div>
                <div style={s.stepDetail}>{step.detail}</div>
                <div style={s.stepAction}>{step.action}</div>
              </div>
            </section>
          ))}
        </div>
        <div style={s.footer}>
          <div>
            <button style={{ ...s.tourBtn, ...(!canStartTour ? s.tourBtnDisabled : {}) }} disabled={!canStartTour} onClick={onStartTour}>{t('tour.start')}</button>
            <div style={s.tourHint}>{t(canStartTour ? 'tour.startHint' : 'tour.needsItem')}</div>
          </div>
          <button style={s.closeAction} onClick={close}>{t(completed === 3 ? 'setup.finish' : 'setup.closeForNow')}</button>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: modal.overlay,
  panel: { ...modal.panel, width: 620, maxHeight: 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column' },
  header: { flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.x16, padding: '18px 20px 14px', borderBottom: '1px solid var(--border-default)' },
  title: { color: 'var(--text-bright)', fontSize: font.xl, fontWeight: weight.medium, lineHeight: 1.35 },
  subtitle: { marginTop: 3, color: 'var(--text-muted)', fontSize: font.sm, fontWeight: weight.normal },
  closeBtn: { flexShrink: 0, width: control.lg, height: control.lg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--surface-rgb), 0.5)', border: '1px solid transparent', borderRadius: radius.md, color: 'var(--text-secondary)', cursor: 'pointer', padding: 0 },
  content: { minHeight: 0, overflowY: 'auto', padding: '16px 20px 18px', display: 'flex', flexDirection: 'column', gap: space.x8 },
  intro: { color: 'var(--text-secondary)', fontSize: font.base, lineHeight: 1.65, marginBottom: 2 },
  step: { display: 'flex', alignItems: 'flex-start', gap: space.x12, padding: 14, background: 'var(--bg-content)', border: '1px solid var(--border-default)', borderRadius: radius.md },
  stepDone: { borderColor: 'rgba(var(--success-rgb), 0.42)', background: 'rgba(var(--success-rgb), 0.045)' },
  stepNumber: { flexShrink: 0, width: control.sm, height: control.sm, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 999, background: 'rgba(var(--accent-rgb), 0.14)', border: '1px solid rgba(var(--accent-rgb), 0.42)', color: 'var(--accent-text)', fontSize: font.sm, fontWeight: weight.strong },
  stepNumberDone: { background: 'rgba(var(--success-rgb), 0.16)', borderColor: 'rgba(var(--success-rgb), 0.5)', color: 'var(--success)' },
  stepContent: { minWidth: 0, flex: 1 },
  stepTitle: { color: 'var(--text-primary)', fontSize: font.base, fontWeight: weight.medium, lineHeight: 1.45 },
  stepBody: { marginTop: 4, color: 'var(--text-secondary)', fontSize: font.sm, lineHeight: 1.55 },
  stepDetail: { marginTop: 4, color: 'var(--text-muted)', fontSize: font.sm, lineHeight: 1.55, whiteSpace: 'pre-line' },
  stepAction: { marginTop: 10 },
  actionRow: { display: 'flex', alignItems: 'center', gap: space.x8, flexWrap: 'wrap' },
  primaryBtn: { height: control.lg, padding: '0 13px', background: 'rgba(var(--accent-rgb), 0.16)', border: '1px solid rgba(var(--accent-rgb), 0.44)', borderRadius: radius.md, color: 'var(--accent-text)', cursor: 'pointer', fontSize: font.sm, fontWeight: weight.medium },
  confirmLabel: { display: 'inline-flex', alignItems: 'center', gap: space.x8, color: 'var(--text-secondary)', fontSize: font.sm, fontWeight: weight.normal, cursor: 'pointer' },
  status: { display: 'inline-flex', alignItems: 'center', minHeight: control.sm, padding: '0 9px', borderRadius: 999, background: 'rgba(var(--surface-rgb), 0.75)', border: '1px solid var(--border-default)', color: 'var(--text-muted)', fontSize: font.xs, fontWeight: weight.normal },
  statusLive: { background: 'rgba(var(--success-rgb), 0.13)', borderColor: 'rgba(var(--success-rgb), 0.44)', color: 'var(--success)' },
  statusDone: { background: 'rgba(var(--success-rgb), 0.08)', borderColor: 'rgba(var(--success-rgb), 0.3)', color: 'var(--success)' },
  footer: { flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.x16, padding: '12px 20px 16px', background: 'var(--bg-content)', borderTop: '1px solid var(--border-default)' },
  tourBtn: { padding: 0, background: 'transparent', border: 'none', color: 'var(--accent-text)', cursor: 'pointer', fontSize: font.sm, fontWeight: weight.medium, textDecoration: 'underline' },
  tourBtnDisabled: { color: 'var(--text-muted)', cursor: 'not-allowed', textDecoration: 'none' },
  tourHint: { marginTop: 3, color: 'var(--text-muted)', fontSize: font.xs },
  closeAction: { flexShrink: 0, height: control.lg, padding: '0 14px', background: 'rgba(var(--accent-rgb), 0.16)', border: '1px solid rgba(var(--accent-rgb), 0.48)', borderRadius: radius.md, color: 'var(--accent-text)', cursor: 'pointer', fontSize: font.sm, fontWeight: weight.medium },
}
