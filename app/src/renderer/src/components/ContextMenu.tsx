import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { font, color, radius } from '../styles'

export type MenuItem = { label: string; onClick: () => void; danger?: boolean }

type Props = {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

// グリッド／タイムラインのサムネイル右クリックで開く共通コンテキストメニュー。
// DetailPanel の簡易メニューと同じダーク配色に合わせている。
//
// 閉じる判定はブロッキングオーバーレイではなく document リスナーで行う。
// オーバーレイで全面を覆うと、メニューを開いたまま別サムネイルを右クリックしても
// クリックがオーバーレイに吸われて本体に届かず「2回右クリックが必要」になるため。
export default function ContextMenu({ x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  // 幅は項目数によらず内容に合わせる（max-content）ため、事前に確定サイズが分からない。
  // 一旦見えない状態で描画してから実測し、画面端クランプ後の位置が決まってから表示する
  // （最初から x, y にそのまま出すと、はみ出す場合に一瞬ズレて見える／逆に測る前提で
  // 固定幅を仮定すると短いラベルでメニューが不自然に広くなる）。
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  // U-7: ↑↓/Enter でのキーボード操作。-1 = 未選択（マウスホバーのみ）。
  const [highlighted, setHighlighted] = useState(-1)

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
    setPos({ left, top })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, items])

  useEffect(() => {
    // メニュー外への mousedown（左右どちらのボタンでも）で閉じる。
    // 別サムネイルの右クリック時はここで旧メニューを閉じ、続く contextmenu が
    // 新しい位置でメニューを開き直す（＝1アクションで移動できる）。
    const onPointerDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlighted((i) => (i + 1) % items.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlighted((i) => (i - 1 + items.length) % items.length)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const item = items[highlighted]
        if (item) { item.onClick(); onClose() }
      }
    }
    const onScroll = (): void => onClose()
    window.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose, items, highlighted])

  return (
    <div ref={menuRef} style={{ ...s.menu, left: pos?.left ?? x, top: pos?.top ?? y, visibility: pos ? 'visible' : 'hidden' }} data-keep-selection>
      {items.map((it, i) => (
        <div key={it.label}>
          {i > 0 && it.danger && !items[i - 1].danger && <div style={s.separator} />}
          <button
            className={`shiori-menu-item${it.danger ? ' shiori-menu-item-danger' : ''}`}
            style={{ ...s.item, ...(it.danger ? s.danger : {}), ...(i === highlighted ? s.itemHighlighted : {}) }}
            onClick={() => { it.onClick(); onClose() }}
            onMouseEnter={() => setHighlighted(i)}
          >
            {it.label}
          </button>
        </div>
      ))}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  menu: { position: 'fixed' as const, width: 'max-content' as const, minWidth: 84, maxWidth: 280, background: '#171a23', border: '1px solid #2b3243', borderRadius: radius.sm, padding: '4px', boxShadow: '0 18px 40px rgba(0,0,0,0.42)', zIndex: 4000 },
  item: { display: 'block', width: '100%', boxSizing: 'border-box' as const, padding: '6px 10px', background: 'none', border: 'none', borderRadius: 2, color: '#dce3f2', fontSize: font.base, fontWeight: 700, cursor: 'pointer', textAlign: 'left' as const, whiteSpace: 'nowrap' as const, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const },
  danger: { color: color.danger },
  itemHighlighted: { background: 'rgba(255,255,255,0.08)' },
  separator: { height: 1, margin: '5px 4px', background: 'rgba(255,255,255,0.08)' },
}
