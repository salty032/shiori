// 画面キャプチャの供給レートを、録画を伴わずに計測する（開発時のみ）。
//
// 実測で「素材 24fps に対し供給は 26〜33枚/秒」と分かっているが、必要なのはその 2 倍
// （約 48枚/秒）で、届いていない。上限を決めている要因の候補は 3 つあり、録画のログ
// （capture-diag.ts）だけでは区別できない。
//
//   1. キャプチャ本体のコスト     → 解像度を下げれば増えるはず
//   2. 描画・エンコードの巻き添え → 段階を外せば増えるはず
//   3. そもそも画面が変化していない → 何をしても増えない（＝供給を増やす道は無い）
//
// どれなのかで打つ手が変わる（3 なら精度は撮り逃しの検証で確保するしかない）ので、
// 段階と解像度だけを変えた条件を続けて走らせ、同じ場面のまま比較する。
//
// 録画・保存は一切行わない。ライブラリを汚さずに何度でも試せるようにするため。
import { desktopCapturer, globalShortcut, ipcMain } from 'electron'
import { getBrowserWindowRect } from '../capture/capture'
import { screen as electronScreen } from 'electron'
import { getRecorderWindow, isTrustedRecorderSender, setPendingDisplaySource } from './recorder-window'
import { isCurrentlyRecording } from './recording'

const BENCH_HOTKEY = 'Alt+Shift+D'
const BENCH_SECONDS = 5

type BenchStage = 'capture' | 'draw' | 'encode'
type TickerMode = 'visible' | 'faint' | 'invisible'
type BenchVariant = { name: string; stage: BenchStage; maxWidth?: number; maxFrameRate?: number; ticker?: TickerMode }
type BenchResult = {
  name: string
  seconds: number
  frames: number
  distinct: number
  totalVideoFrames: number | null
  width: number
  height: number
  error?: string
}

// 比較する条件。
//
// 第1回の計測（2026-08-01）で、パイプラインの段階（capture / draw / encode）でも解像度
// （1920 / 1280 / 640 幅）でも供給は変わらないことが分かった（36〜43枚/秒に散らばるだけで
// 順序すら安定しない）。つまり上限を決めているのは自分たちの処理でもキャプチャのコストでもなく、
// **画面がそれ以上変化していない**こと。
//
// 一方で、計測時（プレーヤーUIが見えている＝画面の変化が多い）は約40枚/秒、実際の録画時
// （UIを隠している＝変化が少ない）は26〜33枚/秒だった。この差が本当に「画面の変化量」由来なら、
// こちらから画面を変化させれば供給を引き上げられるはず。ticker はそれを試す条件。
// 第2回（2026-08-01）で ticker の効果が確認できた（実運用と同条件で 29.2 → 50.2枚/秒）。
// 残る問題は写り込み: レコーダーウィンドウは画面左上(0,0)に1x1pxで最前面常駐しているため、
// 全画面再生時は切り出し範囲に入り、点滅がそのまま記録に残る。
//
// そこで不透明度だけを変えて比べる。alpha=0（完全に透明）でも供給が増えるなら、キャプチャが
// 反応しているのは「見た目の変化」ではなく「ウィンドウ内容の書き換え」であり、記録に一切
// 写り込まずに供給を増やせる。すべて実運用と同じ encode 段階で測る。
// **2026-08-12：問いが変わったので条件を入れ替えた。**
//
// 旧条件（ティッカーの不透明度 4 段階）はもう答えの出た問いだった。実測すると 4 つとも 50/s で、
// **ティッカー無しでも 50/s 出ている**——2026-08-01 に 29→50 へ引き上げた効果は、今の環境では
// もう見えない（当時と違い画面のリフレッシュレートが 200Hz あり、ティッカーが無くても
// 画面は十分変化している）。つまりティッカーはもう天井を決めていない。
//
// 今の問いは「約 50枚/秒 の天井がどこから来るのか」で、候補は 3 つ：
//
//   1. エンコードの巻き添え  → エンコードを外せば増えるはず
//   2. こちらの要求値        → 要求を 240 に上げれば増える／60 に下げれば減るはず
//   3. キャプチャ API 自体   → 何をしても 50 のまま（＝要求の仕方では解決しない）
//
// **ティッカーは全条件で invisible に固定する**（実際の録画と同じ状態）。変数を 1 つずつに
// するため。旧条件が maxFrameRate を指定しておらず既定の 60 で走っていた点にも注意——
// 実際の録画は 120 を要求しているので、条件が揃っていなかった。
const VARIANTS: BenchVariant[] = [
  { name: 'capture only @120', stage: 'capture', ticker: 'invisible', maxFrameRate: 120 },
  { name: 'capture+encode @120', stage: 'encode', ticker: 'invisible', maxFrameRate: 120 },
  { name: 'capture only @240', stage: 'capture', ticker: 'invisible', maxFrameRate: 240 },
  { name: 'capture only @60', stage: 'capture', ticker: 'invisible', maxFrameRate: 60 },
  { name: 'capture only @120 640w', stage: 'capture', ticker: 'invisible', maxFrameRate: 120, maxWidth: 640 }
]

let running = false

// 録画と同じ画面ソースを預ける（recording.ts と同じ解決方法）。ブラウザの位置が未取得なら
// 先頭の画面で妥協する — 計測なので、どの画面を撮るかより条件を揃える方が大事。
async function resolveScreenSourceId(): Promise<string | null> {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
  const rect = getBrowserWindowRect()
  if (rect) {
    const display = electronScreen.getDisplayNearestPoint({
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2)
    })
    const matched = sources.find((s) => s.display_id === String(display.id))
    if (matched) return matched.id
  }
  return sources[0]?.id ?? null
}

function logResults(results: BenchResult[]): void {
  if (results.length === 0) {
    console.log('[supply-bench] no results (recording in progress?)')
    return
  }
  console.log('[supply-bench] results (frames per second delivered by the capture pipeline):')
  for (const r of results) {
    if (r.error) {
      console.log(`[supply-bench]   ${r.name.padEnd(26)} failed: ${r.error}`)
      continue
    }
    const perSec = r.seconds > 0 ? r.distinct / r.seconds : 0
    console.log(
      `[supply-bench]   ${r.name.padEnd(26)} ${perSec.toFixed(1)}/s` +
      ` (${r.distinct} distinct of ${r.frames} callbacks, element received ${r.totalVideoFrames ?? 'n/a'})` +
      ` at ${r.width}x${r.height}`
    )
  }
  console.log(
    '[supply-bench] read: recording currently gets ~50 frames/s and 60fps sources need ~120.' +
    ' If "capture only" beats "capture+encode", encoding is stealing the frames.' +
    ' If @240 beats @120, our requested frame rate was the cap.' +
    ' If 640w beats full width, capture cost is the cap.' +
    ' If all five land on ~50, the capture API itself is the ceiling and asking differently will not help.'
  )
}

export function registerSupplyBench(): void {
  ipcMain.on('recorder:benchResult', (event, results: BenchResult[]) => {
    if (!isTrustedRecorderSender(event)) return
    running = false
    logResults(Array.isArray(results) ? results : [])
  })

  const ok = globalShortcut.register(BENCH_HOTKEY, async () => {
    if (running) { console.log('[supply-bench] already running'); return }
    if (isCurrentlyRecording()) { console.log('[supply-bench] skipped: recording in progress'); return }
    const win = getRecorderWindow()
    if (!win || win.isDestroyed()) { console.warn('[supply-bench] recorder window is not available'); return }
    const sourceId = await resolveScreenSourceId()
    if (!sourceId) { console.warn('[supply-bench] no screen source found'); return }
    setPendingDisplaySource(sourceId)
    running = true
    console.log(
      `[supply-bench] running ${VARIANTS.length} variants x ${BENCH_SECONDS}s.` +
      ' Keep the video playing until the results appear.'
    )
    win.webContents.send('recorder:bench', { variants: VARIANTS, seconds: BENCH_SECONDS })
  })
  if (!ok) console.warn(`[supply-bench] hotkey ${BENCH_HOTKEY} registration failed`)
  else console.log(`[supply-bench] press ${BENCH_HOTKEY} while a video is playing to measure the capture supply`)
}
