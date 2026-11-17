import { ipcRenderer } from 'electron'
import type { VideoApi } from '../shared/api.video'
import { listen } from './listen'
import { VIDEO_CH } from '../shared/api.video'

// 動画（録画クリップ・トリミング）API。index.ts がコア API と合成して window.api に出す。
export function buildVideoApi(): VideoApi {
  return {
    setClipHotkey: (hotkey) =>
      ipcRenderer.invoke(VIDEO_CH.clipSetHotkey, hotkey),

    getClipFrames: (imageId) =>
      ipcRenderer.invoke(VIDEO_CH.videoGetClipFrames, imageId),

    getTimelineStrip: (imageId, count) =>
      ipcRenderer.invoke(VIDEO_CH.videoGetTimelineStrip, imageId, count),

    trimVideo: (imageId, inSec, outSec, removeAudio) =>
      ipcRenderer.invoke(VIDEO_CH.videoTrim, imageId, inSec, outSec, removeAudio),

    onTrimProgress: (cb) => listen(VIDEO_CH.videoTrimProgress, cb),
  }
}
