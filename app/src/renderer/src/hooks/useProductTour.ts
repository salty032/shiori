// 実操作ガイド（Product Tour）の進行。App.tsx から切り出した。
//
// **説明の「次へ」では進まない段が混ざっている。** 選択・ビューアの開閉・表示切替は、
// アプリ側の実状態が変わったときだけ次へ送る（読み飛ばしただけで「やった」ことにしない）。
// 段の番号と進む条件は下の useEffect が全部で、ProductTour.tsx は表示だけを持つ。
import { useCallback, useEffect, useState } from 'react'
import type { ProductTourStep } from '../components/ProductTour'
import type { ImageRow } from '../types'
import type { ShowToast } from './useToast'
import type { ViewMode } from '../components/Toolbar'
import { t } from '../i18n'
import { useLatestRef } from './useLatestRef'

export interface UseProductTourOptions {
  images: ImageRow[]
  // 起動後に新しく増えた画像の id。提案は「自分で撮れた直後」に限るための判定に使う。
  newIds: Set<number>
  selectedCount: number
  viewerIdx: number | null
  viewMode: ViewMode
  showToast: ShowToast
  // 開始時に画面をガイドの前提へ戻す（フィルタ解除・ビューアを閉じる・グリッドへ・選択解除）。
  resetForTour: () => void
}

export function useProductTour({
  images, newIds, selectedCount, viewerIdx, viewMode, showToast, resetForTour,
}: UseProductTourOptions) {
  const [productTourStep, setProductTourStep] = useState<ProductTourStep | null>(null)
  // 呼び出し元が毎レンダー作り直す関数を受け取るため、ref 越しに呼んで startProductTour を
  // 固定する。ここが毎回変わると、下の「提案トースト」の effect も毎レンダー走る。
  const resetRef = useLatestRef(resetForTour)

  const startProductTour = useCallback((): void => {
    resetRef.current()
    setProductTourStep(0)
  }, [resetRef])

  // 初めて自分でキャプチャできた直後が、実画面の使い方を試す最も自然なタイミング。
  // 既存ライブラリの読込ではなく newIds に入ったキャプチャだけを対象にし、提案は端末で1度に限る。
  useEffect(() => {
    if (!images.some((image) => image.source === 'capture' && newIds.has(image.id))) return
    const key = 'shiori-product-tour-offered-v1'
    try {
      if (localStorage.getItem(key)) return
      localStorage.setItem(key, '1')
    } catch {
      // 保存できない環境でも提案自体は妨げない。
    }
    showToast(t('tour.offer'), 'info', 10_000, { label: t('tour.offerAction'), onClick: startProductTour })
  }, [images, newIds, startProductTour, showToast])

  // 実操作ガイドは説明の「次へ」では進めない。選択・ビューア開閉・表示切替という
  // アプリ側の実状態が変わったときだけ次の操作へ進む。
  useEffect(() => {
    if (productTourStep === 0 && selectedCount > 0) setProductTourStep(1)
    if (productTourStep === 1 && viewerIdx !== null) setProductTourStep(2)
    if (productTourStep === 2 && viewerIdx === null) setProductTourStep(3)
    if (productTourStep === 4 && viewMode === 'timeline') setProductTourStep(5)
  }, [productTourStep, selectedCount, viewerIdx, viewMode])

  const advanceProductTour = useCallback((): void => {
    if (productTourStep === null) return
    if (productTourStep >= 5) {
      setProductTourStep(null)
      showToast(t('tour.completed'), 'success')
      return
    }
    setProductTourStep((productTourStep + 1) as ProductTourStep)
  }, [productTourStep, showToast])

  return { productTourStep, startProductTour, advanceProductTour, exitProductTour: () => setProductTourStep(null) }
}
