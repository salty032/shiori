import { useCallback, useEffect } from 'react'
import type { ShowToast } from './useToast'
import { selectQueryKey, useFilterStore } from '../stores/filterStore'
import { useImageStore } from '../stores/imageStore'

// 画像データそのものは imageStore が単一の真実として所有する。
// このフックは「グリッド表示のための購読 + ライフサイクル配線」だけを担う薄いラッパー。
export function useImageList(showToast: ShowToast) {
  const images = useImageStore((s) => s.gridImages)
  const hasMore = useImageStore((s) => s.gridHasMore)
  const totalCount = useImageStore((s) => s.gridTotalCount)
  const loading = useImageStore((s) => s.gridLoading)
  const reloading = useImageStore((s) => s.gridReloading)
  const loadFailed = useImageStore((s) => s.gridLoadFailed)

  // 検索条件(queryKey)が変わった場合も、一覧は即座に空にせず新しい1ページ目が届いてから
  // 丸ごと差し替える（loadMoreGrid の isFirstPage 分岐）。空にしてから出し直すと一瞬グリッドが
  // 空白になってチラついて見えるため。検索中であることは reloading フラグ(検索アイコン→
  // スピナー表示)で分かるので、新旧混在の紛らわしさは生じない。
  const reload = useCallback(() => useImageStore.getState().reloadGrid(showToast), [showToast])
  const requestMore = useCallback(() => useImageStore.getState().loadMoreGrid(showToast), [showToast])

  // 確定フィルタ＋並び順の同一性。これが変わったらリストをリセットして再読込する。
  const queryKey = useFilterStore(selectQueryKey)

  // グリッドのランダムはサーバ ORDER BY RANDOM() なので、再シャッフルには再読込が要る。
  // ただし shuffleSeed を共有の selectQueryKey に入れるとタイムライン（クライアント側 lcgShuffle で
  // リロード不要に再シャッフル）まで余計に再取得＝ローディング点滅してしまう。そこでグリッド側だけ
  // 「ランダム時のみ seed を依存に含める」ことで、再度「ランダム」を選ぶとグリッドも再シャッフルする。
  const randomKey = useFilterStore((s) => s.sortOrder === 'random' ? s.shuffleSeed : 0)

  // queryKey 変化（＝確定フィルタ/並び順の変更）でリストをリセットして再読込。
  // 初回マウント時も実行され、これが一覧の初期ロードを担う。
  // 選択のクリアは useSelection 自身が queryKey を購読して行う（責務を分離）。
  useEffect(() => { reload() }, [queryKey, randomKey, reload])

  return { images, loading, reloading, loadFailed, hasMore, totalCount, requestMore, reload }
}
