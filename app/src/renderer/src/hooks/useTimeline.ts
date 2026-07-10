import { useCallback, useEffect } from 'react'
import type { ShowToast } from './useToast'
import { selectQueryKey, useFilterStore } from '../stores/filterStore'
import { useImageStore } from '../stores/imageStore'

// タイムライン表示は通常のグリッド（カーソルページング）とは別に、
// フィルタ一致を一括取得して作品別グルーピングできるようにする。
// 画像データは imageStore が所有し、ここは購読 + ライフサイクル配線のみ。
export function useTimeline(active: boolean, showToast: ShowToast) {
  const images = useImageStore((s) => s.timelineImages)
  const loading = useImageStore((s) => s.timelineLoading)
  // countImages の真値。MAX_TIMELINE_LIMIT で打ち切られる images.length と違い、
  // グリッド表示の totalCount と同じ意味でサイドバー件数表示に使える（D-3）。
  const totalCount = useImageStore((s) => s.timelineTotalCount)

  const reload = useCallback(() => useImageStore.getState().reloadTimeline(showToast), [showToast])

  // 確定フィルタの同一性。変化したらタイムラインを再取得する。
  const queryKey = useFilterStore(selectQueryKey)

  // タイムライン表示中だけ取得。フィルタ変更（queryKey）でも再取得する。
  useEffect(() => {
    if (active) reload()
  }, [active, queryKey, reload])

  return { images, loading, totalCount, reload }
}
