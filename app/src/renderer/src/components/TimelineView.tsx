import { memo, forwardRef, useImperativeHandle, useMemo, useState, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ImageRow } from '../types'
import type { TimelineGroup } from '../utils'
import { cleanTitle, computeGridLayout, formatTime, thumbSrc } from '../utils'
import { font, s as appStyles } from '../styles'

// サムネ生成失敗（ファイル欠落等）時は割れ画像になるため、
// ThumbCell / フィルムストリップと同様に onError でプレースホルダへ切り替える。
const TimelineThumbImg = memo(function TimelineThumbImg({ img, cellHeight }: { img: ImageRow; cellHeight: number }) {
  const [failed, setFailed] = useState(false)
  const [vertical, setVertical] = useState(false)
  if (failed) return <div style={{ ...appStyles.thumbFallback, height: cellHeight }} />
  return (
    <div style={{ width: '100%', height: cellHeight, ...(vertical ? appStyles.thumbImgWrapVertical : {}) }}>
      <img src={thumbSrc(img)} style={{ ...s.thumbImg, height: cellHeight, ...(vertical ? appStyles.thumbImgVertical : {}) }} alt="" draggable={false}
        decoding="async" loading="lazy"
        onLoad={(e) => setVertical(e.currentTarget.naturalWidth < e.currentTarget.naturalHeight)}
        onError={() => setFailed(true)} />
    </div>
  )
})

// レイアウト定数。全グループを「見出し行 + 画像行」の1本のフラットな配列に潰し、
// その行単位で仮想化する（S4-3）。グループ単位で仮想化すると、画面にかかった
// グループの画像が全部 DOM に載るため、1作品に数千枚あるライブラリでは
// そのグループだけで数千の img が生成されてしまう。
//
// 各行は transform: translateY で位置決めする（top だと毎フレーム
// レイアウト計算が走り、スクロールに対して見出しが遅延してカクつく）。
// ただし position:sticky は transform を使う祖先の中では正しく機能しない
// （transform は描画段階のオフセットでしかなく sticky の固定位置計算を
// 巻き込んでズレるため）。そのため見出しは行の中には sticky を
// 置かず、画面最上部に1つだけ独立した「現在のグループ名」オーバーレイを
// 重ねて表示する。行間・グループ間の隙間は各行の高さ（仮想化の座標計算）にだけ
// 加算し、実DOMの高さには含めない（次の行の開始位置との間に空白を作るだけで済むため）。
const HEADER_HEIGHT = 34
// App.tsx 側のキーボードナビゲーション列数計算（navigationColumnsRef）もこの値を共有する。
// ここだけ変えてあちらを変え忘れると、見た目の列数とナビゲーションの列数が静かにズレるため。
export const CELL_GAP = 10
const GROUP_GAP = 26

type Props = {
  groups: TimelineGroup[]
  thumbnailSize: number
  titleStrip: string[]
  selectedIds: Set<number>
  pendingIds: Set<number>
  focusedIndex: number | null
  loading: boolean
  hasActiveFilter: boolean
  onOpen: (flatIndex: number) => void
  onContextMenu: (flatIndex: number, e: React.MouseEvent) => void
  containerWidth: number
  scrollRef: React.RefObject<HTMLDivElement | null>
  offsetTop: number
}

export interface TimelineViewHandle {
  scrollToFlatIndex: (flatIndex: number) => void
}

// 仮想化の単位。見出し1行 or 画像1行（1行 = columns 枚）。
type Row =
  | { kind: 'header'; groupIndex: number; size: number }
  | { kind: 'cells'; groupIndex: number; from: number; to: number; size: number }

const TimelineView = forwardRef<TimelineViewHandle, Props>(function TimelineView(p, ref) {
  const { columns, cellWidth, cellHeight } = computeGridLayout(p.containerWidth, p.thumbnailSize, CELL_GAP)

  // 全グループを行の配列へ潰し、各行の高さ（行間の隙間込み）を前計算する。
  // 高さは実DOMの配置と厳密に一致させる必要がある（ズレると translateY 計算が
  // 以降の行で累積してズレていく）。1グループ分の合計は
  // HEADER_HEIGHT + CELL_GAP + rows * cellHeight + (rows - 1) * CELL_GAP + GROUP_GAP。
  const { rows, groupRowStart, groupStartFlat } = useMemo(() => {
    const rows: Row[] = []
    const groupRowStart: number[] = []
    const groupStartFlat: number[] = []
    let flatOffset = 0
    p.groups.forEach((group, groupIndex) => {
      groupRowStart.push(rows.length)
      groupStartFlat.push(flatOffset)
      flatOffset += group.items.length
      rows.push({ kind: 'header', groupIndex, size: HEADER_HEIGHT + CELL_GAP })
      const rowCount = Math.max(1, Math.ceil(group.items.length / columns))
      for (let r = 0; r < rowCount; r++) {
        const isLastRow = r === rowCount - 1
        rows.push({
          kind: 'cells',
          groupIndex,
          from: r * columns,
          to: Math.min((r + 1) * columns, group.items.length),
          // 行の下の隙間。グループ最終行だけは次のグループとの間隔（GROUP_GAP）になる。
          size: cellHeight + (isLastRow ? GROUP_GAP : CELL_GAP),
        })
      }
    })
    return { rows, groupRowStart, groupStartFlat }
  }, [p.groups, columns, cellHeight])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => p.scrollRef.current,
    estimateSize: (i) => rows[i]?.size ?? cellHeight,
    // グリッド側（App.tsx）と同じ考え方で、列数が少ないほど1行あたりの枚数が減るぶん
    // 多めに先読みする。
    overscan: Math.min(4, Math.max(1, Math.round(12 / columns))),
    scrollMargin: p.offsetTop,
  })

  // TanStack Virtual は estimateSize が変わっても測定キャッシュを自動では破棄しない
  // （グリッド側の App.tsx と同じ対処）。ウィンドウ幅・サムネサイズ変更で行数/行高
  // （rows[].size）が変わったときに再測定し、translateY のズレ（行の重なり・空白）を防ぐ。
  useEffect(() => { virtualizer.measure() }, [rows])

  useImperativeHandle(ref, () => ({
    scrollToFlatIndex(flatIndex: number): void {
      let groupIndex = p.groups.findIndex((g, i) =>
        flatIndex >= groupStartFlat[i] && flatIndex < groupStartFlat[i] + g.items.length)
      if (groupIndex < 0) groupIndex = 0
      const within = Math.max(0, flatIndex - (groupStartFlat[groupIndex] ?? 0))
      // groupRowStart は見出し行を指すので +1 が画像の先頭行。
      const rowIndex = groupRowStart[groupIndex] + 1 + Math.floor(within / columns)
      const itemTop = virtualizer.getOffsetForIndex(rowIndex, 'start')?.[0] ?? 0
      const itemBottom = itemTop + cellHeight
      const viewSize = p.scrollRef.current?.clientHeight ?? 0
      const current = virtualizer.scrollOffset ?? 0
      // グリッド側（virtualizer.scrollToIndex({align:'auto'})）と同じ「既に画面内なら
      // 動かさない・はみ出ている分だけ最小スクロール」という nearest 挙動に合わせる。
      if (itemTop >= current && itemBottom <= current + viewSize) return
      const target = itemBottom > current + viewSize ? itemBottom - viewSize : itemTop
      virtualizer.scrollToOffset(Math.max(0, target))
    },
  }), [groupRowStart, groupStartFlat, columns, cellHeight, virtualizer, p.groups])

  if (p.groups.length === 0) {
    if (p.loading) return <div style={s.empty}>読み込み中...</div>
    return (
      <div style={s.empty}>
        {p.hasActiveFilter ? '該当する画像がありません' : 'まだ画像がありません'}
      </div>
    )
  }

  const virtualItems = virtualizer.getVirtualItems()

  // 「現在画面上端にかかっているグループ」を求め、その見出しだけを固定表示する。
  // virtualItems は index 昇順なので、start <= scrollOffset を満たす最後の要素が
  // 画面上端のグループ（scrollOffset と vItem.start は同じ座標系=スクロール要素の
  // scrollTop 基準なので、scrollMargin 分の補正は不要）。
  const scrollOffset = virtualizer.scrollOffset ?? 0
  let activeIndex = rows[virtualItems[0]?.index ?? 0]?.groupIndex ?? 0
  for (const v of virtualItems) {
    if (v.start <= scrollOffset) activeIndex = rows[v.index].groupIndex
    else break
  }
  const activeGroup = p.groups[activeIndex]

  return (
    <>
      {/* 高さ0のスティッキー要素に被せて、現在のグループ名だけを画面最上部に表示する。
          位置決めは純粋な position:sticky（JS介入なし）なのでスクロールに遅延しない。
          高さを取らないので下の仮想リストの座標計算には影響しない。 */}
      <div style={{ position: 'sticky', top: 0, height: 0, overflow: 'visible', zIndex: 2 }}>
        {activeGroup && (
          <div style={s.heading}>
            <span style={s.headingTitle}>
              {activeGroup.title ? cleanTitle(activeGroup.title, p.titleStrip) : 'タイトルなし'}
            </span>
            <span style={s.headingCount}>{activeGroup.items.length}</span>
          </div>
        )}
      </div>
      <div style={{ position: 'relative', width: '100%', height: virtualizer.getTotalSize() }}>
      {virtualItems.map((vItem) => {
        const row = rows[vItem.index]
        const group = p.groups[row.groupIndex]
        const position: React.CSSProperties = {
          position: 'absolute', left: 0, width: '100%',
          transform: `translateY(${vItem.start - p.offsetTop}px)`,
        }
        if (row.kind === 'header') {
          return (
            <div key={`${group.key}:h`} style={{ ...position, ...s.headingStatic }}>
              <span style={s.headingTitle}>
                {group.title ? cleanTitle(group.title, p.titleStrip) : 'タイトルなし'}
              </span>
              <span style={s.headingCount}>{group.items.length}</span>
            </div>
          )
        }
        return (
          <div key={`${group.key}:${row.from}`}
            style={{ ...position, ...s.grid, height: cellHeight, gridTemplateColumns: `repeat(${columns}, ${cellWidth}px)` }}>
            {group.items.slice(row.from, row.to).map(({ img, flatIndex }) => {
              const isSelected = p.selectedIds.has(img.id) || p.pendingIds.has(img.id)
              return (
                <div
                  key={img.id}
                  data-img-id={img.id}
                  style={{ ...s.thumb, height: cellHeight, ...(isSelected ? appStyles.thumbSelected : {}) }}
                  onDoubleClick={() => p.onOpen(flatIndex)}
                  onContextMenu={(e) => p.onContextMenu(flatIndex, e)}
                >
                  <TimelineThumbImg img={img} cellHeight={cellHeight} />
                  {img.current_time != null && (
                    <div style={s.timeBadge}>{formatTime(img.current_time)}</div>
                  )}
                  {flatIndex === p.focusedIndex && !isSelected && <div style={appStyles.thumbFocusFrame} />}
                </div>
              )
            })}
          </div>
        )
      })}
      </div>
    </>
  )
})

export default memo(TimelineView)

const headingBase: React.CSSProperties = { height: HEADER_HEIGHT, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-content)' }

const s: Record<string, React.CSSProperties> = {
  // 画面最上部に固定表示する「現在のグループ名」。親が position:sticky なので
  // これ自体は通常配置でよい。
  heading: { ...headingBase, width: '100%' },
  // 各グループ行の中にそのまま流れる見出し（スクロールで普通に流れていく）。
  headingStatic: { ...headingBase },
  headingTitle: { fontSize: font.lg, fontWeight: 800, color: 'var(--text-bright)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  headingCount: { fontSize: font.sm, color: 'var(--text-secondary)', flexShrink: 0 },
  grid: { display: 'grid', gap: CELL_GAP, width: '100%' },
  thumb: { position: 'relative', background: 'var(--bg-surface)', border: '1px solid var(--border-default)', boxSizing: 'border-box', borderRadius: 4, overflow: 'hidden', cursor: 'pointer', width: '100%', contain: 'layout paint', boxShadow: '0 1px 0 rgba(var(--text-rgb), 0.035)' },
  thumbImg: { width: '100%', objectFit: 'cover', display: 'block' },
  // サムネ上への時刻バッジは、写真のような雑多な背景に載っても読めるよう常に黒地・白文字に固定する
  // （テーマ非依存。フィルムストリップの視認性を優先し、あえて周辺UIと色を揃えない）。
  timeBadge: { position: 'absolute', left: 6, bottom: 6, color: '#fff', fontSize: font.xs, fontWeight: 800, background: 'rgba(6,8,12,0.82)', padding: '2px 6px', borderRadius: 4, pointerEvents: 'none', fontVariantNumeric: 'tabular-nums' },
  empty: { color: 'var(--text-secondary)', textAlign: 'center', width: '100%', minHeight: '40vh', display: 'flex', alignItems: 'center', justifyContent: 'center' },
}
