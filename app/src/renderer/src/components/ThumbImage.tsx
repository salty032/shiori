import { memo, useState } from 'react'
import type { ImageRow } from '../types'
import { thumbSrc } from '../utils'
import { s } from '../styles'
import { useT } from '../i18n'

// 一覧のサムネイルの画像。グリッド（ThumbCell）とタイムライン（TimelineView）で共通。
// 以前は両方に同じ処理が別々にあり、グリッドだけ読み込み後に 0.15 秒かけて出していた（理由は残っていない）。
//
// サムネ生成失敗（ファイル欠落等）時は割れ画像になるため、代わりの表示に切り替える。
// 縦長の画像は切り抜かず、黒地の中に収める。
// children は画像の上に重ねる印（再生マーク・尺・NEW など。置く物は一覧ごとに違う）。
export const ThumbImage = memo(function ThumbImage({ img, wrapStyle, imgStyle, children }: {
  img: ImageRow
  wrapStyle: React.CSSProperties
  imgStyle: React.CSSProperties
  children?: React.ReactNode
}) {
  const { t } = useT()
  const [failed, setFailed] = useState(false)
  const [vertical, setVertical] = useState(false)
  return (
    <div style={{ ...wrapStyle, ...(vertical ? s.thumbImgWrapVertical : {}) }}>
      {failed
        ? <div style={s.thumbFallback}><span style={s.thumbFallbackText}>{t('thumb.loadFailed')}</span></div>
        : <img src={thumbSrc(img)} style={{ ...imgStyle, ...(vertical ? s.thumbImgVertical : {}) }} alt="" draggable={false}
            decoding="async" loading="lazy"
            onLoad={(e) => setVertical(e.currentTarget.naturalWidth < e.currentTarget.naturalHeight)}
            onError={() => setFailed(true)} />}
      {children}
    </div>
  )
})
