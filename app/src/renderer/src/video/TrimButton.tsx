// 詳細パネルに出すトリミングボタン。
// ビューア上部には出さない。詳細パネルはビューアに覆われず常に隣に出ているため
// （Viewer の設計コメント参照）、ビューアを開いていても同じ操作がそこから届く。
// 同じ導線を 2 つ並べる価値がなく、上部バーは閉じる・カウンタだけの静かな状態に保つ。
// 右クリックメニューにも項目があるので、ビューアからトリミングに入る手段は失われない。
import { useTrimStore } from './trimStore'
import { useT } from '../i18n'
import { control, radius, weight } from '../styles'

const panelBtnStyle: React.CSSProperties = {
  width: '100%', height: control.lg, padding: '0 12px', background: 'var(--video-edit-bg)',
  border: '1px solid var(--video-edit-border)', borderRadius: radius.md, color: 'var(--video-edit-text)',
  cursor: 'pointer', fontSize: 12, fontWeight: weight.medium,
}

export default function TrimButton({ imageId }: { imageId: number }) {
  const { t } = useT()
  return (
    <button style={panelBtnStyle} onClick={() => useTrimStore.getState().open(imageId)}>
      {t('video.trim')}
    </button>
  )
}
