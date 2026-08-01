import { contextBridge, ipcRenderer } from 'electron'

// recorder:* はレコーダーウィンドウ専用の別契約（RecorderApi）で、ShioriApi の CH 定数の
// 対象外（main 側の検証も isTrustedRecorderSender と別方式）。意図的に生文字列のまま。
contextBridge.exposeInMainWorld('recorderApi', {
  onStart: (cb: (data: { sourceId: string; fps: number; maxSeconds: number; sessionId: number }) => void) => {
    ipcRenderer.on('recorder:start', (_e, data) => cb(data))
  },
  onStop: (cb: () => void) => {
    ipcRenderer.on('recorder:stop', () => cb())
  },
  getCrop: (streamW: number, streamH: number) =>
    ipcRenderer.invoke('recorder:getCrop', streamW, streamH),
  // drawnAt: 供給した各フレームが画面から取り込まれた時刻（epoch ミリ秒）。
  // 配信ページ側から届く素材のコマ時刻と突き合わせ、素材のコマとファイル内の
  // フレームを対応付けるために使う。
  // diag: 供給の実測値（診断ログ専用。main 側の capture-diag.ts が検証して使う）。
  sendDone: (webm: ArrayBuffer, duration: number, frameCount: number, sessionId: number, drawnAt: number[], diag: unknown) => {
    ipcRenderer.send('recorder:done', webm, duration, frameCount, sessionId, drawnAt, diag)
  },
  reportError: (msg: string, sessionId: number) => {
    ipcRenderer.send('recorder:error', msg, sessionId)
  },
  // 供給レートの計測（開発時のみ。main の supply-bench.ts が駆動する）。
  onBench: (cb: (data: unknown) => void) => {
    ipcRenderer.on('recorder:bench', (_e, data) => cb(data))
  },
  sendBenchResult: (results: unknown) => {
    ipcRenderer.send('recorder:benchResult', results)
  }
})
