// 動画ファイルのサムネ生成・尺取得は ffmpeg（video/ffmpeg.ts、動画機能側）に依存する。
// コアの画像一覧/インポート/共有ハンドラは media_type='video' の行を汎用に扱うため、
// この差し替え可能な provider 経由で呼ぶ（未登録＝capture 版では失敗として扱われ、
// 呼び出し側の既存 try/catch がそのまま「サムネ/尺なしで保存」に倒す）。
export interface VideoThumbProvider {
  extractThumb(videoPath: string, thumbPath: string): Promise<void>
  getVideoDuration(videoPath: string): Promise<number | null>
}

const unregistered: VideoThumbProvider = {
  extractThumb: async () => { throw new Error('video thumb provider not registered') },
  getVideoDuration: async () => null,
}

let provider: VideoThumbProvider = unregistered

export function setVideoThumbProvider(p: VideoThumbProvider): void {
  provider = p
}

export function getVideoThumbProvider(): VideoThumbProvider {
  return provider
}
