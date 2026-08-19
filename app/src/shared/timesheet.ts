import { FRAME_QUALITY, type ClipFrames } from './api.video'

// 東映アニメーション デジタルタイムシートへ貼り付けるためのクリップボード形式。
//
// **公開されている xdts の仕様とは別物**（根が timeTables ではなく layers、絵が続くコマの
// 表し方も違う）。実測で採った形式なので、値の根拠はすべて docs/TIMESHEET.md 2-6 / 2-7 にある。
// ファイル書き出しは作らない——渡し方はクリップボードだけ。

// 1 行目に必ず付ける固定文字列。これが無いと貼り付け先が受け取らない。
export const TOEI_CLIPBOARD_HEADER = 'toeiDigitalTimeSheet Copy Data'

// 画面の 1 コマ目が frame 24。先頭ダミーコマ（1 秒＝24 コマ）ぶんの下駄で、0 起点ではない。
// **貼り付け位置はこの値で決まる**（貼る前にどこを選んでいても、frame の絶対値の位置へ入る）。
export const TOEI_FRAME_BASE = 24

// 実測サンプルに合わせただけの値。**この 2 つは貼り付け先を決めない**——欄も列も、貼る前に
// 選んでいるマスで決まる（動画欄のデータを原画欄へ貼っても、そのまま正しく表示される）。
// コピーしたときに「今どこにあるか」を答えるための値なので、**意味を持たせないこと。**
// 絶対値で効くのは frame（縦位置）だけ。詳細は docs/TIMESHEET.md 2-6。
export const TOEI_FIELD = 4
export const TOEI_TRACK = 0

export interface ToeiFrameData {
  fontColorId?: number
  id: number
  values?: string[]
}

export interface ToeiClipboard {
  fieldId: number
  layers: { frames: { data: ToeiFrameData[]; frame: number }[]; inlineNo: number; trackNo: number }[]
}

// total はクリップの素材コマ数で、**範囲内の全コマがエントリを持つ**（これが仕様）。
//
// 絵が続くコマは values を持たない `{ id: 0 }` で表す。**エントリを省くのではない**——
// 省いた場合にどう解釈されるかは確認していないので、実測した形をそのまま守る。
export function buildToeiClipboard(marks: readonly TimesheetMark[], total: number): string {
  const labels = timesheetLabels(marks)
  const labelByFrame = new Map<number, string>()
  marks.forEach((mark, i) => {
    if (Number.isInteger(mark.frame) && mark.frame >= 0 && mark.frame < total) {
      labelByFrame.set(mark.frame, labels[i])
    }
  })
  const frames = Array.from({ length: Math.max(0, total) }, (_, i) => {
    const label = labelByFrame.get(i)
    return {
      data: label !== undefined ? [{ fontColorId: 0, id: 0, values: [label] }] : [{ id: 0 }],
      frame: TOEI_FRAME_BASE + i
    }
  })
  const body: ToeiClipboard = {
    fieldId: TOEI_FIELD,
    layers: [{ frames, inlineNo: 0, trackNo: TOEI_TRACK }]
  }
  // 実物のコピーがインデント 4 の整形済み JSON なので、それに揃える。
  // 実機で採った内容と目視で突き合わせられる方が、後から形式を疑うときに早い。
  return `${TOEI_CLIPBOARD_HEADER}\n${JSON.stringify(body, null, 4)}\n`
}

// タイムシートを出してよいクリップか。
//
// **撮り逃しが 1 コマでもあれば出さない。** 打った位置が素材のどのコマなのか保証できない表を
// 作らせると、後から見て信用してよいか分からない記録が残る。しかも書き出し先（東映の
// クリップボード形式）には「このコマは怪しい」を書く欄が無いので、渡した先では区別が消える。
//
// 素材 fps も確定していなければ出さない。表の秒区切りとコピー先に必要な尺を設定 fps で
// 代用すると、素材と違うタイムシートを正しいものとして残せてしまうため。
//
// この条件で、表そのものが無いクリップ（取り込み動画・対応が崩れて表を捨てたもの）と
// 60fps 素材（供給不足で原理的に撮り逃す）も自動的に外れる。
export function canBuildTimesheet(frames: ClipFrames | null | undefined, fps: number | null | undefined): boolean {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) return false
  if (!frames || !frames.sourceBased || frames.pts.length === 0) return false
  // quality は sourceBased のときだけ pts と同じ長さで入る。欠けている＝コマごとの
  // 確からしさが分からないということなので、その時点で出さない。
  if (frames.quality.length !== frames.pts.length) return false
  return frames.quality.every((q) => q === FRAME_QUALITY.captured)
}

// 打った内容。**記録するのは素材コマの添字だけで、秒は持たない**——秒で持つと再生位置の
// 丸めでコマ境界を跨ぐ（docs/PENDING.md 5）。母数はクリップのフレーム表（video_frames）。
export interface TimesheetMark {
  /** 新しい絵が始まる素材コマの添字（0 起点） */
  frame: number
  /**
   * 動画番号。**打たなければ持たない**——その場合は上から数えた通し番号を自動で振る。
   *
   * 東映デジタルタイムシートは番号を人が半角英数字で打つ（原画から引き継いだ番号は
   * 連番とは限らず、飛んだり枝番が付いたりする）。打てるようにしつつ、ただ数えるだけの
   * ときに毎回入力させないための省略。
   */
  value?: string
  /** その絵に添える短いメモ。空なら持たない */
  memo?: string
}

/**
 * セル欄に入れられる記号。**実物のコピーから採った綴り**（2026-08-13）。
 * xdts のファイル仕様と同じ文字列だったが、**確認できたから使う**のであって、
 * ファイル仕様から持ってきたのではない（クリップボード形式は別物なので推測はしない）。
 *
 * 東映デジタルタイムシートでの入力キーは ○=F1 か `/`、●=F2 か `-`、×=F3 か `*`。
 */
export const TOEI_SYMBOL = {
  /** ○ 中割り記号（番号を振らずに「ここに中割りが入る」とだけ示す） */
  inbetween: 'SYMBOL_TICK_1',
  /** ● 逆シート記号（既に作った中割りを逆順に並べて兼用する指示） */
  reverse: 'SYMBOL_TICK_2',
  /** × カラ（その層に絵が無い） */
  empty: 'SYMBOL_NULL_CELL',
} as const
export type ToeiSymbol = (typeof TOEI_SYMBOL)[keyof typeof TOEI_SYMBOL]

const SYMBOL_VALUES: readonly string[] = Object.values(TOEI_SYMBOL)
export function isToeiSymbol(value: string): value is ToeiSymbol {
  return SYMBOL_VALUES.includes(value)
}

// 画面に出す字。**保存とコピーは綴りのまま**で、記号に見せるのは表示だけ。
const GLYPH: Record<string, string> = {
  [TOEI_SYMBOL.inbetween]: '○',
  [TOEI_SYMBOL.reverse]: '●',
  [TOEI_SYMBOL.empty]: '×',
}
export function timesheetGlyph(value: string): string {
  return GLYPH[value] ?? value
}

// 動画番号に許す形。東映側が半角英数字なのでそれに合わせ、長さだけ歯止めを置く。
// 記号はアンダースコアを含む決まった綴りなので、そのまま通す。
export const MAX_TIMESHEET_VALUE = 8
export function normalizeTimesheetValue(raw: string): string {
  if (isToeiSymbol(raw)) return raw
  return raw.replace(/[^0-9A-Za-z]/g, '').slice(0, MAX_TIMESHEET_VALUE)
}

// 表示・書き出しに使う番号を確定させる。**打たれた番号があればそれ、無ければ通し番号。**
// 通し番号は「上から何枚目か」なので、間に打ち足すと以降が繰り上がる（紙で振り直すのと同じ）。
//
// **通し番号は配列の並びではなくコマ順で数える。** 呼ぶ側が並べ替え済みであることに
// 頼ると、打った順のまま渡された瞬間に番号だけが入れ替わる——絵は正しい位置に出るので
// 画面では気付けず、コピーした表だけが狂う類の壊れ方になる。
export function timesheetLabels(marks: readonly TimesheetMark[]): string[] {
  const ordinal = new Array<number>(marks.length)
  marks
    .map((mark, i) => ({ frame: mark.frame, i }))
    .sort((a, b) => a.frame - b.frame)
    .forEach((entry, n) => { ordinal[entry.i] = n + 1 })
  return marks.map((mark, i) => mark.value || String(ordinal[i]))
}

// 保存の上限。1 コマ打ちで 30 秒撮っても素材コマは 720（60fps でも 1800）なので、
// これを超えるのは壊れた入力しかない。
const MAX_MARKS = 5000
export const MAX_TIMESHEET_MEMO = 200

// DB から読んだ JSON を打鍵の列へ戻す。**壊れていたら空にして黙って捨てる**のではなく、
// 読めた行だけを拾う——研究用途で打ち込んだ手作業なので、全部無かったことにする方が損。
export function decodeTimesheet(json: string | null | undefined): TimesheetMark[] {
  if (!json) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    console.warn('[timesheet] stored row is unusable')
    return []
  }
  if (!Array.isArray(parsed)) return []
  const seen = new Set<number>()
  const out: TimesheetMark[] = []
  for (const item of parsed) {
    if (!Array.isArray(item)) continue
    const [frame, value, memo] = item as [unknown, unknown, unknown]
    if (!Number.isInteger(frame) || (frame as number) < 0 || seen.has(frame as number)) continue
    seen.add(frame as number)
    const mark: TimesheetMark = { frame: frame as number }
    const cleanValue = typeof value === 'string' ? normalizeTimesheetValue(value) : ''
    if (cleanValue) mark.value = cleanValue
    if (typeof memo === 'string' && memo) mark.memo = memo.slice(0, MAX_TIMESHEET_MEMO)
    out.push(mark)
  }
  return out.sort((a, b) => a.frame - b.frame).slice(0, MAX_MARKS)
}

// 保存用。[コマ, 動画番号, メモ] の組を配列で持つ（1 クリップで数百組になるので、キー名を
// 繰り返す形にはしない。video_frames の encodeFrames と同じ判断）。
// 末尾の空要素は落とす——打鍵だけの行が [0,"",""] と 3 要素で並ぶと無駄に太る。
export function encodeTimesheet(marks: readonly TimesheetMark[]): string {
  return JSON.stringify(marks.map((m) => {
    const row: (number | string)[] = [m.frame, m.value ?? '', m.memo ?? '']
    while (row.length > 1 && row[row.length - 1] === '') row.pop()
    return row
  }))
}

// 貼り付け先のシートに必要な尺。クリップボード形式には尺を書く欄が無いので、
// 足りないぶんは貼った先で灰色（範囲外）になる。画面に出す用。
export function requiredSheetLength(total: number, fps: number): { seconds: number; frames: number } {
  const perSecond = Math.max(1, Math.round(fps))
  return { seconds: Math.floor(total / perSecond), frames: total % perSecond }
}
