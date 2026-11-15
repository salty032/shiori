// ブラウザウィンドウが映っているディスプレイ。**中心点で決める。**
// 静止画・録画・供給の計測が別々に書いていた頃は、片方だけ決め方を変えると、
// 撮る画面と切り出しの基準にする画面が食い違う形だった。
import { screen, type Display } from 'electron'

export function displayAtWindowCenter(rect: { left: number; top: number; width: number; height: number }): Display {
  return screen.getDisplayNearestPoint({
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2)
  })
}
