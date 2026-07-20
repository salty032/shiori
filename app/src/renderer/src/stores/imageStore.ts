import { create } from 'zustand'
import type { ImageRow } from '../types'
import type { ShowToast } from '../hooks/useToast'
import { getCommitted, useFilterStore } from './filterStore'
import { buildImageQuery } from './imageQuery'
import { t, currentLocale } from '../i18n'

const PAGE_SIZE = 50

// グリッド（カーソルページング）とタイムライン（一括取得）は取得方式が本質的に異なるため、
// 配列は 2 本持つ。ただし「画像という 1 つの真実」をこのストアが所有し、
// patch / remove / prepend といった変更操作はここに一元化する。
// これにより App 側が両リストを手で同期する必要がなくなり、
// 「片方のリストだけ更新して表示がズレる」クラスのバグを構造的に防ぐ。

// 非リアクティブなカーソル・世代管理（購読対象にしない可変状態）。
// ストアはシングルトンなのでモジュールスコープに置く。
const grid = {
  listGeneration: 0,
  countGeneration: 0,
  hasMore: true,
  loading: false,
  lastCapturedAt: null as number | null,
  lastId: null as number | null,
}
let timelineGeneration = 0
// B10: タイムラインは MAX_TIMELINE_LIMIT（5000件）でキャップされる。reloadTimeline は
// キャプチャのたびに走るため、上限超過のたびに毎回トーストを出すとスパムになる。
// 「上限に当たった」→「一旦下回った」の遷移でのみ再通知するようフラグで一回性を保つ。
let timelineTruncatedNotified = false

// 削除保留中（Undo 猶予中）の画像 id 集合。queueDelete は選択直後に UI から画像を消すが、
// DB からは Undo 猶予（DELETE_UNDO_MS）が明けるまで実際には消えていない。この間にフィルタ変更・
// 新規キャプチャ等で一覧の再取得（loadMoreGrid/reloadTimeline）が走ると、消したはずの行が
// サーバーからそのまま返ってきて復活してしまい、猶予明けの実削除後にサムネ欠損の
// ゴースト行として残り続ける。再取得結果からこの集合の id を除外することでそれを防ぐ。
const pendingDeleteIds = new Set<number>()
export function markPendingDelete(ids: Iterable<number>): void {
  for (const id of ids) pendingDeleteIds.add(id)
}
export function unmarkPendingDelete(ids: Iterable<number>): void {
  for (const id of ids) pendingDeleteIds.delete(id)
}

// 新着キャプチャの NEW 表示。キャプチャは裏画面（Shiori 非フォーカス）でも受信時に即バッジを
// 付ける。ただし「消えるカウント」は Shiori が前面に表示されている間だけ進める。背面では
// タイマーを止めて NEW を保持し、戻ってきてから数秒で自然に消す。これにより「席に戻って
// Shiori を開いたら今撮った分がどれか一目で分かる」体験にする。
let newClearTimer: ReturnType<typeof setTimeout> | null = null
const NEW_BADGE_DURATION_MS = 5000

export type RemovedImagesSnapshot = {
  grid: { index: number; image: ImageRow }[]
  timeline: { index: number; image: ImageRow }[]
  gridTotalCount: number | null
  timelineTotalCount: number | null
  // removeImages に渡された ids 全体（グリッド/タイムラインに未ロードだった分も含む）。
  // 件数の巻き戻しは grid/timeline の snapshot（ロード済み行だけ）ではなくこちらから数える。
  removedIds: number[]
}

type ImageState = {
  // --- グリッド（カーソルページング） ---
  gridImages: ImageRow[]
  gridHasMore: boolean
  gridTotalCount: number | null
  gridLoading: boolean
  // クエリ変更（検索確定・フィルタ変更）による再読込中かどうか。gridLoading は無限スクロールの
  // 追加読み込み中も true になるため区別できず、検索ボックス側のローディング表示にはこちらを使う。
  gridReloading: boolean
  // --- タイムライン（一括取得） ---
  timelineImages: ImageRow[]
  timelineLoading: boolean
  // countImages の真値（MAX_TIMELINE_LIMIT で打ち切られる timelineImages.length とは別。
  // サイドバーの件数表示をグリッド表示と一貫させるために使う。D-3）
  timelineTotalCount: number | null
  // --- 新着 NEW 表示（裏画面でも即時。消去は前面化後の数秒） ---
  newIds: Set<number>

  // --- フェッチ ---
  loadMoreGrid: (showToast: ShowToast) => Promise<void>
  reloadGrid: (showToast: ShowToast) => void
  reloadTimeline: (showToast: ShowToast) => Promise<void>

  // --- 変更操作（両リストに反映する単一の入口） ---
  // タイトル/メモ編集などの部分更新。グリッド・タイムライン双方に反映する
  // （タイムラインはタイトル変更で再グルーピングされる）。
  patchImage: (id: number, patch: Partial<ImageRow>) => void
  // 削除。両リストから取り除き、削除された件数だけグリッド件数を減らす。
  removeImages: (ids: Set<number>) => RemovedImagesSnapshot
  restoreImages: (snapshot: RemovedImagesSnapshot, ids?: Set<number>) => void
  // 新規キャプチャをグリッド先頭へ楽観的に追加（件数も +1）。
  prependToGrid: (img: ImageRow) => void
  // 件数のみ調整（楽観更新の微調整用）。
  adjustGridTotalCount: (delta: number) => void

  // 新着キャプチャを NEW として即時表示（裏画面でもバッジを付ける）。
  markNewCaptured: (id: number) => void
  // 前面表示中だけ消去カウントを進める。前面化のたびに開始/張り直す。
  startNewCountdown: () => void
  // 背面化したらカウントを止める（NEW バッジは保持する）。
  pauseNewCountdown: () => void
}

export const useImageStore = create<ImageState>((set, get) => ({
  gridImages: [],
  gridHasMore: true,
  gridTotalCount: null,
  gridLoading: false,
  gridReloading: false,
  timelineImages: [],
  timelineLoading: false,
  timelineTotalCount: null,
  newIds: new Set(),

  loadMoreGrid: async (showToast) => {
    if (grid.loading || !grid.hasMore) return
    const generation = grid.listGeneration
    // カーソル未進行＝この generation の1ページ目。reloadGrid が gridImages を
    // 即座に空にしない代わりに、1ページ目が届いた瞬間ここで丸ごと置き換える
    // （カーソルが進んでいる＝通常の追加ロードなら従来どおり末尾へ追記）。
    const isFirstPage = grid.lastCapturedAt === null && grid.lastId === null
    grid.loading = true
    set({ gridLoading: true })
    try {
      // 現在のフィルタ値はストアから命令的に読む
      const st = useFilterStore.getState()
      const fetched = await window.api.listImages({
        ...buildImageQuery(getCommitted(st)),
        limit: PAGE_SIZE,
        before: grid.lastCapturedAt ?? undefined,
        beforeId: grid.lastId ?? undefined,
        sortOrder: st.sortOrder,
      })
      if (generation !== grid.listGeneration) return
      // カーソル（次ページの起点）は削除保留中の行も含めた「実際に返ってきた最後の行」を
      // 基準にする。表示用配列だけ保留中の行を除外すると、ページングの連続性を保ったまま
      // 削除待ちの行だけを一覧から隠せる（imageStore.ts 冒頭の pendingDeleteIds 参照）。
      const next = pendingDeleteIds.size > 0 ? fetched.filter((img) => !pendingDeleteIds.has(img.id)) : fetched
      set((s) => ({ gridImages: isFirstPage ? next : [...s.gridImages, ...next] }))
      if (fetched.length > 0) {
        grid.lastCapturedAt = fetched[fetched.length - 1].captured_at
        grid.lastId = fetched[fetched.length - 1].id
      }
      if (fetched.length < PAGE_SIZE || st.sortOrder === 'random') {
        grid.hasMore = false
        set({ gridHasMore: false })
      }
    } catch (err) {
      console.error('[images] loadMore failed', err)
      if (generation === grid.listGeneration) showToast(t('toast.loadImagesFailed'), 'error')
    } finally {
      if (generation === grid.listGeneration) {
        grid.loading = false
        set({ gridLoading: false, ...(isFirstPage ? { gridReloading: false } : {}) })
      }
    }
  },

  // 一覧を先頭から再取得する（カーソル・件数をリセット）。queryKey 変化時の再読込と、
  // フィルタ表示中のキャプチャ後に「条件に合致するものだけ」を取り直すのに使う。
  // 一覧は即座に空にせず、新しい1ページ目が届いた瞬間に丸ごと差し替える
  // （loadMoreGrid の isFirstPage 分岐）。空にしてから出し直すと一瞬空白になってチラつくため。
  reloadGrid: (showToast) => {
    grid.listGeneration++
    grid.lastCapturedAt = null
    grid.lastId = null
    grid.hasMore = true
    grid.loading = false
    set({ gridHasMore: true, gridReloading: true })

    get().loadMoreGrid(showToast)

    const generation = ++grid.countGeneration
    window.api.countImages(buildImageQuery(getCommitted(useFilterStore.getState())))
      .then((count) => { if (generation === grid.countGeneration) set({ gridTotalCount: count }) })
      .catch((err) => console.error('[images] count failed', err))
  },

  reloadTimeline: async (showToast) => {
    const generation = ++timelineGeneration
    set({ timelineLoading: true })
    try {
      const query = buildImageQuery(getCommitted(useFilterStore.getState()))
      const [rows, count] = await Promise.all([window.api.listAllImages(query), window.api.countImages(query)])
      if (generation !== timelineGeneration) return
      // truncated 判定（下）は MAX_TIMELINE_LIMIT の上限到達を見るものなので、削除保留中の
      // 除外前（rows.length）で行う。表示にだけ pendingDeleteIds を反映する。
      const filteredRows = pendingDeleteIds.size > 0 ? rows.filter((img) => !pendingDeleteIds.has(img.id)) : rows
      set({ timelineImages: filteredRows, timelineTotalCount: count })
      if (count > rows.length) {
        if (!timelineTruncatedNotified) {
          timelineTruncatedNotified = true
          showToast(t('toast.timelineTruncated', { shown: rows.length.toLocaleString(currentLocale()), total: count.toLocaleString(currentLocale()) }), 'warning')
        }
      } else {
        timelineTruncatedNotified = false
      }
    } catch (err) {
      console.error('[timeline] load failed', err)
      if (generation === timelineGeneration) showToast(t('toast.loadTimelineFailed'), 'error')
    } finally {
      if (generation === timelineGeneration) set({ timelineLoading: false })
    }
  },

  patchImage: (id, patch) => set((s) => ({
    gridImages: s.gridImages.map((img) => img.id === id ? { ...img, ...patch } : img),
    timelineImages: s.timelineImages.map((img) => img.id === id ? { ...img, ...patch } : img),
  })),

  // 削除対象は必ず現在のフィルタ一致（=件数に含まれる）ものなので、グリッド未ロード分も
  // 含めて ids.size ぶん件数を減らす（旧 onCountChange(-deletedIds.size) と同じ挙動）。
  removeImages: (ids) => {
    const s = get()
    const snapshot: RemovedImagesSnapshot = {
      grid: s.gridImages
        .map((image, index) => ({ index, image }))
        .filter(({ image }) => ids.has(image.id)),
      timeline: s.timelineImages
        .map((image, index) => ({ index, image }))
        .filter(({ image }) => ids.has(image.id)),
      gridTotalCount: s.gridTotalCount,
      timelineTotalCount: s.timelineTotalCount,
      removedIds: [...ids],
    }
    set({
      gridImages: s.gridImages.filter((img) => !ids.has(img.id)),
      timelineImages: s.timelineImages.filter((img) => !ids.has(img.id)),
      gridTotalCount: s.gridTotalCount !== null ? s.gridTotalCount - ids.size : null,
      // D-3: サイドバー件数をタイムライン表示中も真値で出すため、グリッドと同じ扱いで減算する。
      timelineTotalCount: s.timelineTotalCount !== null ? s.timelineTotalCount - ids.size : null,
    })
    return snapshot
  },

  restoreImages: (snapshot, ids) => set((s) => {
    const shouldRestore = (id: number): boolean => !ids || ids.has(id)
    const restoreList = (
      current: ImageRow[],
      entries: { index: number; image: ImageRow }[],
    ): ImageRow[] => {
      const next = [...current]
      const currentIds = new Set(next.map((img) => img.id))
      for (const { index, image } of entries.filter(({ image }) => shouldRestore(image.id)).sort((a, b) => a.index - b.index)) {
        if (currentIds.has(image.id)) continue
        next.splice(Math.min(index, next.length), 0, image)
        currentIds.add(image.id)
      }
      return next
    }
    // 件数の復元は snapshot に積まれたロード済み行ではなく removeImages 時点の ids 全体から
    // 数える。グリッドが1ページしか読み込んでいない状態で大量選択→削除→Undo すると、
    // 未ロード分がロード済み行の集計から漏れて件数が戻り切らないため。
    const restoredCount = snapshot.removedIds.filter(shouldRestore).length
    return {
      gridImages: restoreList(s.gridImages, snapshot.grid),
      timelineImages: restoreList(s.timelineImages, snapshot.timeline),
      gridTotalCount: s.gridTotalCount !== null ? s.gridTotalCount + restoredCount : snapshot.gridTotalCount,
      timelineTotalCount: s.timelineTotalCount !== null ? s.timelineTotalCount + restoredCount : snapshot.timelineTotalCount,
    }
  }),

  prependToGrid: (img) => set((s) => ({
    gridImages: [img, ...s.gridImages],
    gridTotalCount: s.gridTotalCount !== null ? s.gridTotalCount + 1 : null,
  })),

  adjustGridTotalCount: (delta) => set((s) => ({
    gridTotalCount: s.gridTotalCount !== null ? s.gridTotalCount + delta : null,
  })),

  markNewCaptured: (id) => {
    // 裏画面でも即バッジを付ける
    set((s) => { const next = new Set(s.newIds); next.add(id); return { newIds: next } })
    // 前面なら消去カウントを張り直し、背面なら止めて保持する
    if (typeof document !== 'undefined' && document.hasFocus()) get().startNewCountdown()
    else get().pauseNewCountdown()
  },

  startNewCountdown: () => {
    if (newClearTimer) clearTimeout(newClearTimer)
    if (get().newIds.size === 0) { newClearTimer = null; return }
    newClearTimer = setTimeout(() => {
      newClearTimer = null
      set({ newIds: new Set() })
    }, NEW_BADGE_DURATION_MS)
  },

  pauseNewCountdown: () => {
    if (newClearTimer) { clearTimeout(newClearTimer); newClearTimer = null }
  },
}))
