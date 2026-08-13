import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

// extension/content.js のコマ送り判定部（initialFrameStep / planFrameStep）の回帰テスト。
// content.js はバンドラ無しで配布される素の content script なので import できない。
// extension-parity.test.ts と同じく、テキストとして読み込み該当関数だけを取り出して評価する。
// 判定部は DOM に触らない純粋関数として切ってあるため、これで素材の fps を変えながら
// 「1ステップ＝ちょうど1コマ」を検証できる。
const contentJs = readFileSync(join(__dirname, '../../../../extension/content.js'), 'utf-8')

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`function not found in extension source: ${name}`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error(`unbalanced braces in extension source: ${name}`)
}

type Step = {
  dir: number, base: number, dur: number, exact: boolean,
  resolving: boolean, seeded: boolean, offset: number, attempt: number, target: number | null
}
type Verdict = { done: boolean, frameDur: number | null, next?: Step }

const constLines = contentJs.match(/^const STEP_[A-Z0-9_]+ = [^\n]+$/gm)
if (!constLines || constLines.length < 6) throw new Error('STEP_* constants not found in extension source')

// 自プロジェクトのソースを読むだけで外部入力は含まないため Function での評価は許容する。
// eslint-disable-next-line no-new-func
const api = Function(`"use strict";
${constLines.join('\n')}
${extractFunction(contentJs, 'initialFrameStep')}
${extractFunction(contentJs, 'planFrameStep')}
return { initialFrameStep, planFrameStep, STEP_MAX_ATTEMPTS }
`)() as {
  initialFrameStep: (dir: number, base: number, dur: number, exact: boolean) => Step
  planFrameStep: (step: Step, landed: number | null) => Verdict
  STEP_MAX_ATTEMPTS: number
}

/** 素材のコマ先頭時刻の列。cfr(1/24) なら 0, 41.7ms, 83.3ms, … */
function cfr(fps: number, count = 60): number[] {
  return Array.from({ length: count }, (_, i) => i / fps)
}

/** シーク先 t が属するコマの先頭を返す（ブラウザの「t を含むコマを表示する」挙動のモデル）。 */
function landOn(starts: number[], t: number): number {
  const clamped = Math.max(0, t)
  let hit = starts[0]
  for (const s of starts) if (s <= clamped + 1e-9) hit = s
  return hit
}

/**
 * 1ステップぶんを最後まで回し、着地したコマの番号・シーク回数・実測できたコマ長を返す。
 * content.js の runStepAttempt と同じ順序で initialFrameStep → planFrameStep を回す。
 * baseOffset は「基準が実コマの先頭ではない」状況（外部シーク直後など）の再現。
 */
function runStep(
  starts: number[],
  fromIdx: number,
  dir: 1 | -1,
  durHint: number,
  baseOffset = 0
) {
  const base = starts[fromIdx] + baseOffset
  let step = api.initialFrameStep(dir, base, durHint, baseOffset === 0)
  let seeks = 0
  let frameDur: number | null = null
  let landed = base
  for (;;) {
    seeks++
    if (seeks > 60) throw new Error('コマ送りが収束しない（無限ループ）')
    landed = landOn(starts, step.base + step.offset)
    const verdict = api.planFrameStep(step, landed)
    if (verdict.frameDur !== null) frameDur = verdict.frameDur
    if (verdict.done) break
    step = verdict.next!
  }
  return { landedIdx: starts.indexOf(landed), seeks, frameDur }
}

const hint = (fps: number) => 1 / fps

describe('拡張のコマ送り（extension/content.js の判定部）', () => {
  it('見積もりが素材と合っていれば少ないシークでちょうど1コマ動く', () => {
    for (const fps of [24, 23.976, 30, 60, 120]) {
      const starts = cfr(fps)
      const forward = runStep(starts, 10, 1, hint(fps))
      expect(forward.landedIdx).toBe(11)
      expect(forward.seeks).toBeLessThanOrEqual(2)
      const back = runStep(starts, 10, -1, hint(fps))
      expect(back.landedIdx).toBe(9)
      expect(back.seeks).toBe(1)
    }
  })

  it('見積もりが実際より大きくてもコマを飛ばさない（24fps見積もりで60fps素材）', () => {
    const starts = cfr(60)
    // 旧実装の「見積もりの1.5倍先へ一発シーク」なら3コマ飛んでいた。しかも着地は狙い以内に
    // 収まるため、着地値と見積もりを比べるだけでは飛んだことを検出できない
    expect(starts.indexOf(landOn(starts, starts[10] + hint(24) * 1.5))).toBe(13)

    const forward = runStep(starts, 10, 1, hint(24))
    expect(forward.landedIdx).toBe(11)
    // 下から詰めた着地は隣のコマだと確定するので、そのままコマ長の実測値になる
    expect(forward.frameDur).toBeCloseTo(1 / 60, 9)
  })

  it('見積もりが実際より小さくて動けなくても1コマ進む（60fps見積もりで24fps素材）', () => {
    const result = runStep(cfr(24), 10, 1, hint(60))
    expect(result.landedIdx).toBe(11)
    expect(result.frameDur).toBeCloseTo(1 / 24, 9)
  })

  it('後退は素材の fps を知らなくても1回のシークで1コマ戻る', () => {
    for (const fps of [24, 60, 120]) {
      const back = runStep(cfr(fps), 10, -1, hint(24))
      expect(back).toMatchObject({ landedIdx: 9, seeks: 1 })
      expect(back.frameDur).toBeCloseTo(1 / fps, 9)
    }
  })

  it('どの見積もりでも前後1コマに着地する（総当たり）', () => {
    for (const fps of [12, 15, 23.976, 24, 25, 30, 50, 59.94, 60, 100, 120]) {
      const starts = cfr(fps, 40)
      for (const hintFps of [1, 10, 24, 30, 60, 120, 240]) {
        expect(runStep(starts, 20, 1, hint(hintFps)).landedIdx).toBe(21)
        expect(runStep(starts, 20, -1, hint(hintFps)).landedIdx).toBe(19)
      }
    }
  })

  it('可変フレームレート素材（コマ長が倍になる箇所）でも1コマだけ動く', () => {
    // 10番目のコマだけ 2 倍の長さ。中央値ベースの見積もりでは局所的に外れる
    const starts = [0]
    for (let i = 1; i < 30; i++) starts.push(starts[i - 1] + (i === 10 ? 2 / 24 : 1 / 24))
    expect(runStep(starts, 10, 1, hint(24)).landedIdx).toBe(11)
    expect(runStep(starts, 9, 1, hint(24)).landedIdx).toBe(10)
    expect(runStep(starts, 11, -1, hint(24)).landedIdx).toBe(10)
  })

  it('基準が実コマの先頭でないとき（外部シーク直後）は先頭を確定させてから1コマ動く', () => {
    const starts = cfr(24)
    for (const fps of [24, 60]) {
      const material = cfr(fps)
      expect(runStep(material, 10, 1, hint(24), 0.008).landedIdx).toBe(11)
      expect(runStep(material, 10, -1, hint(24), 0.008).landedIdx).toBe(9)
    }
    // 基準の確定に1シーク余分にかかる（通常経路より1回多い）
    expect(runStep(starts, 10, -1, hint(24), 0.008).seeks).toBe(2)
  })

  it('基準を確定できなかった（rVFC が発火しなかった）ときはコマ長として採用しない', () => {
    const step = api.initialFrameStep(-1, 0.5, hint(24), false)
    const verdict = api.planFrameStep(step, null)
    expect(verdict.done).toBe(false)
    expect(verdict.next!.exact).toBe(false)
    expect(verdict.next!.resolving).toBe(false)
    expect(api.planFrameStep(verdict.next!, 0.4).frameDur).toBeNull()
  })

  it('動かない素材・尺の端でも試行回数の上限で必ず終わる', () => {
    // 対応下限(10fps)より粗い 5fps 素材。どこまで伸ばしても隣へ届かない
    const result = runStep(cfr(5), 10, 1, hint(24))
    expect(result.landedIdx).toBe(10)
    expect(result.seeks).toBeLessThanOrEqual(api.STEP_MAX_ATTEMPTS)
  })
})
