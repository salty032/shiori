import { useEffect, useLayoutEffect, useState } from 'react'
import { control, font, radius, space, weight } from '../styles'
import { useT, type MessageKey } from '../i18n'

// 案内の段。**段は番号ではなく id で指す**（進む条件は useProductTour.ts、表示はここ）。以前は 0〜5 の
// 番号を両方のファイルに直書きしていて、段を足す・並べ替えると片方だけずれ、別の段の説明が出たり
// 操作しても進まなくなったりした。並びはこの配列の順だけが決める。
//   event: 'interact' … 対象の欄を触ったら次へ（それ以外の段は useProductTour が実状態を見て進める）
//   waiting           … 進む操作を待っている間に添える一言
//   skippable         … 「この段を飛ばす」を出す
const TOUR_STEPS = [
  { id: 'select', selector: '[data-img-id]', title: 'tour.selectTitle', body: 'tour.selectBody' },
  { id: 'open', selector: '[data-selected="true"]', title: 'tour.openTitle', body: 'tour.openBody' },
  { id: 'viewer', selector: '[data-tour="viewer-close"]', title: 'tour.viewerTitle', body: 'tour.viewerBody', waiting: 'tour.viewerWaiting' },
  { id: 'memo', selector: '[data-tour="memo-input"]', title: 'tour.memoTitle', body: 'tour.memoBody', event: 'interact', skippable: true },
  { id: 'timeline', selector: '[data-tour="timeline-toggle"]', title: 'tour.timelineTitle', body: 'tour.timelineBody' },
  { id: 'search', selector: '[data-tour="search-input"]', title: 'tour.searchTitle', body: 'tour.searchBody', event: 'interact', skippable: true },
] as const satisfies readonly {
  id: string; selector: string; title: MessageKey; body: MessageKey
  event?: 'interact'; waiting?: MessageKey; skippable?: true
}[]

export type ProductTourStep = (typeof TOUR_STEPS)[number]['id']

export const FIRST_TOUR_STEP: ProductTourStep = TOUR_STEPS[0].id

// 次の段。最後の段なら null。
export function nextTourStep(step: ProductTourStep): ProductTourStep | null {
  const i = TOUR_STEPS.findIndex((d) => d.id === step)
  return TOUR_STEPS[i + 1]?.id ?? null
}

type StepDefinition = (typeof TOUR_STEPS)[number] & { event?: 'interact'; waiting?: MessageKey; skippable?: true }

type Props = {
  step: ProductTourStep
  onAdvance: () => void
  onExit: () => void
}

export default function ProductTour({ step, onAdvance, onExit }: Props) {
  const { t } = useT()
  const [rect, setRect] = useState<DOMRect | null>(null)
  const index = TOUR_STEPS.findIndex((d) => d.id === step)
  const definition: StepDefinition = TOUR_STEPS[index]

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
    <div style={s.host}>
      {rect && <div style={{ ...s.highlight, left: rect.left - 5, top: rect.top - 5, width: rect.width + 10, height: rect.height + 10 }} />}
      <div style={s.card}>
        <div style={s.progress}>{t('tour.progress', { current: index + 1, total: TOUR_STEPS.length })}</div>
        <div style={s.title}>{t(definition.title)}</div>
        <div style={s.body}>{t(definition.body)}</div>
        <div style={s.actions}>
          <button style={s.exit} onClick={onExit}>{t('tour.exit')}</button>
          {definition.waiting && <span style={s.waiting}>{t(definition.waiting)}</span>}
          {definition.skippable && <button style={s.next} onClick={onAdvance}>{t('tour.skipStep')}</button>}
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  host: { position: 'fixed', inset: 0, zIndex: 6500, pointerEvents: 'none' },
  highlight: { position: 'fixed', border: '2px solid var(--accent)', borderRadius: radius.md + 5, boxShadow: '0 0 0 4px rgba(var(--accent-rgb), 0.18), 0 0 24px rgba(var(--accent-rgb), 0.42)', pointerEvents: 'none', transition: 'left .12s ease, top .12s ease, width .12s ease, height .12s ease' },
  card: { position: 'fixed', left: '50%', bottom: 22, transform: 'translateX(-50%)', width: 390, maxWidth: 'calc(100vw - 40px)', padding: '14px 16px', boxSizing: 'border-box', background: 'var(--bg-modal)', border: '1px solid var(--border-default)', borderRadius: radius.md, boxShadow: '0 16px 42px rgba(var(--scrim-rgb), 0.55)', color: 'var(--text-primary)', pointerEvents: 'auto' },
  progress: { color: 'var(--text-muted)', fontSize: font.xs, fontWeight: weight.normal },
  title: { marginTop: 4, color: 'var(--text-primary)', fontSize: font.base, fontWeight: weight.medium },
  body: { marginTop: 5, color: 'var(--text-secondary)', fontSize: font.sm, lineHeight: 1.55 },
  actions: { minHeight: control.sm, marginTop: 10, display: 'flex', alignItems: 'center', gap: space.x12 },
  exit: { padding: 0, background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: font.xs, textDecoration: 'underline' },
  waiting: { marginLeft: 'auto', color: 'var(--text-muted)', fontSize: font.xs, fontWeight: weight.normal },
  next: { marginLeft: 'auto', height: control.md, padding: '0 10px', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, color: 'var(--text-primary)', cursor: 'pointer', fontSize: font.xs, fontWeight: weight.medium },
}
