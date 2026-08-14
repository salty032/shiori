import { useCallback, useEffect } from 'react'
import type { ShowToast } from './useToast'
import { selectQueryKey, useFilterStore } from '../stores/filterStore'
import { useImageStore } from '../stores/imageStore'

// タイムライン表示は最新200件から始め、ユーザー操作で古いページを追加していく。
// 読み込んだ範囲を作品別にグルーピングする配列をこのフックから公開する。
// 画像データは imageStore が所有し、ここは購読 + ライフサイクル配線のみ。
export function useTimeline(active: boolean, showToast: ShowToast) {
  const images = useImageStore((s) => s.timelineImages)
  const loading = useImageStore((s) => s.timelineLoading)
  const hasMore = useImageStore((s) => s.timelineHasMore)
  // countImages の真値。ページング途中の images.length と分けて保持する。
  const totalCount = useImageStore((s) => s.timelineTotalCount)

  const reload = useCallback(() => useImageStore.getState().reloadTimeline(showToast), [showToast])
  const requestMore = useCallback(() => useImageStore.getState().loadMoreTimeline(showToast), [showToast])

  // 確定フィルタの同一性。変化したらタイムラインを再取得する。
  const queryKey = useFilterStore(selectQueryKey)

  // タイムライン表示中だけ取得。フィルタ変更（queryKey）でも再取得する。
  useEffect(() => {
    if (active) reload()
  }, [active, queryKey, reload])

  return { images, loading, hasMore, totalCount, reload, requestMore }
}
