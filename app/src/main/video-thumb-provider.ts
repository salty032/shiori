// 動画のサムネイル生成・尺取得には対応していない。コアの画像一覧/インポート/共有
// ハンドラは media_type='video' の行を汎用に扱うため、呼び出し側の既存 try/catch が
// そのまま「サムネ/尺なしで保存」に倒せるよう、常に失敗を返す provider を経由して呼ぶ。
export interface VideoThumbProvider {
  extractThumb(videoPath: string, thumbPath: string): Promise<void>
  getVideoDuration(videoPath: string): Promise<number | null>
}

const unregistered: VideoThumbProvider = {
  extractThumb: async () => { throw new Error('video thumb provider not registered') },
  getVideoDuration: async () => null,
}

export function getVideoThumbProvider(): VideoThumbProvider {
  return unregistered
}
