import type { ShioriApi } from './api'

// 動画（録画クリップ・トリミング）専用の型・チャンネル。ShioriApi へ宣言マージ（declare
// module）で足すのではなく、独立した VideoApi として定義する。宣言マージはコンパイル単位
// 全体で ShioriApi の形を変えてしまい、動画を持たない構成を切り出すときに、コア側の
// ファイルまで動画メソッドの実装を要求されてしまう（tsconfig を分けない限り）。
// 独立させておけば、コア（ShioriApi）の型は動画の有無に関わらず変わらない。
// 実際に公開される形は下の AppApi。
type TrimVideoResult = { ok: true; newId: number } | { ok: false; error: string }

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
  /**
   * 専用の絵が撮れておらず、直前のコマの絵を出している。
   *
   * **前後の絵が同じでも違っても、ここは同じ扱いにする。** 絵が無い以上、そこに何が
   * 入っていたか（1 コマだけ差し込まれたショックコマなど）は決められない。前後が違うと
   * 分かっている方が「確実に外している」だけで、**どちらも保証できない点は同じ**。
   * 検証結果（verified）はデータには残すが、画面では分けない（2026-08-26）。
   */
  reused: 1,
  /**
   * 2 は欠番。かつて「流用だが前後の絵が同一と検証済み＝数え方に影響しない」を灰色で
   * 出していたが、**前後が同じでも間の 1 コマだけ違う（ショックコマ）可能性は、絵が無い
   * 以上どうやっても消えない。** 確定できないことを確定したように見せていたので廃止した
   * （2026-08-26）。verified === 'same' は流用として扱う。
   */
  /** 3 は欠番。かつての「要確認」（流用で前後の絵が違う）は reused に統合した。 */
  /**
   * ファイル内の別のコマを指している疑いがある＝出ている絵が、この素材コマの絵とは限らない。
   *
   * 表全体を捨てる代わりの印（StoredFrame.misaligned）。**流用より重い**——流用は
   * 「絵が無いので直前を出している」と分かっているが、こちらは出ている絵が何なのか分からない。
   */
  misaligned: 4,
} as const
export type FrameQuality = (typeof FRAME_QUALITY)[keyof typeof FRAME_QUALITY]

/** クリップのコマ送りに必要な情報一式。 */
export interface ClipGap {
  /** この添字のコマの「次」に抜けがある */
  afterIndex: number
  /** 抜けているコマ数 */
  missing: number
}

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
  /**
   * 表から抜けている区間（ページがコマを描かず、知らせも来なかったところ）。
   *
   * **撮り逃し（quality の流用）とは別物。** あちらは「コマはあるが専用の絵が無い」だが、
   * こちらは**表に行すら無い**ので、コマ送りするとその区間がまるごと飛ぶ。枚数にも割合にも
   * 現れないため、画面に出さないと気づけない（実害はこちらの方が大きい）。
   *
   * afterIndex は pts の添字で、「そのコマの次に missing コマぶん抜けている」を表す。
   * sourceBased が false のときは空（素材のコマ単位でないので抜けを数えられない）。
   */
  gaps?: ClipGap[]
}

export interface VideoApi {
  setClipHotkey: (hotkey: string) => Promise<boolean>
  getClipFrames: (imageId: number) => Promise<ClipFrames>
  getTimelineStrip: (imageId: number, count: number) => Promise<string | null>
  trimVideo: (imageId: number, inSec: number, outSec: number) => Promise<TrimVideoResult>
}

/**
 * preload が実際に window.api として公開する形。
 *
 * VideoApi を ShioriApi へ宣言マージしない（上のコメント）代わりに、**合成した型に名前を
 * 付けてここへ置く**。renderer 側のグローバル宣言・preload の実装・video/ からの参照が
 * すべてこの 1 つを見るので、動画メソッドを preload から落とせば renderer のコンパイルが
 * 落ちる。以前は renderer 側のグローバルが ShioriApi のみで、video/ が
 * `as unknown as ShioriApi & VideoApi` で迂回していたため、preload から動画 API が
 * 消えても型検査は素通りしていた（実行時に undefined になって初めて分かる）。
 *
 * 動画機能を持たない構成をビルドするなら、そちら専用の tsconfig と
 * エントリポイントで window.api を ShioriApi のみに宣言し直すこと。
 */
export type AppApi = ShioriApi & VideoApi

export const VIDEO_CH = {
  clipSetHotkey: 'clip:setHotkey',
  videoGetClipFrames: 'video:getClipFrames',
  videoGetTimelineStrip: 'video:getTimelineStrip',
  videoTrim: 'video:trim',
} as const
