// full 版のみが読み込む動画機能のレンダラー側エントリ。renderer/src/main.full.tsx が
// App を描画する前に import することで、features/registry へ以下を登録する。
// capture ソースドロップでは renderer/src/video/ ごと削除すればこのファイルも消える。
import { registerMediaAction, registerContextMenuItems, registerModal, registerSettingsSlot } from '../features/registry'
import { useTrimStore } from './trimStore'
import VideoTrimmerModal from './VideoTrimmerModal'
import ClipHotkeySettings from './ClipHotkeySettings'

const panelBtnStyle: React.CSSProperties = {
  width: '100%', height: 34, padding: '0 12px', background: 'rgba(35,190,183,0.1)',
  border: '1px solid rgba(35,190,183,0.38)', borderRadius: 3, color: '#5ee2dc',
  cursor: 'pointer', fontSize: 12, fontWeight: 800,
}

const viewerBtnStyle: React.CSSProperties = {
  padding: '3px 10px', background: 'rgba(123,123,246,0.15)', border: '1px solid rgba(123,123,246,0.4)',
  borderRadius: 4, color: '#9ea5ff', fontSize: 12, cursor: 'pointer', fontWeight: 700, flexShrink: 0,
}

registerMediaAction((img, ctx) => {
  if (img.media_type !== 'video') return null
  const open = (): void => {
    ctx?.close?.()
    useTrimStore.getState().open(img.id)
  }
  // ctx.close の有無で呼び出し元（Viewer=コンパクト表示 / DetailPanel=全幅表示）を判別する。
  const isViewer = ctx?.close != null
  return (
    <button key="trim" style={isViewer ? viewerBtnStyle : panelBtnStyle} onClick={open}>
      トリミング
    </button>
  )
})

registerContextMenuItems((img) => {
  if (img.media_type !== 'video') return []
  return [{ label: 'トリミング', onClick: () => useTrimStore.getState().open(img.id) }]
})

registerModal(() => <VideoTrimmerModal />)

registerSettingsSlot('キャプチャ', (props) => <ClipHotkeySettings {...props} />)
