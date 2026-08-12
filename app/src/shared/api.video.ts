// 動画（録画クリップ・トリミング）専用の型・チャンネル。ShioriApi へ宣言マージ（declare
// module）で足すのではなく、独立した VideoApi として定義する。宣言マージはコンパイル単位
// 全体で ShioriApi の形を変えてしまい、capture 専用ファイル（preload/index.ts 等）まで
// 動画メソッドを実装するよう要求されてしまう（tsconfig を capture/full で分けない限り）。
// VideoApi を独立させ、参照側（video/ 配下）だけがローカルにキャストして使うことで、
// コア側の型・tsconfig は一切変えずに済む。
export type TrimVideoResult = { ok: true; newId: number } | { ok: false; error: string }

/**
 * コマ 1 つの確からしさ。素材のコマ表（video_frames）がある録画クリップにだけ付く。
 *
 * **コマ送りで絵が変わらないこと自体が測定結果**（アニメのコマ打ち）なので、変わらなかった
 * 理由が「素材がその絵を保持していた」のか「こちらが撮り逃して直前の絵を流用している」のか
 * を画面で区別できないと、黙って誤らせる。枚数の合計は詳細パネルに出しているが、合計だけでは
 * 「どこかに N コマ嘘がある」としか言えないため、コマ単位でも持ち回る。
 *
 * 数値コードで持つのは 1 クリップで千数百要素になるため（DB の encodeFrames と同じ判断）。
 */
export const FRAME_QUALITY = {
  /** そのコマ専用の絵を撮れている */
  captured: 0,
  /** 専用の絵が無く直前のコマの絵を流用している（未検証） */
  reused: 1,
  /** 流用だが、前後の絵が同一と検証済み＝コマ打ちの数え方には影響しない */
  reusedSame: 2,
  /** 流用で、前後の絵が変わっている＝どのコマで変わったかは特定できない */
  reusedChanged: 3,
} as const
export type FrameQuality = (typeof FRAME_QUALITY)[keyof typeof FRAME_QUALITY]

/** クリップのコマ送りに必要な情報一式。 */
export interface ClipFrames {
  /** 1 コマずつの時刻（秒・非減少）。撮り逃したコマは直前と同じ値になる */
  pts: number[]
  /**
   * 素材のコマ表に基づくか。
   *
   * true なら 1 要素＝素材の 1 コマ。false は退避経路で、ファイルに記録されたフレームを
   * そのまま並べたもの（取り込み動画では素材のコマと一致するが、録画クリップでは画面
   * キャプチャの供給レートの産物であり素材のコマとは対応しない）。
   */
  sourceBased: boolean
  /** pts と同じ長さ。sourceBased が false のときは空（コマ単位の確からしさが分からない） */
  quality: FrameQuality[]
}

export interface VideoApi {
  setClipHotkey: (hotkey: string) => Promise<boolean>
  getClipFrames: (imageId: number) => Promise<ClipFrames>
  getTimelineStrip: (imageId: number, count: number) => Promise<string | null>
  trimVideo: (imageId: number, inSec: number, outSec: number) => Promise<TrimVideoResult>
}

export const VIDEO_CH = {
  clipSetHotkey: 'clip:setHotkey',
  videoGetClipFrames: 'video:getClipFrames',
  videoGetTimelineStrip: 'video:getTimelineStrip',
  videoTrim: 'video:trim',
} as const
