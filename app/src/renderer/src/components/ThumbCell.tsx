import { useState, useEffect, useRef, memo } from 'react'
import type { ImageRow } from '../types'
import { cleanTitle, thumbSrc, formatDuration, splitHighlight } from '../utils'
import { s } from '../styles'

function thumbDurationLabel(img: ImageRow): string | null {
  if (img.media_type !== 'video') return null
  return Number.isFinite(img.duration ?? NaN) ? formatDuration(img.duration!) : null
}

type Props = {
  img: ImageRow
  cellHeight: number
  selected: boolean
  isNew?: boolean
  focused?: boolean
  titleStrip: string[]
  highlight?: string
  onContextMenu: (e: React.MouseEvent, id: number) => void
  onOpen: (index: number) => void
  index: number
}

const NEW_EXIT_MS = 920

export default memo(function ThumbCell({ img, cellHeight, selected, isNew, focused, titleStrip, highlight, onContextMenu, onOpen, index }: Props) {
  const [hovered, setHovered] = useState(false)
  const [thumbFailed, setThumbFailed] = useState(false)
  const [thumbLoaded, setThumbLoaded] = useState(false)
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
  const durationLabel = thumbDurationLabel(img)
  const titleLabel = img.title ? cleanTitle(img.title, titleStrip) : ''
  const showNew = isNew || newExiting
  return (
    <div data-img-id={img.id}
      style={{ ...s.thumb, ...(hovered ? s.thumbHovered : {}), ...(selected ? s.thumbSelected : {}), ...(isNew ? s.thumbNew : newExiting ? s.thumbNewExit : {}) }}
      onContextMenu={(e) => onContextMenu(e, img.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDoubleClick={() => onOpen(index)}>
      <div style={{ ...s.thumbImgWrap, height: cellHeight }}>
        {/* サムネ生成失敗（動画で thumb_path 無し・ファイル欠落等）時は webm 本体が
            <img> に渡り割れ画像になるため、フォールバックのプレースホルダに切り替える */}
        {thumbFailed
          ? <div style={s.thumbFallback} />
          : <img src={thumbSrc(img)} style={{ ...s.thumbImg, opacity: thumbLoaded ? 1 : 0 }} alt="" draggable={false}
              decoding="async" loading="lazy" onLoad={() => setThumbLoaded(true)} onError={() => setThumbFailed(true)} />}
        {img.media_type === 'video' && <div style={s.thumbVideoPlay}>▶</div>}
        {durationLabel && <div style={s.thumbVideoDuration}>{durationLabel}</div>}
        {showNew && <div style={isNew ? s.thumbNewBadge : s.thumbNewBadgeExit}>NEW</div>}
      </div>
      <div style={s.thumbLabel} title={titleLabel || undefined}>
        {highlight
          ? splitHighlight(titleLabel, highlight).map((seg, i) => seg.match
            ? <mark key={i} style={s.thumbLabelHighlight}>{seg.text}</mark>
            : <span key={i}>{seg.text}</span>)
          : titleLabel}
      </div>
      {focused && !selected && <div style={s.thumbFocusFrame} />}
    </div>
  )
})
