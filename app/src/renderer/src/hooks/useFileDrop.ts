// ファイルのドロップ取り込み。App.tsx から切り出した。
//
// 持っているのは「取り込み枠を今出しているか」だけ。dragenter/dragleave は子要素をまたぐ
// たびに多発するので、カウンタで数えて 0 になったときだけ枠を消す。
import { useRef, useState } from 'react'
import type { ShowToast } from './useToast'
import { t, tp } from '../i18n'

export interface UseFileDropOptions {
  // ビューアを開いている間は取り込まない。理由は handleDragEnter のコメント。
  viewerIdx: number | null
  // 自分が始めた画像ドラッグが戻ってきただけかどうか（useSelection が持つ）。
  selfDragRef: React.MutableRefObject<boolean>
  // 取り込みが 1 件でも成功したときのサイドバー再取得。
  onImported: () => void
  showToast: ShowToast
}

export function useFileDrop({ viewerIdx, selfDragRef, onImported, showToast }: UseFileDropOptions) {
  // ドロップ可能領域の視覚フィードバック（S7-15）。dragenter/leave はネストで多発するため
  // カウンタ方式で管理し、アプリ内 D&D（将来追加時）に誤反応しないよう Files 型のみ見る。
  const [fileDragging, setFileDragging] = useState(false)
  const dragCounterRef = useRef(0)

  const handleFileDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    dragCounterRef.current = 0
    setFileDragging(false)
    // ビューアを開いている間は取り込まない（下の handleDragEnter の注記を参照）。
    if (viewerIdx !== null) return
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.api.getPathForFile(f))
      .filter(Boolean)
    if (paths.length === 0) return
    const result = await window.api.importFiles(paths)
    if (result.count > 0) {
      onImported()
      // B11/U-2: 200件上限で打ち切られた場合、超過分が黙って捨てられたことを明示する
      // CODE-REVIEW-v1.0.4 B-1: 一部失敗があった場合も成功一色にせず件数を明示する
      const truncatedMsg = result.truncated ? t('toast.importTruncatedSuffix') : ''
      const failedMsg = result.errors.length > 0 ? t('toast.importFailedSuffix', { count: result.errors.length }) : ''
      const isPartial = result.truncated || result.errors.length > 0
      showToast(tp('toast.imported', result.count) + truncatedMsg + failedMsg, isPartial ? 'warning' : 'success')
    } else if (result.errors.length > 0) {
      showToast(t('toast.importAllFailed', { count: result.errors.length }), 'warning')
    }
  }

  function handleDragEnter(e: React.DragEvent): void {
    if (!e.dataTransfer.types.includes('Files')) return
    // 自分が始めた画像ドラッグが戻ってきただけ。取り込みは main 側で弾かれる（何も起きない）ので、
    // 「ドロップで取り込む」枠を出すと嘘になる。
    if (selfDragRef.current) return
    // ビューアを開いている間は取り込みの導線を出さない。ビューアは「この1本を見る」画面で、
    // ライブラリへの追加はそこでやることではない。映像の上に取り込み枠が被ると、
    // 今見ているクリップに対する操作だと誤解させる。
    if (viewerIdx !== null) return
    dragCounterRef.current += 1
    setFileDragging(true)
  }

  function handleDragLeave(e: React.DragEvent): void {
    if (!e.dataTransfer.types.includes('Files')) return
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
    if (dragCounterRef.current === 0) setFileDragging(false)
  }

  return { fileDragging, handleFileDrop, handleDragEnter, handleDragLeave }
}
