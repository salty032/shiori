// コアが提供する main プロセスの拡張点。動画（録画クリップ・トリミング）のような
// 追加機能は、この形にして bootstrap() へ渡す。
//
// **今ビルドされる構成は 1 つだけ**（src/main/index.ts が videoFeature を渡す・
// preload も動画 API を含む）。この継ぎ目は「動画機能を丸ごと落とした構成をあとから
// 切り出せるようにする」ためのもので、そのための専用エントリポイントや build target は
// まだ無い。実際に切り出すときは main/renderer/preload それぞれのエントリと tsconfig を
// 用意すること——コメントだけが先にある状態にしないため、ここに明記しておく。
export interface MainFeature {
  // IPC ハンドラの登録（ipcMain.handle/on 等）。
  registerIpc?(): void
  // メインウィンドウ生成後、whenReady 内で呼ばれる初期化（recorder ウィンドウ生成等）。
  onReady?(): void | Promise<void>
  // before-quit 時のクリーンアップ。
  onBeforeQuit?(): void
}
