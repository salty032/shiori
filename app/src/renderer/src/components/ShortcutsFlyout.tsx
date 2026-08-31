import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { shortcutGroups } from '../shortcuts'
import { useT } from '../i18n'
import { font, radius, space, weight } from '../styles'

const CLOSE_MS = 100
// 説明とキーを横に並べる分、縦積みだった頃（260）より広い幅が要る。
const FLYOUT_WIDTH = 340

// 「Shift+矢印 / Shift+クリック」のような択一表記を 1 個ずつのキーに割る。
// 区切りは前後に空白のある ' / ' だけを見ること: 単体の '/'（検索フォーカス）が
// それ自身セパレータとして割れて空のキーが 2 個できてしまう。
function splitKeys(keys: string): string[] {
  return keys.split(' / ')
}

type Props = {
  anchorEl: HTMLElement | null
  onClose: () => void
}

// サイドバー下部の「設定」ボタンの隣にあるショートカットボタンから開く。設定モーダルとは
// 無関係の独立したフライアウトで、サイドバーの右端からはみ出す形で表示する
// （閉じる判定は ContextMenu.tsx と同じ document リスナー方式）。
export default function ShortcutsFlyout({ anchorEl, onClose }: Props) {
  const { t } = useT()
  const groups = shortcutGroups(t)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  const [closing, setClosing] = useState(false)

  useLayoutEffect(() => {
    if (!anchorEl) return
    const rect = anchorEl.getBoundingClientRect()
    // 横並び化で幅が広がった分、サイドバーを広げているとアンカーの右に置くだけでは
    // 画面右端からはみ出す。右端で止め、それでも入らなければ左端に寄せる。
    const left = Math.max(12, Math.min(rect.right + 10, window.innerWidth - FLYOUT_WIDTH - 12))
    setPos({ left, bottom: Math.max(12, window.innerHeight - rect.bottom) })
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
      <div style={s.heading}>{t('shortcuts.heading')}</div>
      {groups.map((group) => (
        <div key={group.title} style={s.group}>
          <div style={s.groupTitle}>{group.title}</div>
          <div style={s.list}>
            {group.items.map((item) => (
              <div key={item.keys} style={s.row}>
                <span style={s.desc}>{item.desc}</span>
                <span style={s.keys}>
                  {splitKeys(item.keys).map((k) => <kbd key={k} style={s.key}>{k}</kbd>)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div style={s.hint}>{t('shortcuts.hint')}</div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  flyout: { position: 'fixed' as const, width: FLYOUT_WIDTH, maxHeight: '70vh', overflowY: 'auto' as const, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, padding: '14px 16px', boxShadow: '0 18px 40px rgba(var(--scrim-rgb), var(--shadow-popover))', zIndex: 4000, display: 'flex', flexDirection: 'column' as const, gap: space.x12, boxSizing: 'border-box' as const, transformOrigin: 'bottom left' as const },
  heading: { fontSize: font.sm, fontWeight: weight.medium, color: 'var(--accent-text)' },
  group: { display: 'flex', flexDirection: 'column' as const, gap: space.x4 },
  groupTitle: { fontSize: font.xs, color: 'var(--text-secondary)', fontWeight: weight.medium },
  list: { display: 'flex', flexDirection: 'column' as const, gap: space.x4, width: '100%' },
  // 説明を左・キーを右に並べる。縦積みだと説明とキーが 1 本の流れになり、どの説明が
  // どのキーの分か目で追えなかった。キーを右端で揃えることで、行の対応が横一直線で読める。
  row: { display: 'flex', flexDirection: 'row' as const, alignItems: 'baseline', justifyContent: 'space-between', gap: space.x12 },
  // 説明側だけを縮ませる（キーは省略されると意味を失うため flexShrink: 0）。
  desc: { flex: '1 1 auto', minWidth: 0, fontSize: font.xs, color: 'var(--text-primary)', lineHeight: 1.5 },
  keys: { flexShrink: 0, display: 'flex', flexWrap: 'wrap' as const, justifyContent: 'flex-end', gap: space.x4, maxWidth: '58%' },
  key: { fontFamily: 'monospace', fontSize: font.xs, color: 'var(--accent-text)', background: 'var(--bg-content)', border: '1px solid var(--border-default)', borderRadius: radius.md, padding: '1px 7px', whiteSpace: 'nowrap' as const },
  hint: { fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 },
}
