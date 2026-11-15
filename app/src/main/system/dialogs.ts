// 親ウィンドウを付けてダイアログを出す。
//
// 親を渡さないとダイアログがモーダル化されず、他ウィンドウの操作で背面に隠れると
// 「押したのに何も起きない」ように見える（BUG-3）。親が無いとき（ウィンドウを閉じた後など）だけ
// 親なしで出す。既定の親はメインウィンドウ。
import { dialog, type BrowserWindow } from 'electron'
import { getMainWindow } from './windows'

export function showOpenDialogOver(
  options: Electron.OpenDialogOptions, parent: BrowserWindow | null = getMainWindow()
): Promise<Electron.OpenDialogReturnValue> {
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)
}

export function showMessageBoxOver(
  options: Electron.MessageBoxOptions, parent: BrowserWindow | null = getMainWindow()
): Promise<Electron.MessageBoxReturnValue> {
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
}
