// アプリと拡張（extension/*.js）の両方に同じ値が要る定数の**原本**。
//
// 拡張はバンドラ無しで配布する素の script なので、この TypeScript を import できない。
// そのため以前は同じ数値を app・background.js・content.js の 3 箇所に手で書き写し、
// テストが拡張のソースを正規表現で切り出して突き合わせていた（L-1 の指摘）。
//
// 今はここが唯一の原本で、拡張側の const 行は `npm run ext:limits` が生成する。
// 拡張のファイルには生成の目印（`==== ここから自動生成: ... ====`）が入っていて、
// その内側は手で書き換えない。書き換えても extension-parity.test.ts が食い違いとして落とす。
//
// **ここに electron/node 依存を持ち込まない。** 生成スクリプトが Node の型ストリップで
// 直接 import するため、import を 1 つでも足すと解決できなくなる（拡張子の書き方が
// TypeScript と Node で食い違うため）。

// ---------------------------------------------------------------------------
// 値の原本
// ---------------------------------------------------------------------------

// 拡張との接続に使うポートの候補。アプリは先頭から順に listen を試し、拡張は先頭から順に
// 接続を試す。同じ並びを両側が持つので、どこに落ち着いても設定は要らない。
//
// なぜ 1 つでは足りないか — Windows は Hyper-V / WSL2 / Docker Desktop が有効だと、
// 起動のたびに TCP ポートを**ブロック単位でまとめて予約**する
// （netsh int ipv4 show excludedportrange protocol=tcp で見える）。予約範囲は再起動ごとに
// 変わるため、固定 1 ポートだと「昨日まで動いていたのに今日は繋がらない」が利用者側で
// 突然起きる。利用者に心当たりは無く、拡張を入れ直しても直らない。
//
// 候補の選び方 — 予約は連続ブロックで来るので、隣（39822 など）は同じブロックに巻き込まれる。
// 2000 ずつ離す。全部 Windows の既定の動的ポート範囲（49152-65535）より下に置き、
// そちらの自動割り当てとは衝突しないようにする。
// 先頭は必ず 39821 のまま（既存の利用者が今そこで繋がっているため、並べ替えると
// 更新直後の 1 回だけ全員が候補探しをすることになる）。
export const WS_PORTS = [39821, 41821, 43821, 45821] as const

export const MAX_TITLE_LENGTH = 500
export const MAX_URL_LENGTH = 2048
export const MAX_WS_PAYLOAD_BYTES = 16 * 1024
export const MAX_REQUEST_ID_LENGTH = 80
export const MAX_TIMECODE_SECONDS = 10_000_000
export const MIN_SCREEN_COORD = -100_000
export const MAX_SCREEN_COORD = 100_000
export const MIN_SCREEN_SIZE = 1
export const MAX_SCREEN_SIZE = 20_000
export const MIN_DEVICE_PIXEL_RATIO = 0.25
export const MAX_DEVICE_PIXEL_RATIO = 8
// 素材のコマ間隔（ミリ秒）の許容範囲。拡張側が実測値を採用する条件（10〜120fps。
// content.js の startFrameTracker）と揃えてある。範囲外なら null にして「測れていない」
// 扱いにする——**壊れた値でビットレートを決めるくらいなら、従来どおりの固定値でよい。**
export const MIN_SOURCE_FRAME_MS = 1000 / 120
export const MAX_SOURCE_FRAME_MS = 1000 / 10
// コマ通知の displayAt（epoch ミリ秒）の妥当上限。西暦 2100 年相当。
// 壊れた値・別基準の時刻（performance.now() の生値など）が混ざったまま時刻計算に入ると、
// コマの対応付けが黙って狂うため入口で落とす。
export const MAX_EPOCH_MS = 4_102_444_800_000
// コマ通知の presentedFrames（合成へ送られたコマの累積数）の妥当上限。
// 120fps で 24 時間開きっぱなしにしても 1000 万に届かないので、その 10 倍を上限にする。
// **この値の差がそのまま「通知が来なかったコマ数」になる**ので、壊れた値が入ると
// 抜けの枚数が黙って狂う。入口で落とす。
export const MAX_PRESENTED_FRAMES = 100_000_000

// ここから下はアプリ側に対応する処理が無い、**拡張の中だけで使う値**。それでも
// background.js と content.js の 2 箇所に要る、あるいはテストが値を見るので、原本はここに置く。

// プレーヤー UI を隠したままにできる上限（ms）。
export const MAX_UI_HOLD_MS = 120_000
// 画面に出す通知文の上限。
export const MAX_NOTICE_MESSAGE_LENGTH = 240
// アプリから配られるコマ送りの文言の上限（原本は ja.ts）。
export const MAX_STEP_LABEL_LENGTH = 120
// タイムコードの定期送信の間隔（ms）。
export const TIMECODE_POLL_MS = 5000
// 録画中だけ回す rVFC ループの復帰確認間隔（ms）。
export const FRAME_WATCHDOG_MS = 500

// ---------------------------------------------------------------------------
// 拡張へ差し込む生成ブロック
// ---------------------------------------------------------------------------

type Entry = {
  // 生成する行の直前に置くコメント（`// ` は付けずに書く）
  readonly note?: readonly string[]
  readonly name: string
  readonly literal: string
}

export type GeneratedBlock = {
  /** extension/ 内のファイル名 */
  readonly file: string
  /** 目印に書く名前。同じファイルに複数置けるよう分けてある */
  readonly id: string
  /** 目印の内側に入る本文（末尾に改行は付けない） */
  readonly text: string
}

function numberArray(values: readonly number[]): string {
  return `[${values.join(', ')}]`
}

function stringSet(values: readonly string[], perLine: number): string {
  const rows: string[] = []
  for (let i = 0; i < values.length; i += perLine) {
    rows.push('  ' + values.slice(i, i + perLine).map((v) => `'${v}'`).join(', '))
  }
  return `new Set([\n${rows.join(',\n')}\n])`
}

function render(entries: readonly Entry[]): string {
  const lines = [
    '// 以下は app/src/shared/wire-limits.ts が原本。**手で書き換えない**（verify が落とす）。',
    '// 直すときは wire-limits.ts を変えてから app/ で `npm run ext:limits` を実行する。',
  ]
  for (const entry of entries) {
    for (const note of entry.note ?? []) lines.push(note ? `// ${note}` : `//`)
    lines.push(`const ${entry.name} = ${entry.literal}`)
  }
  return lines.join('\n')
}

/**
 * 拡張へ差し込むブロックを全部組み立てる。
 *
 * `namedCaptureKeys` は shared/hotkey.ts の正規化後キー名（あちらが原本）。ここから
 * import せずに引数で受けるのは、このファイルを import 無しに保つため（先頭の注意を参照）。
 */
export function renderExtensionBlocks(namedCaptureKeys: ReadonlySet<string>): GeneratedBlock[] {
  return [
    {
      file: 'background.js',
      id: 'ports',
      text: render([
        {
          note: [
            '接続先ポートの候補。アプリは先頭から順に listen を試し、こちらは先頭から順に',
            '接続を試すので、どのポートに落ち着いても合流する。複数ある理由は、Windows の',
            'Hyper-V / WSL2 / Docker Desktop が起動ごとにポートをブロック単位で予約するため。',
          ],
          name: 'WS_PORTS',
          literal: numberArray([...WS_PORTS]),
        },
      ]),
    },
    {
      file: 'background.js',
      id: 'limits',
      text: render([
        { name: 'MAX_WS_MESSAGE_BYTES', literal: String(MAX_WS_PAYLOAD_BYTES) },
        { name: 'MAX_TITLE_LENGTH', literal: String(MAX_TITLE_LENGTH) },
        { name: 'MAX_URL_LENGTH', literal: String(MAX_URL_LENGTH) },
        { name: 'MAX_REQUEST_ID_LENGTH', literal: String(MAX_REQUEST_ID_LENGTH) },
        { name: 'MAX_NOTICE_MESSAGE_LENGTH', literal: String(MAX_NOTICE_MESSAGE_LENGTH) },
        { name: 'MAX_STEP_LABEL_LENGTH', literal: String(MAX_STEP_LABEL_LENGTH) },
        { name: 'MAX_TIMECODE_SECONDS', literal: String(MAX_TIMECODE_SECONDS) },
        { name: 'MIN_SCREEN_COORD', literal: String(MIN_SCREEN_COORD) },
        { name: 'MAX_SCREEN_COORD', literal: String(MAX_SCREEN_COORD) },
        { name: 'MIN_SCREEN_SIZE', literal: String(MIN_SCREEN_SIZE) },
        { name: 'MAX_SCREEN_SIZE', literal: String(MAX_SCREEN_SIZE) },
        { name: 'MIN_DEVICE_PIXEL_RATIO', literal: String(MIN_DEVICE_PIXEL_RATIO) },
        { name: 'MAX_DEVICE_PIXEL_RATIO', literal: String(MAX_DEVICE_PIXEL_RATIO) },
        {
          note: [
            '素材のコマ間隔（ミリ秒）の許容範囲。content.js の startFrameTracker が実測値を',
            '採用する条件（10〜120fps）と同じ。',
          ],
          name: 'MIN_SOURCE_FRAME_MS',
          literal: String(MIN_SOURCE_FRAME_MS),
        },
        { name: 'MAX_SOURCE_FRAME_MS', literal: String(MAX_SOURCE_FRAME_MS) },
        {
          note: [
            'コマ通知の displayAt（epoch ミリ秒）の妥当上限。西暦 2100 年相当。',
            '壊れた値・別基準の時刻（performance.now() の生値など）が混ざったまま main 側の',
            '時刻計算に入ると、コマの対応付けが黙って狂うため入口で落とす。',
          ],
          name: 'MAX_EPOCH_MS',
          literal: String(MAX_EPOCH_MS),
        },
        {
          note: [
            'コマ通知の presentedFrames（合成へ送られたコマの累積数）の妥当上限。',
            '**前後の差がそのまま「通知が来なかったコマ数」になる**ので、壊れた値を中継すると',
            '抜けの枚数が黙って狂う。入口で落とす。',
          ],
          name: 'MAX_PRESENTED_FRAMES',
          literal: String(MAX_PRESENTED_FRAMES),
        },
        {
          note: [
            'プレーヤー UI を隠したままにできる上限（ms）。クリップの最長 30 秒＋停止処理の',
            'マージンを十分に超える値だが、壊れた値で UI が延々と隠れたままになるのは防ぐ。',
          ],
          name: 'MAX_UI_HOLD_MS',
          literal: String(MAX_UI_HOLD_MS),
        },
        {
          note: ['shared/hotkey.ts の NAMED_KEYS と対になる、captureKey として許容する名前付きメインキー。'],
          name: 'NAMED_CAPTURE_KEYS',
          literal: stringSet([...namedCaptureKeys], 8),
        },
      ]),
    },
    {
      file: 'content.js',
      id: 'limits',
      text: render([
        { note: ['pre-capture で受け取る holdMs の上限（ms）。'], name: 'MAX_UI_HOLD_MS', literal: String(MAX_UI_HOLD_MS) },
        { name: 'MAX_TITLE_LENGTH', literal: String(MAX_TITLE_LENGTH) },
        { name: 'MAX_URL_LENGTH', literal: String(MAX_URL_LENGTH) },
        { name: 'MAX_REQUEST_ID_LENGTH', literal: String(MAX_REQUEST_ID_LENGTH) },
        { name: 'MAX_NOTICE_MESSAGE_LENGTH', literal: String(MAX_NOTICE_MESSAGE_LENGTH) },
        {
          note: ['アプリから配られるコマ送りの文言の上限（ja.ts が原本）。'],
          name: 'MAX_STEP_LABEL_LENGTH',
          literal: String(MAX_STEP_LABEL_LENGTH),
        },
        { note: ['タイムコードの定期送信の間隔（ms）。'], name: 'TIMECODE_POLL_MS', literal: String(TIMECODE_POLL_MS) },
      ]),
    },
    {
      file: 'content.js',
      id: 'frame-watchdog',
      text: render([
        {
          note: [
            '録画中だけ回す復帰用のウォッチドッグ間隔（ミリ秒）。',
            '',
            'rVFC ループは <video> が差し替わる（広告挿入・画質切替）と自分で止まる。復帰が',
            'タイムコードの定期送信（TIMECODE_POLL_MS）の中の observeVideo 頼みだと、',
            '**最大 5 秒コマ通知が途切れる**——30 秒クリップなら 1/6 が対応不明になる。録画中だけは',
            '短い間隔で生存を確かめる（startFrameTracker は冪等なので、回っていれば何もしない）。',
          ],
          name: 'FRAME_WATCHDOG_MS',
          literal: String(FRAME_WATCHDOG_MS),
        },
      ]),
    },
  ]
}

function blockPattern(id: string): RegExp {
  return new RegExp(
    `(^[^\\S\\r\\n]*// ==== ここから自動生成: ${id} ====[^\\S\\r\\n]*\\r?\\n)([\\s\\S]*?)(^[^\\S\\r\\n]*// ==== ここまで自動生成: ${id} ====)`,
    'm',
  )
}

/** 目印の内側を取り出す。改行は LF に揃えて返す（拡張のファイルは CRLF） */
export function readGeneratedBlock(source: string, id: string): string {
  const hit = blockPattern(id).exec(source)
  if (!hit) throw new Error(`生成ブロックの目印が見つからない: ${id}`)
  return hit[2].replace(/\r\n/g, '\n').replace(/\n$/, '')
}

/** 目印の内側を差し替える。元のファイルの改行（CRLF / LF）はそのまま保つ */
export function writeGeneratedBlock(source: string, id: string, text: string): string {
  if (!blockPattern(id).test(source)) throw new Error(`生成ブロックの目印が見つからない: ${id}`)
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const body = text.split('\n').join(eol) + eol
  return source.replace(blockPattern(id), (_all, head: string, _old: string, tail: string) => head + body + tail)
}
