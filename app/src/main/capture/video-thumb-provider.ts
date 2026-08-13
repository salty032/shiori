// 動画ファイルのサムネ生成・尺取得は ffmpeg（video/ffmpeg.ts、動画機能側）に依存する。
// コアの画像一覧/インポート/共有ハンドラは media_type='video' の行を汎用に扱うため、
// この差し替え可能な provider 経由で呼ぶ（未登録＝capture 版では失敗として扱われ、
// 呼び出し側の既存 try/catch がそのまま「サムネ/尺なしで保存」に倒す）。
interface VideoThumbProvider {
  extractThumb(videoPath: string, thumbPath: string): Promise<void>
  getVideoMeta(videoPath: string): Promise<{ duration: number | null; fps: number | null }>
  // 実フレーム数を数える（フルデコード）。自前録画は可変フレームレートで、ffmpeg の
  // -i だけの軽い解析（getVideoMeta）ではコンテナに fps 表記自体が無く取れないことが
  // 多い（ipc-images.ts の backfillFps 参照）。既存クリップへの fps 遡及埋めでのみ使う、
  // コストの高い経路。
  countFrames(videoPath: string): Promise<number>
}

const unregistered: VideoThumbProvider = {
  extractThumb: async () => { throw new Error('video thumb provider not registered') },
  getVideoMeta: async () => ({ duration: null, fps: null }),
  countFrames: async () => { throw new Error('video thumb provider not registered') },
}

let provider: VideoThumbProvider = unregistered

export function setVideoThumbProvider(p: VideoThumbProvider): void {
  provider = p
}

export function getVideoThumbProvider(): VideoThumbProvider {
  return provider
}
