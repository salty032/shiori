import { useEffect, useLayoutEffect, useState } from 'react'
import { font } from '../styles'
import { useT, type MessageKey } from '../i18n'

export type ProductTourStep = 0 | 1 | 2 | 3 | 4 | 5

type Props = {
  step: ProductTourStep
  onAdvance: () => void
  onExit: () => void
}

const STEPS: { selector: string; title: MessageKey; body: MessageKey; event?: 'interact' }[] = [
  { selector: '[data-img-id]', title: 'tour.selectTitle', body: 'tour.selectBody' },
  { selector: '[aria-selected="true"]', title: 'tour.openTitle', body: 'tour.openBody' },
  { selector: '[data-tour="viewer-close"]', title: 'tour.viewerTitle', body: 'tour.viewerBody' },
  { selector: '[data-tour="memo-input"]', title: 'tour.memoTitle', body: 'tour.memoBody', event: 'interact' },
  { selector: '[data-tour="timeline-toggle"]', title: 'tour.timelineTitle', body: 'tour.timelineBody' },
  { selector: '[data-tour="search-input"]', title: 'tour.searchTitle', body: 'tour.searchBody', event: 'interact' },
]

export default function ProductTour({ step, onAdvance, onExit }: Props) {
  const { t } = useT()
  const [rect, setRect] = useState<DOMRect | null>(null)
  const definition = STEPS[step]

  useLayoutEffect(() => {
    let frame = 0
    const update = (): void => {
      const target = document.querySelector<HTMLElement>(definition.selector)
      const next = target?.getBoundingClientRect() ?? null
      setRect((current) => {
        if (!current || !next) return current === next ? current : next
        return current.left === next.left && current.top === next.top &&
          current.width === next.width && current.height === next.height ? current : next
      })
      frame = window.requestAnimationFrame(update)
    }
    update()
    return () => window.cancelAnimationFrame(frame)
  }, [definition.selector])

  useEffect(() => {
    if (!definition.event) return
    // ステップ切替と同じ描画で対象欄が現れることがあるため、要素を一度だけ検索して直接
    // 購読すると取り逃がす。document の capture で、後から描画・差し替えられた対象も拾う。
    let handled = false
    const handler = (event: Event): void => {
      if (handled) return
      const target = event.target as Element | null
      if (target?.closest(definition.selector)) {
        handled = true
        onAdvance()
      }
    }
    document.addEventListener('pointerdown', handler, true)
    document.addEventListener('focusin', handler, true)
    return () => {
      document.removeEventListener('pointerdown', handler, true)
      document.removeEventListener('focusin', handler, true)
    }
  }, [definition, onAdvance])

  return (
    <div style={s.host} aria-live="polite">
      {rect && <div style={{ ...s.highlight, left: rect.left - 5, top: rect.top - 5, width: rect.width + 10, height: rect.height + 10 }} />}
      <div style={s.card} role="status">
        <div style={s.progress}>{t('tour.progress', { current: step + 1, total: STEPS.length })}</div>
        <div style={s.title}>{t(definition.title)}</div>
        <div style={s.body}>{t(definition.body)}</div>
        <div style={s.actions}>
          <button style={s.exit} onClick={onExit}>{t('tour.exit')}</button>
          {step === 2 && <span style={s.waiting}>{t('tour.viewerWaiting')}</span>}
          {(step === 3 || step === 5) && <button style={s.next} onClick={onAdvance}>{t('tour.skipStep')}</button>}
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  host: { position: 'fixed', inset: 0, zIndex: 6500, pointerEvents: 'none' },
  highlight: { position: 'fixed', border: '2px solid var(--accent)', borderRadius: 6, boxShadow: '0 0 0 4px rgba(var(--accent-rgb), 0.18), 0 0 24px rgba(var(--accent-rgb), 0.42)', pointerEvents: 'none', transition: 'left .12s ease, top .12s ease, width .12s ease, height .12s ease' },
  card: { position: 'fixed', left: '50%', bottom: 22, transform: 'translateX(-50%)', width: 390, maxWidth: 'calc(100vw - 40px)', padding: '14px 16px', boxSizing: 'border-box', background: 'rgba(18,21,30,0.98)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, boxShadow: '0 16px 42px rgba(0,0,0,.55)', color: '#eef2ff', pointerEvents: 'auto' },
  progress: { color: '#8e9ab2', fontSize: font.xs, fontWeight: 800 },
  title: { marginTop: 4, color: '#f7f9ff', fontSize: font.base, fontWeight: 900 },
  body: { marginTop: 5, color: '#b7c0d2', fontSize: font.sm, lineHeight: 1.55 },
  actions: { minHeight: 25, marginTop: 10, display: 'flex', alignItems: 'center', gap: 12 },
  exit: { padding: 0, background: 'transparent', border: 'none', color: '#8e9ab2', cursor: 'pointer', fontSize: font.xs, textDecoration: 'underline' },
  waiting: { marginLeft: 'auto', color: '#8e9ab2', fontSize: font.xs, fontWeight: 700 },
  next: { marginLeft: 'auto', height: 28, padding: '0 10px', background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.14)', borderRadius: 3, color: '#eef2ff', cursor: 'pointer', fontSize: font.xs, fontWeight: 800 },
}
