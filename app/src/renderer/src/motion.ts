// 閉じるアニメーションの長さと、それを使う animation の文字列。
// **待つ時間（setTimeout）と animation の秒数はここから作る。** 別々に書くと、片方だけ変えたとき
// アニメーションの途中で消える・終わってから一瞬残る。keyframes 本体は global.css。

export const MODAL_CLOSE_MS = 110
export const TOAST_EXIT_MS = 300

const sec = (ms: number): string => `${ms / 1000}s`

export function modalOverlayAnimation(closing: boolean): string {
  return closing ? `shioriOverlayOut ${sec(MODAL_CLOSE_MS)} ease-out forwards` : 'shioriOverlayIn 0.12s ease-out'
}

export function modalPanelAnimation(closing: boolean): string {
  return closing ? `shioriPopOut ${sec(MODAL_CLOSE_MS)} ease-out forwards` : 'shioriPopIn 0.15s ease-out'
}

export function toastAnimation(closing: boolean): string {
  return closing ? `shioriToastOut ${sec(TOAST_EXIT_MS)} ease-in forwards` : 'shioriToastIn 0.22s ease-out'
}
