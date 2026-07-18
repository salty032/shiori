import { contextBridge, ipcRenderer } from 'electron'

// recorder:* はレコーダーウィンドウ専用の別契約（RecorderApi）で、ShioriApi の CH 定数の
// 対象外（main 側の検証も isTrustedRecorderSender と別方式）。意図的に生文字列のまま。
contextBridge.exposeInMainWorld('recorderApi', {
  onStart: (cb: (data: { sourceId: string; fps: number; maxSeconds: number }) => void) => {
    ipcRenderer.on('recorder:start', (_e, data) => cb(data))
  },
  onStop: (cb: () => void) => {
    ipcRenderer.on('recorder:stop', () => cb())
  },
  getCrop: (streamW: number, streamH: number) =>
    ipcRenderer.invoke('recorder:getCrop', streamW, streamH),
  sendDone: (webm: ArrayBuffer, duration: number) => {
    ipcRenderer.send('recorder:done', webm, duration)
  },
  reportError: (msg: string) => {
    ipcRenderer.send('recorder:error', msg)
  }
})
