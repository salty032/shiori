// 動画ファイルのサムネ生成・尺取得は ffmpeg（video/ffmpeg.ts、動画機能側）に依存する。
// コアの画像一覧/インポート/共有ハンドラは media_type='video' の行を汎用に扱うため、
// この差し替え可能な provider 経由で呼ぶ（未登録なら失敗として扱われ、
// 呼び出し側の既存 try/catch がそのまま「サムネ/尺なしで保存」に倒す）。
// 未登録になるのは動画機能を落とした構成のとき（main/feature.ts の注記を参照）。
interface VideoThumbProvider {
  extractThumb(videoPath: string, thumbPath: string): Promise<void>
  getVideoMeta(videoPath: string): Promise<{ duration: number | null; fps: number | null }>
}

const unregistered: VideoThumbProvider = {
  extractThumb: async () => { throw new Error('video thumb provider not registered') },
  getVideoMeta: async () => ({ duration: null, fps: null }),
}

let provider: VideoThumbProvider = unregistered

export function setVideoThumbProvider(p: VideoThumbProvider): void {
  provider = p
}

export function getVideoThumbProvider(): VideoThumbProvider {
  return provider
}
