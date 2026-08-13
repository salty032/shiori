import { useEffect } from 'react'
import { useLatestRef } from './useLatestRef'
import type { ImageRow } from '../types'
import type { ShowToast } from './useToast'
import { t } from '../i18n'

interface GlobalKeysOptions {
  searchInputRef: React.RefObject<HTMLInputElement | null>
  viewerIdx: number | null
  // ビューアの並び基準（Ctrl+C で現在画像をコピーするために参照）
  activeImages: ImageRow[]
  // グリッド上で選択中の画像 ID（Ctrl+C でビューア外でもコピーするために参照）
  selectedIds: Set<number>
  onQuickTag: () => boolean
  // クリップボード取り込みでライブラリが変わったときのサイドバー再取得
  onLibraryChanged: () => void
  showToast: ShowToast
}

function isEditingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

// アプリ全体のグローバルキー操作をまとめて担当する。
// 空依存で 1 回だけ登録し、最新の props は useLatestRef 経由で読む
// （旧 App の viewerIdxRef / activeImagesRef ミラーをここへ内包）。
export function useGlobalKeys(opts: GlobalKeysOptions): void {
  const ref = useLatestRef(opts)

  // アプリ本体では Tab によるフォーカス移動を無効化する。操作は / ・矢印・Enter・Space・
  // Delete・Ctrl+A 等の専用ショートカットで完結しており、Tab で見えないフォーカスが飛ぶと
  // 次の Enter/Space が意図しない要素に入る誤操作の元になるため。
  //
  // モーダルが開いている間だけは素通しする。モーダル内の Tab 循環は useFocusTrap が
  // 「パネル要素上の keydown」で担っており、window まで上がってきたここで一律に潰すと、
  // 循環に介入しない中間位置（先頭でも末尾でもない）の Tab が死んでモーダルを
  // キーボードで操作できなくなる。判定は target の closest ではなく「開いているか」で行う:
  // モーダルを開いた直後などフォーカスがまだ body にある状態では target が
  // パネル外になり、closest 判定だとモーダルへ入る最初の Tab を潰してしまう。
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      if (document.querySelector('[role="dialog"]')) return
      e.preventDefault()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // 上の Tab 無効化と対になる措置。Tab を殺したことでフォーカスの移動手段はマウスの
  // クリックだけになったが、<button> はクリックでフォーカスを保持し続けるため、
  // 「設定を開いて閉じた後に Space を押すと設定がまた開く」ような取り違えが起きる
  // （押した本人にはフォーカスがどこにあるか見えない）。
  // mousedown の既定動作を止めるとフォーカスは移らず、click は mouseup で発火するので
  // ボタンとしての動作はそのまま残る。
  //
  // モーダル内は除外する。あちらは useFocusTrap がフォーカスを管理しており、
  // ここで奪うと Enter/Space での確定やトラップの循環が成立しなくなる。
  // 対象を button に限るのは、input/textarea はフォーカスできないと入力自体が不能になるため。
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      const el = e.target as HTMLElement | null
      const button = el?.closest?.('button')
      if (!button || button.closest('[role="dialog"]')) return
      e.preventDefault()
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [])

  // Ctrl+V でクリップボード画像をインポート（テキスト入力中は無視）
  useEffect(() => {
    // クリップボード読み取り〜登録は非同期。キー長押し等で連打されると同じ画像が
    // 複数回取り込まれるため、処理中は後続の Ctrl+V を無視する再入ガードを張る。
    let pasting = false
    const handler = async (e: KeyboardEvent): Promise<void> => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'v') return
      if (isEditingTarget(e.target)) return
      if (pasting) return
      pasting = true
      try {
        const result = await window.api.clipboardPaste()
        if (result.ok) {
          ref.current.onLibraryChanged()
          ref.current.showToast(t('toast.pastedFromClipboard'), 'success')
        } else if (result.reason === 'empty') {
          ref.current.showToast(t('toast.clipboardEmpty'), 'info')
        } else {
          ref.current.showToast(t('toast.pasteFailed'), 'error')
        }
      } finally {
        pasting = false
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [ref])

  // /キーで検索フォーカス・T でクイックタグ・ビューア開放中の Ctrl+C で画像コピー
  // （設定はサイドバー下部の歯車から開く。Ctrl+, は廃止した）
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const { searchInputRef, onQuickTag, viewerIdx, activeImages } = ref.current
      const editing = isEditingTarget(e.target)
      // ビューア表示中は素通しする。検索欄はビューアに覆われて見えないため、フォーカスだけが
      // そこへ移ると以降の矢印・Delete・Space・Escape が全て「入力中」扱いで死に、
      // 画面上は何も変わらないままビューアが操作不能になったように見える。
      if (!editing && viewerIdx === null && e.key === '/' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault()
        searchInputRef.current?.focus()
        return
      }
      if (!editing && e.key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (onQuickTag()) e.preventDefault()
        return
      }
      if (!editing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        // テキスト選択中（例: DetailPanel のタイトル）は標準のテキストコピーを優先し、画像コピーを横取りしない
        const selection = window.getSelection()
        if (selection && !selection.isCollapsed && selection.toString() !== '') return
        const { viewerIdx, activeImages, selectedIds, showToast } = ref.current
        let target: ImageRow | undefined
        if (viewerIdx !== null) {
          target = activeImages[viewerIdx]
        } else if (selectedIds.size === 1) {
          const [id] = selectedIds
          target = activeImages.find((img) => img.id === id)
        }
        if (!target) return
        if (target.media_type === 'video') {
          showToast(t('toast.videoCopyUnsupported'), 'info')
          return
        }
        e.preventDefault()
        window.api.clipboardCopyImage(target.id).then(
          (ok) => showToast(ok ? t('toast.copiedToClipboard') : t('toast.copyFailed'), ok ? 'success' : 'warning'),
          (err) => { console.error('[copy] clipboard write failed', err); showToast(t('toast.copyFailed'), 'warning') },
        )
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [ref])
}
