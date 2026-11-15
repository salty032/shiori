import { ipcRenderer } from 'electron'

// main からの通知を受ける。戻り値を呼ぶと受け取りをやめる。
// 型は呼ぶ側の callback（ShioriApi / VideoApi の型）から決まる。
export function listen<T>(channel: string, callback: (data: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, data: T): void => callback(data)
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.off(channel, listener) }
}
