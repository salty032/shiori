// コアが提供する main プロセスの拡張点。full 版だけが video などの機能を
// この形で bootstrap() に渡す。capture 版はコアだけで動くため features: [] でよい。
export interface MainFeature {
  // IPC ハンドラの登録（ipcMain.handle/on 等）。
  registerIpc?(): void
  // メインウィンドウ生成後、whenReady 内で呼ばれる初期化（recorder ウィンドウ生成等）。
  onReady?(): void | Promise<void>
  // before-quit 時のクリーンアップ。
  onBeforeQuit?(): void
}
