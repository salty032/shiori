// 配信ページから届く「素材の1コマ」通知の受け口。
//
// 録画クリップのコマ送りを素材の実コマと一致させるための土台。画面キャプチャ側の
// rVFC はコンポジタ駆動なので素材のコマとは無関係な枚数が出るが（実測: 23.976fps の
// 素材から 36.9fps 分のフレームが記録されていた）、配信ページの video の rVFC は
// 素材のコマごとにちょうど1回だけ発火する。その通知をここへ集約する。
//
// 通知は届くまでに数十〜数百ms 遅れることがあるため、リアルタイムでフレーム供給を
// 駆動するのではなく、録画後に時刻で突き合わせる。displayAt はコマが画面に出た瞬間に
// ページ側で刻まれるので、通知が遅れても値は正しいまま残る。
import { onExtensionMessage } from '../browser/ws-server'

export interface SourceFrame {
  /** 素材自身のタイムライン上の時刻（秒）。素材のコマを一意に識別する */
  mediaTime: number
  /** そのコマが画面に出る時刻（epoch ミリ秒）。配信ページ側の時計 */
  displayAt: number
  /** main が通知を受け取った時刻（epoch ミリ秒）。遅延の測定に使う */
  receivedAt: number
  /**
   * 合成へ送られたコマの累積数（rVFC の presentedFrames）。返さない環境では null。
   *
   * **通知が飛んでも、この値は飛んだぶんだけ増えている。** 前後の差から 1 を引けば、
   * 通知が来なかったコマ数が実数で出る（frameGaps）。従来の「時刻の差 ÷ 間隔の中央値」は
   * **欠けた区間の刻みが残っている区間と同じ**という仮定に乗っており、欠けたコマからは
   * 検算できない。1 枚違うだけで、その下のコマ番号が全部ずれる。
   */
  presentedFrames?: number | null
}

// 60秒 × 60fps に、通知の重複や高フレームレート素材ぶんの余裕を持たせた上限。
// 際限なく溜めると、録画が異常終了して stop が呼ばれないままメモリを食い続ける。
const MAX_FRAMES = 8000

let collecting = false
let frames: SourceFrame[] = []
let unsubscribe: (() => void) | null = null
// 上限に達したことを1録画につき1回だけ知らせるための印。
let capReported = false
// 録画中にコマ通知が途切れた回数（ページ側の rVFC ループが止まった回数）。
let reportGaps = 0

export function startFrameFeed(): void {
  stopFrameFeed()
  collecting = true
  frames = []
  capReported = false
  reportGaps = 0
  unsubscribe = onExtensionMessage((msg) => {
    if (!collecting) return
    if (msg.type === 'frame-gap') {
      reportGaps++
      return
    }
    if (msg.type !== 'frame') return
    if (frames.length >= MAX_FRAMES) {
      // 上限に達したら以降のコマは表に入らず、フレーム表が録画の途中で終わる。
      // 黙って捨てると「後半だけコマ送りが素材と合わない」という説明の付かない状態になるので、
      // 1回だけ知らせる（毎フレーム出すとログが埋まる）。
      if (!capReported) {
        capReported = true
        console.warn(
          `[frame-feed] source frame reports hit the cap (${MAX_FRAMES}).` +
          ' Later frames are dropped and the frame table will end before the recording does.'
        )
      }
      return
    }
    frames.push({
      mediaTime: msg.mediaTime, displayAt: msg.displayAt, receivedAt: Date.now(),
      presentedFrames: msg.presentedFrames
    })
  })
}

export function stopFrameFeed(): void {
  collecting = false
  unsubscribe?.()
  unsubscribe = null
}

export interface FrameMatch {
  /** 素材のコマの時刻（秒）。動画時刻の表示とコマの同定に使う */
  mediaTime: number
  /** そのコマが写っている、録画ファイル内のフレーム番号（0 始まり） */
  frameIndex: number
  /**
   * そのコマの表示区間内に実際に画面を撮れていたか。
   *
   * false は「このコマ専用の絵が無く、直前のコマの絵を流用している」ことを意味する。
   * 画面キャプチャの供給（実測 35〜41枚/秒）が素材の 2 倍に届かないため、
   * 24fps 素材でも数 % のコマでこれが起きる。同じ絵が続く 2 コマ打ちの区間なら実害は
   * 無いが、絵が変わる境目に当たるとコマ打ちの数を誤る。黙って間違えるのが最悪なので
   * フラグとして残し、ユーザーに見せる。
   */
  captured: boolean
  /**
   * 合成へ送られたコマの累積数（SourceFrame.presentedFrames を重複ぶん詰め直した値）。
   * 返さない環境・旧版の拡張では null。**表に保存して、読み出し後も抜けの枚数を実数で
   * 数え直せるようにする**（db-video-frames の encodeFrames）。
   */
  presentedFrames?: number | null
}

/**
 * キャプチャ経路の実遅延（ミリ秒）。**探索の窓を置く中心。**
 *
 * ページが素材のコマを画面に出してから、画面キャプチャがその絵を取り込むまでの時間。
 * **録画ごとに探索して当てにいくものではなく、実測して固定する定数**
 * （理由は docs/ANIME-FRAMES.md 2章。スコアは素材の周期について周期的なので、
 * 何コマぶんずれているかは探索では原理的に決まらない）。
 *
 * 2026-08-10 の実測 4 本（位相が決まっていたものだけ）で 14 / 16.1 / 19.1 / 28.7ms。
 * 中央は約 17ms。ページ側とレコーダー側の時計は 5ms 以内で一致していることを確認済みなので
 * （`[clock-base]`）、これは時計のずれではなく物理的な遅延そのもので、60Hz の 1〜2 リフレッシュ分
 * という説明もつく。
 *
 * **いちばん確かなのは 60fps 素材の 14ms**。60fps は素材 1 コマ(16.7ms)が供給間隔(17.6ms)より
 * 短いため絵の入らないコマが大量に出て、その凸凹で同点が 1 点まで絞れる（実測 `candidates 1`）。
 * しかも 1 コマずらした位置とのスコア差が 4〜18 と初めて明確に付いた＝**この経路で唯一、真の
 * 遅延そのものが測れる条件**。逆に 24fps は供給が足りて全域が同点になり、位相の測定には使えない。
 *
 * **この値が素材 1 コマ以上外れていると、全クリップが黙って一律にずれる。**
 * 変えるときは `[frame-match]` の余りを、飽和していない録画（`candidates` が狭いもの）で
 * 複数本集めてからにすること。
 */
const CAPTURE_LATENCY_MS = 17

export interface MatchResult {
  matches: FrameMatch[]
  /** 自分の表示区間内に絵を撮れていたコマの割合。1.0 ならコマ送り1回で必ず絵が変わる */
  capturedRatio: number
  /** 採用した固定オフセット（ミリ秒）。キャプチャ経路の一定遅延ぶん */
  offsetMs: number
  sourceFrames: number
  drawnFrames: number
  /** 同じコマの重複通知として畳んだ数 */
  duplicateReports: number
  /** 録画の範囲外だったため表から外したコマ数 */
  outsideRecording: number
  /**
   * 最高スコアと同点だったオフセットの数。1 なら一意に決まっている。
   *
   * スコア（撮れたコマ数）は供給が足りていると飽和する。素材のコマ間隔より供給間隔が
   * 十分に短ければ、オフセットをどこに振っても隣接コマは別のフレームを指すため、
   * 広い範囲が満点になる。そうなると採用値は「最も良かった値」ではなく
   * 「最初に見つかった値」でしかなく、真の遅延との差だけ全コマが一様にずれる。
   * 黙って通さないために数を持ち帰る。
   */
  tiedOffsets: number
  /** 同点だったオフセットの最小・最大（ミリ秒）。連続しているとは限らない */
  tiedRangeMs: [number, number]
  /** 素材のコマ周期（ミリ秒）。ずれが何コマ分に当たるかの換算に使う */
  sourcePeriodMs: number
  /**
   * 通知そのものが来なかった素材コマの数（コマ周期の格子に空いた穴）。
   *
   * **撮り逃し（captured=false）とは別物で、こちらの方が悪い。** 撮り逃しは「コマはあったが
   * 専用の絵が無い」で枚数にも割合にも出るが、通知が来なかったコマは**表に入らないので
   * どの数字の分母にも入らない**。放っておくと `captured 89.3%` と出ている裏で、実際には
   * 素材の 2 割が対応表に存在しない、という状態を黙って通すことになる。
   *
   * 実測（2026-08-12・60fps 素材）：769 コマの表に対し通知の欠けが約 197。ページ側が 60 コマ
   * 全部を描けていないのが疑わしいが、原因は未確定。24/30fps では 0 だった。
   */
  reportDrops: number
  /** 探索した窓（ミリ秒）。幅はちょうど素材 1 コマ（CAPTURE_LATENCY_MS 参照） */
  searchRangeMs: [number, number]
  /** 素材コマ n 個ぶんずらした位置のスコア（OffsetReplica 参照） */
  replicas: OffsetReplica[]
}

/**
 * 素材のコマ 1 つぶん（周期 P）ずらしたオフセットでの探索スコア。
 *
 * **このスコア関数は P について周期的で、「何コマぶんずれているか」を原理的に区別できない。**
 * オフセットを P だけ足すと、比較対象の時刻集合 `{displayAt_k + offset + P}` は
 * `{displayAt_{k+1} + offset}` とほぼ一致する（displayAt は vsync 格子上でほぼ等間隔）。
 * つまり `captured` の列が添字 1 つぶん平行移動するだけで、スコアが変わるのは端の数コマしかない。
 * 一方フレーム表の中身は素材コマ 1 つぶん丸ごとずれる。**最も知りたいずれに対してだけ盲目。**
 *
 * `tiedOffsets`（隣接する同点の数）ではこの構造は見えない。複製どうしは谷を挟んだ別の山なので、
 * 同点は狭いまま「一意に決まった」ように見える（実測で candidates 3〜5・幅 2〜6ms と出ていた）。
 * 採用値と ±1〜2 コマ先のスコア差を持ち帰り、決まっていないなら必ず知らせる。
 * 詳細は docs/ANIME-FRAMES.md 2章。
 */
interface OffsetReplica {
  /** ずらした素材コマ数（-2..+2。0＝採用値そのものは含めない） */
  shift: number
  /** その近傍で最もスコアが高かったオフセット（ミリ秒） */
  offsetMs: number
  /** 採用値のスコアとの差（コマ数）。小さいほど採用値と区別が付いていない */
  scoreDelta: number
}

// 複製の頂点を探す窓幅（ミリ秒）。displayAt は完全な等間隔ではなく、vsync 格子と素材周期の
// ドリフトを 3 vsync 分の区間で吸収する箇所があるため、頂点はちょうど P の整数倍から数 ms ずれる。
const REPLICA_WINDOW_MS = 3

/**
 * コマ通知が main へ届くまでの遅れ（`receivedAt - displayAt`）の要約。
 *
 * **オフセットが負に出る理由を切り分けるための実測。** `displayAt` は配信ページ（Chrome）の
 * `performance.timeOrigin + expectedDisplayTime`、`drawnAt` はレコーダー（Electron）の
 * `performance.timeOrigin + captureTime` で、**別プロセスの単調時計を各々の epoch へ直した値**。
 * 各 timeOrigin は文書の生成時刻で固定される一方、その後 now() は単調時計で進むため、
 * 壁時計（`Date.now()`）との差は文書の寿命ぶん開きうる。この差が両者で違えば、その差はそのまま
 * `offsetMs` に乗る——録画ごとにオフセットが振れる理由の候補。
 *
 * `receivedAt` は main の `Date.now()` なので、この値は「転送の遅れ − ページ側の時計のずれ」。
 * 転送の遅れは 0 以上なので、**最小値が負に大きく振れていればページ側の時計がずれている証拠**に
 * なる（`expectedDisplayTime` が未来を指すぶんは 1〜2 vsync ＝ 16〜33ms までしか説明できない）。
 */
export interface ReportDelay {
  /** 標本数（重複通知を畳んだ後） */
  count: number
  /** `receivedAt - displayAt` の最小値（ミリ秒） */
  minMs: number
  /** 同・中央値（ミリ秒） */
  medianMs: number
}

// 重複通知を畳んだコマ列から通知の遅れを要約する（ReportDelay 参照）。
export function summarizeReportDelay(source: SourceFrame[]): ReportDelay | null {
  const delays: number[] = []
  let prevMediaTime: number | null = null
  for (const f of source) {
    if (prevMediaTime === f.mediaTime) continue
    prevMediaTime = f.mediaTime
    if (Number.isFinite(f.receivedAt) && Number.isFinite(f.displayAt)) delays.push(f.receivedAt - f.displayAt)
  }
  if (delays.length === 0) return null
  const sorted = [...delays].sort((a, b) => a - b)
  return { count: sorted.length, minMs: sorted[0], medianMs: sorted[sorted.length >> 1] }
}

// 素材のコマと、録画ファイル内のフレームを対応付ける。
//
// 素材のコマは 41.7ms ごと、こちらの撮影は 16.7ms ごと（2.5倍のオーバーサンプリング）
// なので、素材の1コマにつき撮影フレームは2〜3枚ある。その中から1枚を選ぶ。
//
// 選び方は「そのコマが画面に出た時刻(displayAt)以降に撮られた最初のフレーム」。
// キャプチャ経路には一定の遅延があるため displayAt をそのまま使うと1コマ手前を掴むが、
// この遅延は一定なので、全体が最もきれいに1対1へ収まるオフセットを探して補正する
// （offsetMs）。一定のずれは全コマが等しくずれるだけでコマ打ちの数え方を壊さない。
export function matchFrames(source: SourceFrame[], drawnAt: number[]): MatchResult | null {
  if (source.length === 0 || drawnAt.length === 0) return null

  // 同じ素材コマが2回以上通知されることがある（コンポジタが同じフレームを再提示すると
  // ページ側の rVFC がもう一度発火する）。mediaTime が同じなら同じコマなので、最初の通知
  // ——実際に画面へ出た時刻——だけを残す。
  //
  // 畳まないと2つ目は必ず「専用の絵が無い」と判定される。1つ目が絵を確保した直後なので、
  // 次に別の絵が来るまで同じフレームを指すため。撮り逃しでも何でもないのに枚数を水増しする。
  // 録画側は同じ理由で既に重複を潰しており（recorder.ts の lastDrawnMediaTime）、
  // 素材側だけ潰していなかった。
  //
  // **presentedFrames はここで詰め直す。** あの値は「合成へ送られた回数」なので、同じコマの
  // 再提示でも増える。畳んだ後の隣り合うコマで差を取ると、再提示のぶんだけ「通知が来なかった
  // コマ」に見えてしまう——**抜けを水増しし、灰色の行を増やす方向の誤り**で、コマ番号が
  // 後ろへずれる。ここまでに落とした重複の数を引いておけば、差は「別のコマが何枚送られたか」
  // になる。
  const frames: SourceFrame[] = []
  let duplicateReports = 0
  for (const f of source) {
    const prev = frames[frames.length - 1]
    if (prev && prev.mediaTime === f.mediaTime) {
      duplicateReports++
      continue
    }
    frames.push(
      f.presentedFrames == null ? f : { ...f, presentedFrames: f.presentedFrames - duplicateReports }
    )
  }

  const pick = (offsetMs: number): FrameMatch[] => {
    const idx: number[] = []
    let i = 0
    for (const f of frames) {
      const target = f.displayAt + offsetMs
      while (i + 1 < drawnAt.length && drawnAt[i] < target) i++
      idx.push(i)
    }
    // 「自分の表示区間内に撮れたか」は、次のコマが別のフレームを指したかで決まる。
    //
    // 選ばれるのは常に「その時刻以降の最初のフレーム」なので、次のコマが別のものを
    // 選んだということは、自分のフレームが次のコマの開始より前＝自分の区間内に
    // 撮られていたことを意味する。同じものを選んだなら、そのフレームは自分の区間より
    // 後ろにあり、自分専用の絵が無かったということになる。
    //
    // 時刻の大小で直接判定すると、撮影がちょうど区間の境目に乗ったときに浮動小数点の
    // 誤差で結果が揺れる。添字の比較なら厳密に決まる。
    const out = idx.map((frameIndex, k) => ({
      mediaTime: frames[k].mediaTime,
      frameIndex,
      captured: k + 1 < idx.length ? idx[k + 1] !== frameIndex : frameIndex !== idx[k - 1],
      presentedFrames: frames[k].presentedFrames
    }))
    // 自分の区間に絵が無かったコマは、そのままだと「次のコマの絵」を指してしまう
    // （選び方が「その時刻以降の最初のフレーム」なので、区間を跨いだ先を掴む）。
    // 未来の絵を出すのは明確に誤りなので、直前の絵を引き継ぐ。素材が同じ絵を
    // 保持していた区間ならこれが正解になり、変わっていた場合も「変化を撮り逃した」
    // という素直な表現になる。
    for (let k = 1; k < out.length; k++) {
      if (!out[k].captured) out[k].frameIndex = out[k - 1].frameIndex
    }
    return out
  }

  // 素材のコマ周期。複製の位置（OffsetReplica）と録画範囲の判定の両方で使う。
  // drops（格子に空いた穴＝通知が来なかったコマ）も同じ当てはめから出る。捨てずに持ち帰る。
  const grid = fitGrid(frames.map((f) => f.mediaTime))
  const periodMs = grid?.periodMs ?? 1000 / 24
  const reportDrops = grid?.drops ?? 0

  const scoreAt = (offsetMs: number): number =>
    pick(offsetMs).reduce((n, x) => n + (x.captured ? 1 : 0), 0)

  // 探索の窓は「実測した遅延 ± 素材コマの半分」＝**幅ちょうど素材 1 コマ**。
  //
  // これより広げてはいけない。スコアは素材の周期について周期的なので、窓が 1 コマより広いと
  // 同じ位相の複製が複数入り、**どれを引くかが端の数コマの差（＝雑音）で決まってしまう**。
  // 実測では 447 コマ中 0 コマの差で選ばれ、録画ごとに -38〜-90ms と 1 コマ以上振れていた。
  // 幅を 1 コマに閉じれば複製は 1 つしか入らず、**何コマぶんずれるかは定数（物理）が決め、
  // 探索は 1 コマ内のどこか（位相）だけを決める**という役割分担になる。docs/ANIME-FRAMES.md 2章。
  const searchLo = Math.round(CAPTURE_LATENCY_MS - periodMs / 2)
  const searchHi = searchLo + Math.max(1, Math.round(periodMs)) - 1

  let bestScore = -1
  // 最高スコアで並んだオフセット（MatchResult.tiedOffsets 参照）。
  let tied: number[] = []
  for (let offset = searchLo; offset <= searchHi; offset++) {
    const score = scoreAt(offset)
    if (score > bestScore) {
      bestScore = score
      tied = [offset]
    } else if (score === bestScore) {
      tied.push(offset)
    }
  }
  if (tied.length === 0) return null

  // 同点なら**その中央**を採る。以前は「最初に当たった値」＝窓の左端を採っていたため、
  // 飽和した録画では位相が systematically 左へ寄っていた。中央なら真の位相との差は
  // 同点の幅の半分に収まる。
  const offsetMs = tied[tied.length >> 1]
  const picked = pick(offsetMs)

  // 採用値から素材コマ n 個ぶん離れた位置のスコア（OffsetReplica 参照）。**窓の外側を見る**。
  // 判定には使わない——ここが採用値と並ぶのは構造的に当たり前で、だからこそコマ単位のずれを
  // 定数で決めている。同じ検証を何度もやり直さないための証拠としてログに残す。
  const replicas: OffsetReplica[] = []
  for (const shift of [-2, -1, 1, 2]) {
    const center = offsetMs + shift * periodMs
    let peak = { offsetMs: Math.round(center), score: -1 }
    for (let o = Math.ceil(center - REPLICA_WINDOW_MS); o <= Math.floor(center + REPLICA_WINDOW_MS); o++) {
      const score = scoreAt(o)
      if (score > peak.score) peak = { offsetMs: o, score }
    }
    replicas.push({ shift, offsetMs: peak.offsetMs, scoreDelta: bestScore - peak.score })
  }

  // 録画の範囲外にはみ出したコマを外す。
  //
  // コマ通知の受け口は録画開始より前に立ち上げ（最初の数コマを取りこぼさないため）、
  // 停止処理が終わるまで生きている。その間に届くコマは、録画されていない時間帯のものなので
  // 当然どのフレームにも写っていない。表に残すと「撮り逃した」と数えられてしまうが、
  // 撮り逃したのではなく最初から録画の外なので、表からも枚数からも外すのが正しい。
  //
  // 判定はコマの表示区間（自分の displayAt から次のコマの displayAt まで）が、実際に
  // 撮れている時間帯と少しでも重なるか。末尾のコマだけは次が無いので周期ぶんとみなす。
  const firstDrawn = drawnAt[0]
  const lastDrawn = drawnAt[drawnAt.length - 1]
  const matches: FrameMatch[] = []
  let outsideRecording = 0
  let captured = 0
  for (let k = 0; k < frames.length; k++) {
    const start = frames[k].displayAt + offsetMs
    const end = k + 1 < frames.length ? frames[k + 1].displayAt + offsetMs : start + periodMs
    if (end <= firstDrawn || start > lastDrawn) {
      outsideRecording++
      continue
    }
    matches.push(picked[k])
    if (picked[k].captured) captured++
  }
  if (matches.length === 0) return null

  return {
    matches,
    capturedRatio: captured / matches.length,
    offsetMs,
    sourceFrames: matches.length,
    drawnFrames: drawnAt.length,
    duplicateReports,
    outsideRecording,
    tiedOffsets: tied.length,
    tiedRangeMs: [tied[0], tied[tied.length - 1]],
    sourcePeriodMs: periodMs,
    searchRangeMs: [searchLo, searchHi],
    replicas,
    reportDrops
  }
}

// 素材のコマ周期を最小二乗で推定する。
// mediaTime を 1ms 単位に丸めて返すサービスがあるため（YouTube で確認）、間隔の中央値を
// 周期とみなすと真の値（41.708ms に対し中央値 42ms）とずれ、コマ数を重ねるほど誤差が
// 積もる。仮周期で通し番号を振ってから直線に当てはめれば、丸めがあっても復元できる。
function fitGrid(mediaTimes: number[]): { periodMs: number; residualRmsMs: number; drops: number } | null {
  if (mediaTimes.length < 20) return null
  const diffs: number[] = []
  for (let i = 1; i < mediaTimes.length; i++) diffs.push(mediaTimes[i] - mediaTimes[i - 1])
  const median = [...diffs].sort((a, b) => a - b)[diffs.length >> 1]
  if (!(median > 0)) return null

  const n: number[] = [0]
  for (const d of diffs) n.push(n[n.length - 1] + Math.max(1, Math.round(d / median)))

  const N = mediaTimes.length
  let sn = 0, st = 0, snn = 0, snt = 0
  for (let i = 0; i < N; i++) { sn += n[i]; st += mediaTimes[i]; snn += n[i] * n[i]; snt += n[i] * mediaTimes[i] }
  const denom = N * snn - sn * sn
  if (denom === 0) return null
  const period = (N * snt - sn * st) / denom
  const base = (st - period * sn) / N

  let ss = 0
  for (let i = 0; i < N; i++) { const e = mediaTimes[i] - (period * n[i] + base); ss += e * e }
  return {
    periodMs: period * 1000,
    residualRmsMs: Math.sqrt(ss / N) * 1000,
    drops: n[n.length - 1] + 1 - N
  }
}

/** 表から抜けている区間。afterIndex のコマの「次」に missing コマぶん無い */
export interface FrameGap {
  afterIndex: number
  missing: number
  /**
   * 枚数が実測で裏付けられたか。
   *
   * true は「presentedFrames の差（合成へ送られた枚数）と、時刻から出した推定が一致した」。
   * false は推定だけ——**返さない環境、旧版の拡張で撮ったクリップ、そして「ブラウザが
   * そもそも描かなかった」場合**が含まれる。最後のものは presentedFrames にも入らないので、
   * 枚数は時刻からの推定に頼るしかない。
   *
   * **この違いは画面に出す。** 枚数が 1 違うと、そこから下のコマ番号が全部ずれる
   * （タイムシートは通し番号を記録している）。推定を確定として出すと、黙って誤らせる。
   */
  measured: boolean
}

/** frameGaps の入力。コマ表（StoredFrame）と録画直後の突き合わせ結果の両方が満たす形。 */
export interface GapSample {
  mediaTime: number
  presentedFrames?: number | null
}

// 表に入っているコマ列から、通知が来なかった区間を拾う。
//
// **抜けの「場所」と「合計」は必ずここから出す。** 以前は詳細パネルが fps × 尺 から
// 見積もり、同じ事実にログ 98 コマ／画面 85 コマと 2 つの数字が出ていた。それを潰した後も、
// 場所（コマ送りの表示）と合計（詳細パネル）が別々の計算で出ており、実測 82 本のうち
// 5 本で数字が食い違っていた（2026-08-26）。**同じことを 2 通りに数えない。**
//
// 周期は間隔の中央値。fitGrid の最小二乗は 20 コマ未満で使えず、実際に短いクリップ 4 本で
// 「抜けが無い」ことになっていた。抜けの判定は round(間隔/周期) の丸めしか使わないので、
// 中央値でも結果は変わらない（fitGrid も通し番号は中央値で振っている）。
// **presentedFrames があれば、そちらで裏を取る。**
//
// 時刻からの推定（round(間隔/周期)）は「欠けた区間の刻みは残っている区間と同じ」という
// 仮定に乗っていて、欠けたコマからは検算できない。一方 presentedFrames は合成へ送られた
// コマの累積数なので、通知が飛んでも飛んだぶん増えている。差から 1 を引けば、
// **通知だけが落ちたコマ数が実数で出る。**
//
// ただし **presentedFrames が拾えるのは「画面に出たのに通知が来なかった」ぶんだけ**。
// ブラウザがそもそも合成へ送らなかったコマはこちらにも入らないので、推定の方が大きくなる。
// そこで採る枚数は 2 つの大きい方——**少なく入れると、その下のコマ番号が全部ずれる**ため、
// 足りない側へ倒さない。裏が取れた（両者が一致した）ときだけ measured を立てる。
export function frameGaps(samples: readonly GapSample[]): FrameGap[] {
  if (samples.length < 3) return []
  const diffs: number[] = []
  for (let i = 1; i < samples.length; i++) diffs.push(samples[i].mediaTime - samples[i - 1].mediaTime)
  const median = [...diffs].sort((a, b) => a - b)[diffs.length >> 1]
  if (!(median > 0)) return []
  const gaps: FrameGap[] = []
  for (let i = 0; i < diffs.length; i++) {
    const estimated = Math.round(diffs[i] / median) - 1
    const from = samples[i].presentedFrames
    const to = samples[i + 1].presentedFrames
    // 累積数が減る／進まないのは値が壊れている合図。裏取りには使わない。
    const counted = from != null && to != null && to > from ? to - from - 1 : null
    const missing = counted == null ? estimated : Math.max(counted, estimated)
    if (missing >= 1) gaps.push({ afterIndex: i, missing, measured: counted != null && counted === estimated })
  }
  return gaps
}

// 抜けの合計。**場所（frameGaps）の足し算以外で出さない。**
export function countReportDrops(samples: readonly GapSample[]): number {
  let total = 0
  for (const gap of frameGaps(samples)) total += gap.missing
  return total
}

// 上の合計に裏が取れているか。**1 か所でも推定が混ざれば false。**
// 抜けが 1 つも無ければ true（推定した枚数がそもそも無い）。
export function reportDropsMeasured(samples: readonly GapSample[]): boolean {
  return frameGaps(samples).every((gap) => gap.measured)
}

// トリムした新クリップ用にフレーム表を作り直す。
//
// フレーム表が持つのは「元ファイルの何枚目か」なので、切り出すとその番号は使えなくなる
// （先頭が削られて全体がずれ、再エンコードで枚数自体も変わりうる）。そこで一度
// 元ファイルの時刻へ戻し、切り出し範囲で絞ってから、新ファイルの時刻列へ対応付け直す。
//
// これをやらないとトリムした瞬間にコマ精度が失われる。切り出した箇所こそ細かく見たい
// はずなので、そこで精度が落ちるのは本末転倒になる。
// 型引数で受けるのは、呼び出し元（トリミング）が渡す表が FrameMatch より広い
// （撮り逃しの検証結果 verified を持つ StoredFrame）ためで、切り出しでその情報まで
// 落とすと、トリムした瞬間に「実害なしと確認済み」だったコマが未検証へ逆戻りする。
export function sliceFrameTable<T extends FrameMatch>(
  table: T[],
  originalPts: number[],
  trimmedPts: number[],
  inSec: number
): T[] {
  if (table.length === 0 || originalPts.length === 0 || trimmedPts.length === 0) return []
  // 境界ちょうどのコマを取りこぼさないための許容幅。1コマ（最短でも 1/120 秒）より
  // 十分小さく、浮動小数点の誤差より十分大きい値。
  const EPS = 0.001
  const lastPts = trimmedPts[trimmedPts.length - 1]

  const out: T[] = []
  for (const f of table) {
    if (f.frameIndex < 0 || f.frameIndex >= originalPts.length) continue
    const shifted = originalPts[f.frameIndex] - inSec
    if (shifted < -EPS || shifted > lastPts + EPS) continue
    out.push({ ...f, frameIndex: nearestPtsIndex(trimmedPts, shifted) })
  }
  return out
}

// pts の中で t に最も近い要素の添字。pts は昇順。
function nearestPtsIndex(pts: number[], t: number): number {
  let lo = 0, hi = pts.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pts[mid] < t) lo = mid + 1
    else hi = mid
  }
  // lo は t 以上の最初の位置。1 つ手前の方が近ければそちらを選ぶ。
  if (lo > 0 && Math.abs(pts[lo - 1] - t) <= Math.abs(pts[lo] - t)) return lo - 1
  return lo
}

// 収集した素材のコマから、素材の実 fps を推定する。
// 中央値ではなく回帰で出す（1ms 丸めで返すサービスがあり、中央値だと真の値とずれる）。
export function getSourceFps(): number | null {
  const grid = fitGrid(frames.map((f) => f.mediaTime))
  if (!grid || !(grid.periodMs > 0)) return null
  const fps = 1000 / grid.periodMs
  if (!(fps >= 1 && fps <= 240)) return null
  // 小数第3位まで残す。23.976 と 23.98 は別物として扱いたいので 2 桁では足りない。
  return Math.round(fps * 1000) / 1000
}

// 録画開始の合図から実際に記録を始めるまで、コマ通知が落ち着くのを待つ。
//
// **画面キャプチャが立ち上がる瞬間、ページ側が素材のコマを描き落とす。** ブラウザは
// ハードウェアアクセラレーション OFF（＝CPU で描画）が前提なので、キャプチャの負荷が
// 乗った瞬間に一番重いページだけが落ちる。実測（2026-08-26・YouTube 1080p 23.976fps）:
// 開始から 1.2 秒で 30 コマが描かれず、その後 16.5 秒は 1 コマも落ちなかった。同じ動画を
// 480p にすると 185/185 で 1 コマも落ちない。DMM・Netflix では 18 本すべて 0 コマ。
// **描かれなかったコマは録画ファイルにも無い**ので、後からはどうにもならない。
// 荒れている区間を記録の外へ出すのが唯一の対処になる。
//
// 判定は「1 コマも落ちていないか」では**ない**。60fps 素材は供給（実測 51 枚/秒）が
// 足りず常時 1〜2 コマ落ちるので、完璧を待つと永久に始まらない。**立ち上がりの荒れ
// （まとまった飛び）が収まったか**だけを見る。
// 見る直近のコマ数。**手元の全クリップ 76 本に当てて決めた**（2026-08-26）。
//   窓 8 コマ … 60fps 0.12〜0.25 秒 / 30fps 0.53 秒 / 24fps YouTube 0.63〜1.04 秒
//   窓 12 コマ… 24fps YouTube が 1.2〜2.9 秒。**上限に張り付いて意味を失う。**
// 荒れの無いサービス（DMM・Netflix は 18 本すべて 0 コマ落ち）では窓が埋まった時点で
// 成立するので、24fps なら 0.33 秒。**落ちていないページを待たせない**のが要点。
const SETTLE_WINDOW = 8
// 「まとまった飛び」とみなすコマ数。1〜2 コマの欠けは 60fps 素材の常態（供給 51 枚/秒が
// 60 コマに足りない）なので許す。ここを 2 にすると 60fps が永久に始まらない。
const SETTLE_BIG_GAP = 3
const SETTLE_POLL_MS = 50

export interface SettleResult {
  /** 落ち着いたと判断できたか。false なら見切って始めた（保証できない） */
  settled: boolean
  waitedMs: number
  /** 待っている間に届いたコマ数。0 なら拡張が繋がっていない */
  reports: number
}

// 直近 SETTLE_WINDOW コマの間隔に、まとまった飛びが無いか。
// **DB を張らずに検証できるよう、判定は素材時刻の列だけを見る純粋関数にする**
// （frame-feed.test.ts が数値を固定している）。
export function isSteadySequence(mediaTimes: number[]): boolean {
  if (mediaTimes.length < SETTLE_WINDOW) return false
  const recent = mediaTimes.slice(-SETTLE_WINDOW)
  const diffs: number[] = []
  for (let i = 1; i < recent.length; i++) diffs.push(recent[i] - recent[i - 1])
  // 素材のコマ長は取得できないことがある（fps 不明・再生開始直後）ので、間隔の中央値で代用する。
  const period = [...diffs].sort((a, b) => a - b)[diffs.length >> 1]
  if (!(period > 0)) return false
  return diffs.every((d) => Math.round(d / period) < SETTLE_BIG_GAP)
}

function looksSteady(): boolean {
  return isSteadySequence(frames.map((f) => f.mediaTime))
}

export async function waitForSteadyFrames(timeoutMs: number): Promise<SettleResult> {
  const started = Date.now()
  for (;;) {
    if (looksSteady()) return { settled: true, waitedMs: Date.now() - started, reports: frames.length }
    if (Date.now() - started >= timeoutMs) {
      return { settled: false, waitedMs: Date.now() - started, reports: frames.length }
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS))
  }
}

// 収集済みのコマ通知と撮影時刻から、保存用のフレーム表を作る。
export function buildFrameTable(drawnAt: number[]): MatchResult | null {
  return matchFrames(frames, drawnAt)
}

// 収集済みのコマ通知から、通知が届くまでの遅れを要約する（ReportDelay 参照）。
export function getReportDelay(): ReportDelay | null {
  return summarizeReportDelay(frames)
}

// 録画中にコマ通知が途切れていたら知らせる（1録画1行・途切れたときだけ）。
//
// **途切れた区間のコマは表に入らず、しかもどの数字にも現れない。** 撮り逃し（captured=false）は
// 「コマはあったが絵が無い」だが、こちらは通知そのものが来ていないのでコマの存在すら
// 分からず、`capturedRatio` は 100% のまま「表が録画の途中で終わっているクリップ」ができる。
// 黙って通すと、最も精度が良く見えるクリップの後半が対応していない、という最悪の形になる。
export function logReportInterruptions(): void {
  if (reportGaps === 0) return
  console.warn(
    `[frame-match] source frame reports were interrupted ${reportGaps} time(s) during the recording` +
    ' (the page\'s video element was swapped). Part of the clip has no frame table.'
  )
}

// 採用したオフセットに疑わしい点があれば挙げる（無ければ空）。
//
// **規則をここ 1 か所に集める。** 以前は同じ規則が logMatchResult と recorder-ipc に分かれて
// 書かれ、同じ 1 件の問題について 4 行のログが出ていた。
//
// 探索の窓を素材 1 コマ幅に閉じたことで、**位相がどれだけ曖昧でもずれは 1 コマ未満に収まる**。
// 以前は飽和した録画で 6 コマずれることがあり表ごと捨てていたが、その必要は無くなった
// （捨てると供給が均一な録画ほどコマ精度を失うという副作用の方が大きい）。**ここは表の採否を
// 決めない**——出るのは「疑わしい点」だけで、判断材料としてログに残す。
export function offsetVerdict(result: MatchResult): string[] {
  const problems: string[] = []

  // **撮り逃しが 1 コマも無い録画では、そもそも位相を測れていない。**
  //
  // スコアが位相を区別できるのは「絵の入らないコマ」の凸凹があるときだけで、供給が足りて
  // 全コマ撮れていると窓の中はほぼ一様になる。そこで採用値や同点範囲がどこに寄ったかは
  // 測定結果ではなく揺らぎで、実測でも 30fps 素材 3 本の採用値が 32ms（右端）/ 15ms（中央）/
  // 6ms（左端）と窓の中を跳ね回った（2026-08-13）。片側に寄り続けるなら定数のずれだが、
  // 両端に振れるのは測れていない形。
  //
  // ここで黙らないと、**供給が足りている＝最も出来の良い録画でだけ警告が鳴り続ける**
  // （飽和した録画の表を捨てていた頃と同じ罠）。窓は素材 1 コマ幅なので、位相がどれだけ
  // 曖昧でもずれはコマ内に収まり指すコマは変わらない——実害はない。
  //
  // **測れていないことを隠すわけではない**：同点の数と幅は実測の行（logMatchResult）に
  // 毎回出ているので、定数を測り直すときはそちらを読む。定数の較正は撮り逃しの出る録画
  // （60fps 素材）で行うこと（SPEC 7章）。
  if (result.capturedRatio >= 1) return problems

  // 窓の中で位相が決まらないこと（同点が広いこと）は警告にしない。**窓が 1 コマ幅なので
  // 位相のずれはコマ内に収まり、指すコマは変わらない**——全コマ撮れている録画なら実害が無い。
  // しかも同点が広がるのは供給が均一で撮り逃しが少ない録画、つまり**最も出来の良い録画ほど
  // 毎回警告が出る**ことになる（5-3 で捨てていたときと同じ罠）。同点の数と幅は実測の行に
  // 出しているので、必要なら読める。

  // 採用値が窓の端に寄った＝真の遅延が窓の外にある兆候。**窓の外は隣のコマなので、
  // これは「1 コマずれているかもしれない」という意味**（CAPTURE_LATENCY_MS を疑うこと）。
  const [lo, hi] = result.searchRangeMs
  const [tiedLo, tiedHi] = result.tiedRangeMs
  if (result.offsetMs <= lo || result.offsetMs >= hi) {
    problems.push(`the offset sits at the edge of the ${lo}..${hi}ms window (the capture latency constant may be off)`)
  } else if ((tiedLo <= lo) !== (tiedHi >= hi)) {
    // 同点範囲が**片側の端だけ**に接している＝山が窓で切られている可能性がある。採用値は
    // 同点の中央なので、切られたぶんだけ反対側へ寄る。採用値そのものは端に来ないため、
    // 上の判定では見えない（実測 2026-08-10: 採用 7ms・同点 -1..14ms で左端に接していた）。
    //
    // 両端に接している場合は窓全体が同点＝飽和で、位相が決まっていないだけ。ずれはコマ内に
    // 収まるので何も言わない（供給が均一な＝最も出来の良い録画で毎回出ることになるため）。
    problems.push(
      `the tied range ${tiedLo}..${tiedHi}ms touches one edge of the ${lo}..${hi}ms window` +
      ' (the best phase may lie outside; the capture latency constant may be off)'
    )
  }

  return problems
}

// 録画ごとに、素材のコマをどれだけ撮れたかを残す。
//
// 画面キャプチャの供給は素材のコマ数の2倍に届かないため（実測 33〜41枚/秒）、
// 数%のコマは自分の表示区間内に絵が無い。絵の変わり目に当たるとコマ打ちの数を誤るので、
// どの録画でどれだけ落ちたかを後から追えるようにしておく。
//
// **1 録画につき、実測 1 行＋問題があれば判定 1 行の最大 2 行**に収める。同じ 1 件の問題で
// 何行も出すと、読む側が別々の問題だと受け取る。
// 出力は英語。dev.bat のコンソールは Shift-JIS のため日本語は文字化けする。
export function logMatchResult(result: MatchResult | null): void {
  if (!result) {
    console.log('[frame-match] no frame table (extension not connected / unsupported site)')
    return
  }
  const missing = result.matches.filter((m) => !m.captured).length
  const [tiedMin, tiedMax] = result.tiedRangeMs
  // 複製のスコア差。位置は「採用値 ± n×素材コマ」と決まっているので、差だけ出す。
  const replicas = result.replicas.map((r) => `${r.shift > 0 ? '+' : ''}${r.shift}:${r.scoreDelta}`).join(' ')
  console.log(
    `[frame-match] ${result.sourceFrames} source frames, captured ${(result.capturedRatio * 100).toFixed(1)}%` +
    ` (${missing} reuse), offset ${result.offsetMs}ms in ${result.searchRangeMs[0]}..${result.searchRangeMs[1]}ms` +
    ` | candidates ${result.tiedOffsets} (${tiedMin}..${tiedMax}ms, source frame ${result.sourcePeriodMs.toFixed(1)}ms)` +
    (replicas ? ` | replica deltas ${replicas}` : '') +
    ` | dropped ${result.duplicateReports} duplicate, ${result.outsideRecording} outside`
  )
  // 通知そのものが来なかったコマ（MatchResult.reportDrops 参照）。**captured% の分母に
  // 入っていない**ので、これを出さないと「9 割撮れています」の裏で素材の 2 割が表に無い、
  // という状態を黙って通すことになる。0 のときは何も出さない（大半はこちら）。
  if (result.reportDrops > 0) {
    const total = result.sourceFrames + result.reportDrops
    console.warn(
      `[frame-match] ${result.reportDrops} source frame(s) were never reported` +
      ` (${((result.reportDrops / total) * 100).toFixed(1)}% of the ${total} the source should have had).` +
      // ASCII のみで書くこと。dev.bat のコンソールは Shift-JIS なので、em ダッシュのような
      // 非 ASCII 文字は化ける（実際に "窶・" になった）。
      ' Those frames are absent from the table and from every ratio above; the page did not render them.'
    )
  }
  // 疑わしい点は 1 行にまとめて出す。表は採るが、黙って通さないための行。
  const problems = offsetVerdict(result)
  if (problems.length > 0) console.warn(`[frame-match] the offset may be off: ${problems.join('; ')}`)
}
