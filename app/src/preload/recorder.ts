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
  sendDone: (webm: ArrayBuffer, duration: number, frameCount: number, sessionId: number, drawnAt: number[]) => {
    ipcRenderer.send('recorder:done', webm, duration, frameCount, sessionId, drawnAt)
  },
  reportError: (msg: string, sessionId: number) => {
    ipcRenderer.send('recorder:error', msg, sessionId)
  },
  // キャプチャフレームの時刻情報を main へ返す。レコーダーは非表示ウィンドウで
  // console の出口が無いため、計測結果はこの経路でしか取り出せない。
  reportProbe: (info: string) => {
    ipcRenderer.send('recorder:probe', info)
  }
})
