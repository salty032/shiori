import { contextBridge, ipcRenderer } from 'electron'

// recorder:* はレコーダーウィンドウ専用の別契約（RecorderApi）で、ShioriApi の CH 定数の
// 対象外（main 側の検証も isTrustedRecorderSender と別方式）。意図的に生文字列のまま。
contextBridge.exposeInMainWorld('recorderApi', {
  // 画面キャプチャの立ち上げまで（記録は始めない）。**重いのはこちら**なので、落ち着き待ちの
  // 前に済ませる（recording.ts / recorder.ts の注記）。
  onPrepare: (cb: (data: { sourceId: string; fps: number; sessionId: number }) => void) => {
    ipcRenderer.on('recorder:prepare', (_e, data) => cb(data))
  },
  // 準備が済んだ合図。main はこれを受けてから、コマ通知が落ち着くのを待つ。
  reportReady: (sessionId: number) => {
    ipcRenderer.send('recorder:ready', sessionId)
  },
  onStart: (cb: (data: { supplyFps: number; sourceFps: number | null; maxSeconds: number }) => void) => {
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
  sendDone: (webm: ArrayBuffer, duration: number, sessionId: number, drawnAt: number[], diag: unknown) => {
    ipcRenderer.send('recorder:done', webm, duration, sessionId, drawnAt, diag)
  },
  // 録画が実際に止まった時点の合図。重い後処理（尺補正・ArrayBuffer 化・IPC 転送）の
  // 前に出し、main 側でプレーヤー UI の復帰だけを先に流させる。
  reportStopped: (sessionId: number) => {
    ipcRenderer.send('recorder:stopped', sessionId)
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
