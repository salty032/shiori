// full 版のみが読み込む動画機能のレンダラー側エントリ。renderer/src/main.full.tsx が
// App を描画する前に import することで、features/registry へ以下を登録する。
// capture ソースドロップでは renderer/src/video/ ごと削除すればこのファイルも消える。
import { registerMediaAction, registerContextMenuItems, registerModal, registerSettingsSlot, registerClipFramesResolver } from '../features/registry'
import { videoApi } from './api'
import { useTrimStore } from './trimStore'
import VideoTrimmerModal from './VideoTrimmerModal'
import ClipHotkeySettings from './ClipHotkeySettings'
import { t } from '../i18n'

const panelBtnStyle: React.CSSProperties = {
  width: '100%', height: 34, padding: '0 12px', background: 'rgba(35,190,183,0.1)',
  border: '1px solid rgba(35,190,183,0.38)', borderRadius: 3, color: '#5ee2dc',
  cursor: 'pointer', fontSize: 12, fontWeight: 800,
}

registerMediaAction((img, ctx) => {
  if (img.media_type !== 'video') return null
  // ctx.close の有無で呼び出し元（Viewer / DetailPanel）を判別する。
  // ビューア上部にはトリミングボタンを出さない。DetailPanel はビューアに覆われず常時
  // 隣に出ているため（Viewer の設計コメント参照）、ビューアを開いていても同じ操作が
  // そこから届く。同じ導線を 2 つ並べる価値がなく、上部バーは閉じる・カウンタだけの
  // 静かな状態に保つ。右クリックメニュー（下の registerContextMenuItems）も残るので、
  // ビューアからトリミングに入る手段自体は失われない。
  if (ctx?.close != null) return null
  const open = (): void => {
    useTrimStore.getState().open(img.id)
  }
  return (
    <button key="trim" style={panelBtnStyle} onClick={open}>
      {t('video.trim')}
    </button>
  )
})

registerContextMenuItems((img) => {
  if (img.media_type !== 'video') return []
  return [{ label: t('video.trim'), onClick: () => useTrimStore.getState().open(img.id) }]
})

registerModal(() => <VideoTrimmerModal />)

// ビューアのコマ送りを素材の実コマへ吸着させるためのコマ情報取得口。main 側で imageId 単位に
// キャッシュされるので、トリマーと同じクリップなら解析は 1 回で済む。
registerClipFramesResolver((imageId) => videoApi.getClipFrames(imageId))

registerSettingsSlot('capture', (props) => <ClipHotkeySettings {...props} />)
