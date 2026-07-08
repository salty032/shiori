import { useEffect } from 'react'
import { useLatestRef } from './useLatestRef'
import { hasCommittedFilter, useFilterStore } from '../stores/filterStore'
import { useImageStore } from '../stores/imageStore'
import type { ShowToast } from './useToast'

export interface CaptureSyncOptions {
  // キャプチャでライブラリ内容が変わったときのサイドバー再取得（サービス/カラー）
  onLibraryChanged: () => void
  showToast: ShowToast
  // タイムライン表示中かどうか（P-1）。非表示中は reloadTimeline（最大5000行の一括取得）を
  // 省略する。useTimeline 側が表示切り替え時に必ず reload するため、次に開いたときには
  // 最新化される（stale フラグを別途持つ必要はない）。
  timelineActive: boolean
}

// 新規キャプチャ通知（IPC）を受けて画像ストア・サイドバー・選択を同期する。
// 空依存で 1 回だけ購読し、最新の props は useLatestRef 経由で読む
// （旧 App の viewModeRef ミラーをここへ内包）。
// ビューアが開いていれば「同じ画像を指し続ける」よう viewerIdx を追従させる処理は、
// App 側の activeImages 変化を id ベースで追従する汎用ロジックに一元化している
// （ここで grid/timeline ごとに index を手で補正すると、配列が丸ごと差し替わる
// reloadGrid/reloadTimeline のケースと衝突して二重補正でズレるため）。
const CAPTURE_SYNC_DEBOUNCE_MS = 300

export function useCaptureSync(opts: CaptureSyncOptions): void {
  const ref = useLatestRef(opts)
  useEffect(() => {
    // フォルダドロップ等で capture:done が件数分連打されると、タイムライン全再取得
    // （最大5000行）とサイドバー集計（sites/colors）が件数分バーストする。reloadGrid
    // （フィルタ中のみ）/ reloadTimeline / onLibraryChanged はまとめてトレーリング
    // デバウンスし、markNewCaptured と（先頭挿入で足りる場合の）prependToGrid だけ
    // 即時のまま保つ（キャプチャ1枚の体感即時性を落とさないため）。
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let needsGridReload = false
    const flush = (): void => {
      flushTimer = null
      const { onLibraryChanged, showToast, timelineActive } = ref.current
      const store = useImageStore.getState()
      if (needsGridReload) {
        needsGridReload = false
        // フィルタ表示中に楽観的 prepend するとフィルタ非該当の画像が紛れ件数もズレる。
        // 再クエリして「条件に合致するキャプチャだけ」が現れるようにする（タイムラインと同方針）。
        store.reloadGrid(showToast)
      }
      // タイムラインは一括取得結果に新規キャプチャが含まれないため再取得が必要だが（フィルタも反映される）、
      // グリッド表示中（非表示）はこの5000行クエリが無駄なので省略する（P-1）。
      if (timelineActive) store.reloadTimeline(showToast)
      onLibraryChanged()
    }
    const scheduleFlush = (): void => {
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = setTimeout(flush, CAPTURE_SYNC_DEBOUNCE_MS)
    }
    const unsubscribe = window.api.onCapture(async ({ id }) => {
      const { showToast } = ref.current
      if (id == null) {
        showToast('キャプチャ画像の登録に失敗しました。アプリを再起動してもう一度試してください。', 'error')
        return
      }
      let img
      try {
        img = await window.api.getImage(id)
      } catch (err) {
        console.error('[capture] getImage failed', err)
        showToast('キャプチャ画像を一覧に追加できませんでした。', 'error')
        return
      }
      if (!img) {
        showToast('キャプチャ画像を一覧に追加できませんでした。', 'error')
        return
      }
      const store = useImageStore.getState()
      // 新着 NEW として即時バッジ表示（裏画面でも付く。消去カウントは前面表示中だけ進む）
      store.markNewCaptured(id)
      const filtered = hasCommittedFilter(useFilterStore.getState())
      const { sortOrder } = useFilterStore.getState()
      // フィルタなし・新しい順（date_desc）で、かつ先頭挿入しても並び順が崩れない
      // （＝この画像が現在の先頭以上に新しい）ときだけ先頭挿入する。それ以外（S4-5: 古い順・
      // ランダムでの先頭挿入で並びが崩れるケースに加えて、フォルダ/ファイルインポートは
      // captured_at が元ファイルの更新日時になるため、既存の先頭より古いことがある）は
      // 再クエリに倒す。先頭より古いキャプチャを先頭挿入すると、カーソルページングが後で
      // その captured_at 位置まで進んだときに同じ行を再取得して二重表示になる。
      const top = store.gridImages[0]
      if (!filtered && sortOrder === 'date_desc' && (!top || img.captured_at >= top.captured_at)) {
        store.prependToGrid(img)
      } else {
        needsGridReload = true
      }
      scheduleFlush()
    })
    return () => {
      unsubscribe()
      if (flushTimer) clearTimeout(flushTimer)
    }
  }, [ref])

  // NEW バッジ自体は裏画面でも即時に付く（markNewCaptured）。ここでは「消える
  // カウント」を前面表示中だけ進める。前面化で開始、背面化で停止して NEW を保持する。
  useEffect(() => {
    const startIfForeground = (): void => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        useImageStore.getState().startNewCountdown()
      }
    }
    const pause = (): void => useImageStore.getState().pauseNewCountdown()
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') startIfForeground()
      else pause()
    }
    window.addEventListener('focus', startIfForeground)
    window.addEventListener('blur', pause)
    document.addEventListener('visibilitychange', onVisibility)
    startIfForeground()  // マウント時に既に前面なら開始（NEW が無ければ no-op）
    return () => {
      window.removeEventListener('focus', startIfForeground)
      window.removeEventListener('blur', pause)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
}
