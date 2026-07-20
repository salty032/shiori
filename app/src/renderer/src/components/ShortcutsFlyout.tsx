import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SHORTCUT_GROUPS } from '../shortcuts'
import { font } from '../styles'

const CLOSE_MS = 100

type Props = {
  anchorEl: HTMLElement | null
  onClose: () => void
}

// サイドバー下部の「設定」ボタンの隣にあるショートカットボタンから開く。設定モーダルとは
// 無関係の独立したフライアウトで、サイドバーの右端からはみ出す形で表示する
// （閉じる判定は ContextMenu.tsx と同じ document リスナー方式）。
export default function ShortcutsFlyout({ anchorEl, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  const [closing, setClosing] = useState(false)

  useLayoutEffect(() => {
    if (!anchorEl) return
    const rect = anchorEl.getBoundingClientRect()
    setPos({ left: rect.right + 10, bottom: Math.max(12, window.innerHeight - rect.bottom) })
  }, [anchorEl])

  function close(): void {
    if (closing) return
    setClosing(true)
    window.setTimeout(onClose, CLOSE_MS)
  }

  useEffect(() => {
    const onPointerDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (anchorEl?.contains(target)) return
      close()
    }
    // 表示中は背後のグリッドへキーを流さない（Escape で裏の選択まで解除されるのを防ぐ）。
    const onKey = (e: KeyboardEvent): void => {
      e.stopPropagation()
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, anchorEl, closing])

  return (
    <div ref={panelRef} style={{ ...s.flyout, left: pos?.left ?? 0, bottom: pos?.bottom ?? 0, visibility: pos ? 'visible' : 'hidden', animation: closing ? 'shioriPopoverOut 0.1s ease-out forwards' : 'shioriPopoverIn 0.1s ease-out' }}>
      <div style={s.heading}>ショートカット</div>
      {SHORTCUT_GROUPS.map((group) => (
        <div key={group.title} style={s.group}>
          <div style={s.groupTitle}>{group.title}</div>
          <div style={s.list}>
            {group.items.map((item) => (
              <div key={item.keys} style={s.row}>
                <span style={s.desc}>{item.desc}</span>
                <span style={s.key}>{item.keys}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div style={s.hint}>キャプチャホットキーは設定 →「キャプチャ」で変更できます。</div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  flyout: { position: 'fixed' as const, width: 260, maxHeight: '70vh', overflowY: 'auto' as const, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 6, padding: '14px 16px', boxShadow: '0 18px 40px rgba(var(--scrim-rgb), 0.5)', zIndex: 4000, display: 'flex', flexDirection: 'column' as const, gap: 14, boxSizing: 'border-box' as const, transformOrigin: 'bottom left' as const },
  heading: { fontSize: font.sm, fontWeight: 800, color: 'var(--accent-text)' },
  group: { display: 'flex', flexDirection: 'column' as const, gap: 6 },
  groupTitle: { fontSize: font.xs, color: 'var(--text-secondary)', letterSpacing: 0.4, fontWeight: 800 },
  list: { display: 'flex', flexDirection: 'column' as const, gap: 7, width: '100%' },
  row: { display: 'flex', flexDirection: 'column' as const, gap: 2 },
  desc: { fontSize: font.xs, color: 'var(--text-secondary)', lineHeight: 1.4 },
  key: { fontFamily: 'monospace', fontSize: font.xs, color: 'var(--accent-text)', background: 'var(--bg-content)', border: '1px solid var(--border-default)', borderRadius: 3, padding: '1px 7px', display: 'inline-block', width: 'fit-content', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const },
  hint: { fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 },
}
