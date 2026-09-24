// 録画の供給の診断値。レコーダーウィンドウ（renderer/recorder.ts）が組み立て、
// main（video/capture-diag.ts）が検証して 1 行のログにする。**型の原本はここだけ**
// （以前は両側が別々に持っていて、項目がずれても型検査で気づけなかった）。
/** レコーダーウィンドウが録画中に数えた供給の内訳（recorder.ts が組み立てる） */
export interface CaptureDiag {
  /** rVFC が呼ばれた回数 */
  callbacks: number
  /** 供給側が提示したフレーム数（rVFC の presentedFrames の増分。取れなければ 0） */
  presented: number
  /** 提示されたのに rVFC が呼ばれなかった枚数（presentedFrames の飛びの合計） */
  skippedByCallback: number
  /** 同じ動画フレームの重複提示として供給を見送った回数 */
  duplicateSuppressed: number
  /**
   * captureTime が rVFC のメタデータに載らず Date.now() へ退避した枚数
   * （取れなければ null。診断が無いだけで録画には影響しない）。
   *
   * 素材のコマとの対応付けは「ページがコマを出した時刻」と「こちらが取り込んだ時刻」の差を
   * 一定と見なして補正している。captureTime は取り込み時刻そのものだが、Date.now() は
   * コールバック実行時刻で意味が違う。混ざると「遅延が一定」という前提が崩れるため、
   * 0 か全数かのどちらかであることを確かめる。
   */
  captureTimeMissing: number | null
  /**
   * レコーダーウィンドウの performance 時刻（epoch 換算）と壁時計の差（ミリ秒。取れなければ null）。
   * `logClockDiag` の説明を参照。
   */
  clockSkewMs: number | null
  /** video 要素が受け取ったフレーム総数（getVideoPlaybackQuality。取れなければ null） */
  totalVideoFrames: number | null
  /** そのうち表示に間に合わず捨てられた枚数 */
  droppedVideoFrames: number | null
  /**
   * ティッカー（レコーダーウィンドウの 1x1 canvas）が画面を書き換えた回数。取れなければ null。
   *
   * **供給の天井がどちら側にあるかを切り分けるための実測。** 画面キャプチャは「画面が変化した
   * 回数」で駆動されるので、ここが取得上限（120）前後なのに供給が 51 なら天井はキャプチャ側、
   * ここも 51 前後なら天井は rAF が回っていないこと（＝レコーダーウィンドウ側）。対処が真逆になる。
   */
  tickerTicks: number | null
  /**
   * MediaRecorder に要求した映像ビットレート（bps。取れなければ null）。
   *
   * 供給レートに連動して決めている（recorder.ts）。**要求どおりに出るとは限らない**ので、
   * 判断はファイルから逆算した実効値と並べて行う（logBitrateDiag）。
   */
  videoBitsPerSecond: number | null
  /**
   * 録画開始時に拡張から届いていた素材の fps（届かなければ null）。
   *
   * ビットレートはこの値で「素材のコマ 1 つあたり」に揃えている（recorder.ts）。
   * **要求ビットレートの数字だけでは「素材が 30fps 以下だったから 1 倍」なのか
   * 「値が届かず 1 倍のままだった」のかを区別できない。** 後者はこの経路の典型的な失敗
   * （拡張の再読み込み待ち・非対応サイト・再生直後で未測定）なので、必ず並べて出す。
   */
  bitrateSourceFps: number | null
  /**
   * キャプチャストリームが実際に返したフレームの画素数（取れなければ null）。
   *
   * getDisplayMedia には解像度の制約を付けていないので、Chromium が画面の物理解像度より
   * 小さいストリームを返しても**黙って低解像度で録れる**（クロップ計算が
   * `screenshotDpr = frameW / bounds.width` で吸収してしまうため）。物理解像度と並べて出す。
   *
   * レコーダー側は `<video>` の実寸を送ってくる。`track.getSettings()` は実フレームではなく
   * 公称の最大枠（実測で 1920x1080 の画面に対し 1920x1920）を返すため使えない。
   */
  streamWidth: number | null
  streamHeight: number | null
  /** 実際に記録した画素数（クロップ後）。画質を語るときの母数（logBitrateDiag 参照） */
  cropWidth: number | null
  cropHeight: number | null
}
