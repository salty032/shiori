// 動画（録画クリップ・トリミング）専用の型・チャンネル。ShioriApi へ宣言マージ（declare
// module）で足すのではなく、独立した VideoApi として定義する。宣言マージはコンパイル単位
// 全体で ShioriApi の形を変えてしまい、capture 専用ファイル（preload/index.ts 等）まで
// 動画メソッドを実装するよう要求されてしまう（tsconfig を capture/full で分けない限り）。
// VideoApi を独立させ、参照側（video/ 配下）だけがローカルにキャストして使うことで、
// コア側の型・tsconfig は一切変えずに済む。
export type TrimVideoResult = { ok: true; newId: number } | { ok: false; error: string }

export interface VideoApi {
  setClipHotkey: (hotkey: string) => Promise<boolean>
  getFramePts: (imageId: number) => Promise<number[]>
  getTimelineStrip: (imageId: number, count: number) => Promise<string | null>
  trimVideo: (imageId: number, inSec: number, outSec: number) => Promise<TrimVideoResult>
}

export const VIDEO_CH = {
  clipSetHotkey: 'clip:setHotkey',
  videoGetFramePts: 'video:getFramePts',
  videoGetTimelineStrip: 'video:getTimelineStrip',
  videoTrim: 'video:trim',
} as const
