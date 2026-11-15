// 素材のコマと録画ファイル内のフレームの突き合わせ（matchFrames）と、その結果の判定・ログ。
// 受信（frame-feed.ts）から分けた。**触る前に .claude/rules/frames.md を読むこと。**
import type { SourceFrame } from './frame-feed'
import { collapseDuplicateReports } from './frame-series'

export interface FrameMatch {
  /** 素材のコマの時刻（秒）。動画時刻の表示とコマの同定に使う */
  mediaTime: number
  /** そのコマが写っている、録画ファイル内のフレーム番号（0 始まり） */
  frameIndex: number
  /**
   * そのコマの表示区間内に実際に画面を撮れていたか。
   *
   * false は「このコマ専用の絵が無く、直前のコマの絵を流用している」ことを意味する。
   * 画面キャプチャの供給が素材の 2 倍に届かないと起きる（今の供給では 30/60fps 素材と
   * 高負荷時。frame-verify.ts の冒頭）。同じ絵が続く 2 コマ打ちの区間なら実害は
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
 * （理由は docs/ANIME-FRAMES.md「絵の差分をフレーム対応の土台にしない」。スコアは素材の周期について周期的なので、
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
 * 詳細は docs/ANIME-FRAMES.md「絵の差分をフレーム対応の土台にしない」。
 */
interface OffsetReplica {
  /** ずらした素材コマ数（-2..+2。0＝採用値そのものは含めない） */
  shift: number
  /** その近傍で最もスコアが高かったオフセット（ミリ秒） */
  offsetMs: number
  /**
   * 採用値のスコアとの差。小さいほど採用値と区別が付いていない。
   * 絵が無いときは撮れたコマ数の差。絵があるときは scoreAt が 3 つの基準を 1 つの数へ詰めた値の差で、
   * コマ数としては読めない（0 かどうかだけが意味を持つ）。
   */
  scoreDelta: number
}

// 複製の頂点を探す窓幅（ミリ秒）。displayAt は完全な等間隔ではなく、vsync 格子と素材周期の
// ドリフトを 3 vsync 分の区間で吸収する箇所があるため、頂点はちょうど P の整数倍から数 ms ずれる。
const REPLICA_WINDOW_MS = 3

/**
 * コマ通知が main へ届くまでの遅れ（`receivedAt - displayAt`）の要約。
 *
 * **オフセットが負に出る理由を切り分けるための実測。** `displayAt` は配信ページ（Chrome）の
 * `expectedDisplayTime`、`drawnAt` はレコーダー（Electron）の `captureTime` を、**別プロセスの単調時計を
 * 各々が録画開始の時点で `Date.now() - performance.now()` を原点にして epoch へ直した値**。
 * 以前の原点は `performance.timeOrigin`（文書の生成時刻で固定）で、開いた後に Windows が時計を
 * 補正するとその幅だけずれ、表の全行がずれていた（frame-sink.ts 参照）。
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
  for (const f of collapseDuplicateReports(source)) {
    if (Number.isFinite(f.receivedAt) && Number.isFinite(f.displayAt)) delays.push(f.receivedAt - f.displayAt)
  }
  if (delays.length === 0) return null
  const sorted = [...delays].sort((a, b) => a - b)
  return { count: sorted.length, minMs: sorted[0], medianMs: sorted[sorted.length >> 1] }
}

// 素材のコマと、録画ファイル内のフレームを対応付ける。
//
// 24fps の素材なら 1 コマは 41.7ms、画面キャプチャの供給は 35〜50 枚/秒なので、素材の 1 コマに
// 撮影フレームはおおむね 1〜2 枚ある（0 枚のコマが撮り逃し）。その中から 1 枚を選ぶ。
//
// 選び方は「そのコマが画面に出た時刻(displayAt)以降に撮られた最初のフレーム」。
// キャプチャ経路には一定の遅延があるため displayAt をそのまま使うと1コマ手前を掴むが、
// この遅延は一定なので、全体が最もきれいに1対1へ収まるオフセットを探して補正する
// （offsetMs）。一定のずれは全コマが等しくずれるだけでコマ打ちの数え方を壊さない。
//
// pictureChanged（録画ファイルの各フレームが 1 つ前と別の絵か）を渡すと、1 コマ内の位相を
// 絵で決める（pictureRuns 参照）。録画直後の検査で、絵を取り出した後にもう一度呼ぶ。
export function matchFrames(
  source: SourceFrame[], drawnAt: number[], pictureChanged?: readonly boolean[]
): MatchResult | null {
  if (source.length === 0 || drawnAt.length === 0) return null

  // 同じ素材コマの重複通知を畳む（presentedFrames の詰め直しも。collapseDuplicateReports）。
  // 畳まないと2つ目は必ず「専用の絵が無い」と判定される。1つ目が絵を確保した直後なので、
  // 次に別の絵が来るまで同じフレームを指すため。撮り逃しでも何でもないのに枚数を水増しする。
  // 録画側は同じ理由で既に重複を潰しており（recorder.ts の lastDrawnMediaTime）、
  // 素材側だけ潰していなかった。
  const frames = collapseDuplicateReports(source)
  const duplicateReports = source.length - frames.length

  // 素材のコマ周期。複製の位置（OffsetReplica）と録画範囲の判定の両方で使う。
  // drops（格子に空いた穴＝通知が来なかったコマ）も同じ当てはめから出る。捨てずに持ち帰る。
  const grid = fitGrid(frames.map((f) => f.mediaTime))
  const periodMs = grid?.periodMs ?? 1000 / 24
  const reportDrops = grid?.drops ?? 0

  // 探索の窓は「実測した遅延 ± 素材コマの半分」＝**幅ちょうど素材 1 コマ**。
  //
  // これより広げてはいけない。スコアは素材の周期について周期的なので、窓が 1 コマより広いと
  // 同じ位相の複製が複数入り、**どれを引くかが端の数コマの差（＝雑音）で決まってしまう**。
  // 実測では 447 コマ中 0 コマの差で選ばれ、録画ごとに -38〜-90ms と 1 コマ以上振れていた。
  // 幅を 1 コマに閉じれば複製は 1 つしか入らず、**何コマぶんずれるかは定数（物理）が決め、
  // 探索は 1 コマ内のどこか（位相）だけを決める**という役割分担になる。docs/ANIME-FRAMES.md「絵の差分をフレーム対応の土台にしない」。
  const usablePicture = pictureChanged && pictureChanged.length === drawnAt.length ? pictureChanged : null
  // 絵があれば、窓の下端をその録画で絵が実際に変わり始めた遅れ（appearanceLatency）に置く。
  const appeared = usablePicture ? appearanceLatency(frames, drawnAt, usablePicture, periodMs) : null
  const windowLo = Math.round(CAPTURE_LATENCY_MS - periodMs / 2)
  const searchHi = windowLo + Math.max(1, Math.round(periodMs)) - 1
  const searchLo = appeared == null ? windowLo : Math.min(searchHi, Math.max(windowLo, appeared))
  const runs = usablePicture
    ? pictureRuns(usablePicture, everyFrameRows(frames, drawnAt, usablePicture, periodMs))
    : null
  const bounds = usablePicture ? changeBounds(frames, drawnAt, usablePicture, searchLo, searchHi) : []

  const pickIndices = (offsetMs: number): number[] => {
    const idx: number[] = []
    let i = 0
    for (const f of frames) {
      const target = f.displayAt + offsetMs
      while (i + 1 < drawnAt.length && drawnAt[i] < target) i++
      idx.push(i)
    }
    return idx
  }

  const pick = (offsetMs: number, repair = true): FrameMatch[] => {
    const idx = pickIndices(offsetMs)
    if (runs && repair) repairByPicture(idx, runs)
    const lastDrawnAt = drawnAt[drawnAt.length - 1]
    // 次のコマが撮影の終わりより後に出た（停止後に届いた通知）なら、次は末尾に張り付いた
    // だけで比べる相手にならない。自分の絵は次の表示より前に撮れているので、区間内に撮れている。
    // 比べると、最後のコマが「専用の絵が無い」とされ 1 つ前の絵を指していた（撮り逃しの誤通知）。
    const nextAfterRecording = (k: number): boolean =>
      k + 1 < frames.length && frames[k + 1].displayAt + offsetMs > lastDrawnAt
    // 「自分の表示区間内に撮れたか」は、次のコマが別のフレームを指したかで決まる。
    //
    // 選ばれるのは常に「その時刻以降の最初のフレーム」なので、次のコマが別のものを
    // 選んだということは、自分のフレームが次のコマの開始より前＝自分の区間内に
    // 撮られていたことを意味する。同じものを選んだなら、そのフレームは自分の区間より
    // 後ろにあり、自分専用の絵が無かったということになる。
    //
    // 時刻の大小で直接判定すると、撮影がちょうど区間の境目に乗ったときに浮動小数点の
    // 誤差で結果が揺れる。添字の比較なら厳密に決まる。
    //
    // 最後の行は比べる次が無い。前の行と同じ 1 枚を指しても、その 1 枚は自分の表示時刻以降に
    // 撮れている（絵を持っていないのは前の行の方）。自分の時刻以降に 1 枚も無い（末尾に張り付いた）
    // ときだけ撮れていない。前の行と比べていたため、前の行が撮り逃しだと最後の行まで撮り逃しにしていた。
    const out = idx.map((frameIndex, k) => ({
      mediaTime: frames[k].mediaTime,
      frameIndex,
      captured: nextAfterRecording(k)
        ? frames[k].displayAt + offsetMs <= lastDrawnAt
        : k + 1 < idx.length ? idx[k + 1] !== frameIndex : drawnAt[frameIndex] >= frames[k].displayAt + offsetMs,
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

  // 絵が無いときのスコアは「自分の区間内に絵があったコマ数」。供給が足りると窓の広い範囲で
  // 満点に張り付き、位相が決まらない（60Hz の画面で 29.97fps を撮ると、注記なしで隣の絵を出す
  // コマが 1 本で最大 87 あった）。絵があるときは先に「1 つ前のコマと別の絵を指すコマ数」で比べる。
  // 区切りの直前の 1 枚を掴む位相ほど、前のコマと同じ絵を指すコマが増えて点が下がる。
  // 数えるのは絵が毎コマ変わっている区間の行だけ（everyFrameRows）。
  // 同点なら、絵の変わり目ごとの条件を満たす数（changeBounds）、さらに同点なら撮れたコマ数で決める。
  // 変わり目の位置で比べる数え方（区間の途中で変わった回数・切り替わる直前の 1 枚を選んだ回数）は、
  // どちらも遅れを 5〜10ms 短く選んで外れを増やした。60Hz の画面では素材 1 コマに撮れる絵が 1〜2 枚
  // しかなく、「1 枚手前の絵の先頭」を選ぶ位置と絵の上で区別がつかない（docs/SPEC.md「キャプチャ経路の遅延（offsetMs）」）。
  const capturedCount = (offsetMs: number): number =>
    pick(offsetMs, false).reduce((n, x) => n + (x.captured ? 1 : 0), 0)
  const scoreAt = (offsetMs: number): number => {
    let distinct = 0
    if (runs) {
      const idx = pickIndices(offsetMs)
      for (let k = 1; k < idx.length; k++) {
        if (runs.dense[k] && runs.dense[k - 1] && runs.run[idx[k]] !== runs.run[idx[k - 1]]) distinct++
      }
    }
    let satisfied = 0
    for (const [above, atMost] of bounds) if (offsetMs > above && offsetMs <= atMost) satisfied++
    // 3 つを 1 つの数へ詰めて辞書順に比べる。桁の幅は各項の上限より大きくなければならない。
    // satisfied の上限は行数ではなく変わり目の数（撮影 1 枚ごとに立ちうるので行数を超える）で、
    // 行数で桁を切ると上の桁（distinct）へ食い込み、比べる順が崩れる。
    const scale = Math.max(frames.length, bounds.length) + 1
    return (distinct * scale + satisfied) * scale + capturedCount(offsetMs)
  }

  let bestScore = -Infinity
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
    let peak = { offsetMs: Math.round(center), score: -Infinity }
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
  // **先頭の行は、絵があれば絵でも範囲内かを確かめる。** 録画が始まる直前に出たコマは、表示区間が
  // 録画と数 ms しか重ならず、時刻の揺らぎで範囲内と判定される。実際にはその絵は撮れておらず、
  // ファイルの 1 枚目にはもう次のコマの絵が写っている——注記なしで次のコマの絵を出していた
  // （テスト動画 13 本のうち 6 本で、外れは先頭の行だけだった）。
  // 1 枚目を指し、次の行とも同じ絵なら、自分の絵を持っていると確かめられないので範囲外とみなす。
  // コマ打ちで本当に同じ絵だった場合も外れるが、失うのは先頭の 1 行だけ。
  while (usablePicture && matches.length > 1 && matches[0].frameIndex === 0 && !pictureChangedBetween(usablePicture, 0, matches[1].frameIndex)) {
    if (matches[0].captured) captured--
    matches.shift()
    outsideRecording++
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

/**
 * 録画ファイルのフレームを「同じ絵が続く区間」に分け、各フレームが何番目の区間かを返す。
 *
 * **何コマずれるかは決めない。** 探索の窓は今までどおり定数 `CAPTURE_LATENCY_MS` を中心に
 * 素材 1 コマ幅で、絵が決めるのは窓の中の位相と、隣り合う行の 1 枚の選び直しだけ
 * （docs/ANIME-FRAMES.md「絵の差分をフレーム対応の土台にしない」の理由 2）。行は素材のコマのまま
 * 1 つも足し引きしないので、同じ絵が何コマ続いたかは今までどおり数えられる（同・理由 1）。
 *
 * 時刻だけで位相を決めると、60Hz の画面ではページが報告する表示時刻が 30・35ms の刻みで
 * 画面の書き換えと合わず、どの位相でも区切りの直前の 1 枚を掴むコマが残る。テスト動画
 * （29.97fps・6 本）で、注記なしで隣の絵を出すコマが合計 234 → 31 になった。残りの大半は、その絵が
 * 録画のどこにも写っていないコマ（どう選んでも当たらない）。
 */
export interface PictureRuns {
  run: number[]
  /** 区間ごとの先頭フレーム */
  first: number[]
  /** 素材のコマ（行）ごとに、絵が毎コマ変わっている区間にあるか（everyFrameRows） */
  dense: boolean[]
}

// 絵が毎コマ変わっている区間にある行か。**同じ絵が続く区間（コマ打ち）の行では絵で位相を決めない。**
// そこでは「前のコマと別の絵を指すコマ数」が位相の手がかりにならず、むしろ外れる位相を選ぶ
// （2 コマ打ちを模した合成データで、外れが 27 → 92 に増えた）。
//
// アニメは人物がコマ打ちでも、背景・光・カメラが毎コマ動く場面が 1 本の中に混ざる（実録画で、
// 光る魚が毎コマ動く背景の前で人物が 2〜3 コマ打ち）。録画全体で判定すると混ざった録画で絵を
// 使えないので、行ごとに前後 EVERY_FRAME_SPAN コマぶんの変わり目の数で見分ける。
// 毎コマ変わる区間なら変わり目は約 2×EVERY_FRAME_SPAN 個、2 コマ打ちなら半分。
const EVERY_FRAME_SPAN = 3
const EVERY_FRAME_MIN_CHANGES = 5
// 毎コマ変わる区間の行がこれより少なければ、絵は使わない（素材 1 秒ぶん）。
const EVERY_FRAME_MIN_ROWS = 24

function everyFrameRows(
  frames: SourceFrame[], drawnAt: number[], changed: readonly boolean[], periodMs: number
): boolean[] | null {
  const span = EVERY_FRAME_SPAN * periodMs
  const dense: boolean[] = []
  let lo = 0
  let hi = 0
  let count = 0
  for (const f of frames) {
    const center = f.displayAt + CAPTURE_LATENCY_MS
    while (hi < drawnAt.length && drawnAt[hi] < center + span) { if (changed[hi]) count++; hi++ }
    while (lo < hi && drawnAt[lo] < center - span) { if (changed[lo]) count--; lo++ }
    dense.push(count >= EVERY_FRAME_MIN_CHANGES)
  }
  return dense.filter(Boolean).length >= EVERY_FRAME_MIN_ROWS ? dense : null
}

export function pictureRuns(changed: readonly boolean[], dense: boolean[] | null): PictureRuns | null {
  if (!dense) return null
  const run: number[] = []
  const first: number[] = []
  let r = -1
  for (let k = 0; k < changed.length; k++) {
    if (k === 0 || changed[k]) {
      r++
      first.push(k)
    }
    run.push(r)
  }
  return { run, first, dense }
}

/**
 * 絵の変わり目ごとに、正しい絵を選べる遅れの範囲（下限を含まず上限を含む）を返す。
 *
 * 撮影 s で絵が変わったなら、新しい絵の最初のコマ k は s より前の 1 枚（変わる前の絵）を選んではいけず、
 * 1 つ前のコマ k-1 は s 以降（変わった後の絵）を選んではいけない。「その時刻以降の最初の 1 枚」を
 * 選ぶので、条件は `t(s-1) - displayAt_k < 遅れ <= t(s-1) - displayAt_(k-1)`。**止め絵と口パクだけの
 * 録画でも、口・まばたきの変わり目から位相が決まる。** 毎コマ変わる区間が要らない。
 *
 * 新しい絵の最初のコマ k は、変わる前後 2 枚の中間の時刻が窓（定数の遅れ ± 素材コマの半分）に入る
 * コマとみなす。何コマずれるかは今までどおり定数が決める。
 * **変わった後の 1 枚の時刻で結び付けてはいけない。** その 1 枚は遅れより最大で撮影 1 回ぶん遅いので、
 * 窓の外へはみ出して隣のコマに結び付き、遅れを短く選ぶ（テスト動画で外れが 7 → 42 に増えた）。
 * 「変わった直後の 1 枚をちょうど選ぶ」位置を探す数え方も同じ理由で短く出た——変わった後の 2 枚目を
 * 選んでも正しいのに減点していた。
 *
 * テスト動画 8 本（2〜3 コマ打ちを模して変わり目を間引いたもの）で、注記なしの外れが 2 コマ打ちで
 * 合計 126 → 20、3 コマ打ちで 117 → 5。
 */
function changeBounds(
  frames: SourceFrame[], drawnAt: number[], changed: readonly boolean[], searchLo: number, searchHi: number
): [number, number][] {
  const out: [number, number][] = []
  let k = 0
  for (let s = 1; s < drawnAt.length; s++) {
    if (!changed[s]) continue
    const mid = (drawnAt[s] + drawnAt[s - 1]) / 2
    while (k + 1 < frames.length && mid - frames[k + 1].displayAt > searchLo) k++
    const latency = mid - frames[k].displayAt
    if (k === 0 || latency <= searchLo || latency > searchHi + 1) continue
    out.push([drawnAt[s - 1] - frames[k].displayAt, drawnAt[s - 1] - frames[k - 1].displayAt])
  }
  return out
}

/**
 * 絵が変わった時刻（変わる前後 2 枚の中間）が、その直前に表示されたコマの表示時刻から何 ms 後かの中央値。
 *
 * **窓を「定数 ± 素材コマの半分」に置くと、コマの長い素材で 1 コマ前の絵を選ぶ。** 窓の下半分が
 * 「まだ絵が変わる前」のタイミングになるため。18fps の YouTube 動画で、絵は表示時刻の 10〜35ms 後に
 * 変わっていたのに、-7ms を選んで全コマが注記なしで 1 つ前の絵を指した。この値より前を選ぶと、
 * 半分以上の変わり目で変わる前の絵を拾うので、窓の下端に置く。
 *
 * 「直前に表示されたコマ」から測るので、遅れが素材 1 コマより長いと 1 コマぶん短く出る。60fps
 * （コマ長 16.7ms）は遅れ（実測 14〜28ms）がコマより長いので測らず、定数の窓のままにする
 * （定数の窓の理由は CAPTURE_LATENCY_MS）。変わり目が少ないときも測らない。
 */
const APPEARANCE_MIN_CHANGES = 10

function appearanceLatency(
  frames: SourceFrame[], drawnAt: number[], changed: readonly boolean[], periodMs: number
): number | null {
  if (periodMs <= 2 * CAPTURE_LATENCY_MS) return null
  const lat: number[] = []
  let k = 0
  for (let s = 1; s < drawnAt.length; s++) {
    if (!changed[s]) continue
    const mid = (drawnAt[s] + drawnAt[s - 1]) / 2
    while (k + 1 < frames.length && frames[k + 1].displayAt <= mid) k++
    if (frames[k].displayAt <= mid) lat.push(mid - frames[k].displayAt)
  }
  if (lat.length < APPEARANCE_MIN_CHANGES) return null
  lat.sort((a, b) => a - b)
  return Math.round(lat[lat.length >> 1])
}

// ファイルの a 枚目から b 枚目までのあいだで絵が変わったか。
function pictureChangedBetween(changed: readonly boolean[], a: number, b: number): boolean {
  for (let s = a + 1; s <= b; s++) if (changed[s]) return true
  return false
}

// 時刻で選んだ 1 枚が区切りをまたいだ行を、隣の区間へ移す。
//
// 前の行と同じ絵を指し、次の行が 1 つ飛ばした区間を指すなら、飛ばされた区間はこの行の絵
// （区切りの直前を掴んだ）。逆に前の行から 1 つ飛ばし、次の行と同じ絵を指すなら、飛ばした
// 区間がこの行の絵（区切りの直後を掴みすぎた）。どちらでもない行は動かさない——同じ絵が
// 続く区間（コマ打ち）では隣どうしが同じ区間を指すのが正常で、飛ばしが無いので動かない。
function repairByPicture(idx: number[], runs: PictureRuns): void {
  const R = (k: number): number => runs.run[idx[k]]
  for (let k = 1; k + 1 < idx.length; k++) {
    if (!runs.dense[k - 1] || !runs.dense[k] || !runs.dense[k + 1]) continue
    if (R(k) === R(k - 1) && R(k + 1) - R(k) >= 2) idx[k] = runs.first[R(k) + 1]
    else if (R(k) - R(k - 1) >= 2 && R(k + 1) === R(k)) idx[k] = runs.first[R(k) - 1]
  }
}

// 素材のコマ周期を最小二乗で推定する。
// mediaTime を 1ms 単位に丸めて返すサービスがあるため（YouTube で確認）、間隔の中央値を
// 周期とみなすと真の値（41.708ms に対し中央値 42ms）とずれ、コマ数を重ねるほど誤差が
// 積もる。仮周期で通し番号を振ってから直線に当てはめれば、丸めがあっても復元できる。
export function fitGrid(mediaTimes: number[]): { periodMs: number; residualRmsMs: number; drops: number } | null {
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
  // （60fps 素材）で行うこと（docs/SPEC.md「キャプチャ経路の遅延」）。
  if (result.capturedRatio >= 1) return problems

  // 窓の中で位相が決まらないこと（同点が広いこと）も、上と同じ理由で警告にしない。

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
// 画面キャプチャの供給が素材のコマ数の2倍に届かないと（今の供給では 30/60fps 素材・高負荷時）、
// 自分の表示区間内に絵が無いコマが出る。絵の変わり目に当たるとコマ打ちの数を誤るので、
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
