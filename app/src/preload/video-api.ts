import { ipcRenderer } from 'electron'
import type { VideoApi } from '../shared/api.video'
import { VIDEO_CH } from '../shared/api.video'

// full 版のみが追加する動画（録画クリップ・トリミング）API。
export function buildVideoApi(): VideoApi {
  return {
    setClipHotkey: (hotkey: string): Promise<boolean> =>
      ipcRenderer.invoke(VIDEO_CH.clipSetHotkey, hotkey),

    getFramePts: (imageId: number): Promise<number[]> =>
      ipcRenderer.invoke(VIDEO_CH.videoGetFramePts, imageId),

    getTimelineStrip: (imageId: number, count: number): Promise<string | null> =>
      ipcRenderer.invoke(VIDEO_CH.videoGetTimelineStrip, imageId, count),

    trimVideo: (imageId: number, inSec: number, outSec: number) =>
      ipcRenderer.invoke(VIDEO_CH.videoTrim, imageId, inSec, outSec),
  }
}
