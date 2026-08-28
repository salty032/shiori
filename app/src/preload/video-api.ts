import { ipcRenderer } from 'electron'
import type { VideoApi, ClipFrames, TrimProgress } from '../shared/api.video'
import { VIDEO_CH } from '../shared/api.video'

// 動画（録画クリップ・トリミング）API。index.ts がコア API と合成して window.api に出す。
export function buildVideoApi(): VideoApi {
  return {
    setClipHotkey: (hotkey: string): Promise<boolean> =>
      ipcRenderer.invoke(VIDEO_CH.clipSetHotkey, hotkey),

    getClipFrames: (imageId: number): Promise<ClipFrames> =>
      ipcRenderer.invoke(VIDEO_CH.videoGetClipFrames, imageId),

    getTimelineStrip: (imageId: number, count: number): Promise<string | null> =>
      ipcRenderer.invoke(VIDEO_CH.videoGetTimelineStrip, imageId, count),

    trimVideo: (imageId: number, inSec: number, outSec: number) =>
      ipcRenderer.invoke(VIDEO_CH.videoTrim, imageId, inSec, outSec),

    onTrimProgress: (cb: (progress: TrimProgress) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, progress: TrimProgress): void => cb(progress)
      ipcRenderer.on(VIDEO_CH.videoTrimProgress, listener)
      return () => { ipcRenderer.off(VIDEO_CH.videoTrimProgress, listener) }
    },
  }
}
