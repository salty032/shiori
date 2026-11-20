import { useState, useEffect, useRef, memo } from 'react'
import type { ImageRow } from '../types'
import { splitHighlight, formatTime } from '../utils'
import { ThumbImage } from './ThumbImage'
import { s, badgeInset } from '../styles'

function thumbDurationLabel(img: ImageRow): string | null {
  if (img.media_type !== 'video' || img.duration == null || !Number.isFinite(img.duration)) return null
  return formatTime(img.duration)
}

type Props = {
  img: ImageRow
  cellHeight: number
  selected: boolean
  isNew?: boolean
  focused?: boolean
  highlight?: string
  onContextMenu: (e: React.MouseEvent, id: number) => void
  onOpen: (index: number) => void
  index: number
}

const NEW_EXIT_MS = 920

export default memo(function ThumbCell({ img, cellHeight, selected, isNew, focused, highlight, onContextMenu, onOpen, index }: Props) {
  const [hovered, setHovered] = useState(false)
  const [newExiting, setNewExiting] = useState(false)
  const wasNewRef = useRef(isNew)
  useEffect(() => {
    if (wasNewRef.current && !isNew) {
      setNewExiting(true)
      const t = setTimeout(() => setNewExiting(false), NEW_EXIT_MS)
      wasNewRef.current = isNew
      return () => clearTimeout(t)
    }
    wasNewRef.current = isNew
  }, [isNew])
  // セルは常に 16:9（computeGridLayout が cellHeight = cellWidth × 9/16 を返す）なので、
  // 受け取っている高さから幅を復元して余白を決める。
  const inset = badgeInset(cellHeight * 16 / 9)
  const durationLabel = thumbDurationLabel(img)
  const titleLabel = img.title ?? ''
  const showNew = isNew || newExiting
  return (
    // 選択・矢印移動・ビューア起動の実体はすべて useSelection の window レベルの
    // キーハンドラ側にあるため、ここに tabIndex は付けない
    // （付けると Tab がサムネイル全件を巡回して検索欄へ戻れなくなる）。
    // data-selected は ProductTour が「選択中のサムネイル」を指すための目印。
    <div data-img-id={img.id}
      data-selected={selected ? 'true' : undefined}
      style={{ ...s.thumb, ...(hovered ? s.thumbHovered : {}), ...(focused && !selected ? s.thumbFocused : {}), ...(selected ? s.thumbSelected : {}), ...(isNew ? s.thumbNew : newExiting ? s.thumbNewExit : {}) }}
      onContextMenu={(e) => onContextMenu(e, img.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // Ctrl+クリックは選択のトグルなので、外して付け直すと 2 回目が
      // ダブルクリック扱いになりビューアが開いていた。Shift も同じ（範囲を
      // 引き直しただけで開く）。修飾キーを押している間は開かない。
      onDoubleClick={(e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) return; onOpen(index) }}>
      <ThumbImage img={img} wrapStyle={{ ...s.thumbImgWrap, height: cellHeight }} imgStyle={s.thumbImg}>
        {img.media_type === 'video' && <div style={s.thumbVideoPlay}>▶</div>}
        {durationLabel && <div style={{ ...s.thumbVideoDuration, top: inset.y, right: inset.x }}>{durationLabel}</div>}
        {showNew && <div style={{ ...(isNew ? s.thumbNewBadge : s.thumbNewBadgeExit), top: inset.y, left: inset.x }}>NEW</div>}
      </ThumbImage>
      <div style={{ ...s.thumbLabel, ...(selected ? s.thumbLabelSelected : {}) }} title={titleLabel || undefined}>
        {highlight
          ? splitHighlight(titleLabel, highlight).map((seg, i) => seg.match
            ? <mark key={i} style={s.thumbLabelHighlight}>{seg.text}</mark>
            : <span key={i}>{seg.text}</span>)
          : titleLabel}
      </div>
    </div>
  )
})
