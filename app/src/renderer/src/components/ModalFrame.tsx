import { modal as modalStyles } from '../styles'
import { modalOverlayAnimation, modalPanelAnimation } from '../motion'
import type { ModalHandle } from '../hooks/useModal'

// モーダルの幕と枠（開閉の動き・幕のクリックで閉じる・枠の中のクリックは幕へ通さない）。
// 振る舞いは useModal が持つ。data-modal は、ホイールを通す目印と、useGlobalKeys が Tab を素通しする目印。
export default function ModalFrame({ modal, overlayStyle, panelStyle, children }: {
  modal: ModalHandle
  /** 幕の上書き（設定画面は濃く・下の層に置く） */
  overlayStyle?: React.CSSProperties
  panelStyle?: React.CSSProperties
  children: React.ReactNode
}) {
  return (
    <div style={{ ...modalStyles.overlay, ...overlayStyle, animation: modalOverlayAnimation(modal.closing) }} onMouseDown={modal.requestClose}>
      <div ref={modal.panelRef} style={{ ...modalStyles.panel, ...panelStyle, animation: modalPanelAnimation(modal.closing) }}
        onMouseDown={(e) => e.stopPropagation()} data-modal>
        {children}
      </div>
    </div>
  )
}
