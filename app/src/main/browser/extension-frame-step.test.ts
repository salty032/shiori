import { describe, expect, it } from 'vitest'
import { contentJs, extractFunction } from './extension-source'

// extension/content.js のコマ送り判定部（initialFrameStep / planFrameStep）の回帰テスト。
// 読み込みと切り出しは extension-source.ts（content.js は import できないため）。
// 判定部は DOM に触らない純粋関数として切ってあるため、これで素材の fps を変えながら
// 「1ステップ＝ちょうど1コマ」を検証できる。

type Step = {
  dir: number, base: number, dur: number, seedDur: number | null, exact: boolean,
  resolving: boolean, seeded: boolean, offset: number, attempt: number, target: number | null
}
type Verdict = { done: boolean, frameDur: number | null, next?: Step }

const constLines = contentJs.match(/^const STEP_[A-Z0-9_]+ = [^\n]+$/gm)
if (!constLines || constLines.length < 6) throw new Error('STEP_* constants not found in extension source')

// 自プロジェクトのソースを読むだけで外部入力は含まないため Function での評価は許容する。
const api = Function(`"use strict";
${constLines.join('\n')}
${extractFunction(contentJs, 'initialFrameStep')}
${extractFunction(contentJs, 'planFrameStep')}
return { initialFrameStep, planFrameStep, STEP_MAX_ATTEMPTS }
`)() as {
  initialFrameStep: (dir: number, base: number, dur: number, exact: boolean, seedDur: number | null) => Step
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
 * seedDur は近道の置き場所（実測されたコマ長。無ければ null＝近道を使わない）。
 *
 * shown は**途中でブラウザが表示するコマの番号**。着地が正しくても途中で行き過ぎた絵が
 * 出れば画面では「進む→戻る」に見えるので、結果だけでなくここも見る。
 */
function runStep(
  starts: number[],
  fromIdx: number,
  dir: 1 | -1,
  durHint: number,
  baseOffset = 0,
  seedDur: number | null = durHint
) {
  const base = starts[fromIdx] + baseOffset
  let step = api.initialFrameStep(dir, base, durHint, baseOffset === 0, seedDur)
  let seeks = 0
  let frameDur: number | null = null
  let landed = base
  const shown: number[] = []
  for (;;) {
    seeks++
    if (seeks > 60) throw new Error('コマ送りが収束しない（無限ループ）')
    landed = landOn(starts, step.base + step.offset)
    shown.push(starts.indexOf(landed))
    const verdict = api.planFrameStep(step, landed)
    if (verdict.frameDur !== null) frameDur = verdict.frameDur
    if (verdict.done) break
    step = verdict.next!
  }
  return { landedIdx: starts.indexOf(landed), seeks, frameDur, shown }
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

  it('実測が無いうちは前進も最小刻みから詰める（途中で行き過ぎた絵を出さない）', () => {
    // 近道を推定（1/settingsFps）から置くと、素材のコマ長より長いときに初手が次のコマへ入る。
    // 着地の検証で捨てるので1手＝1コマは保たれるが、**捨てる前の絵が画面に出てしまい**
    // 「進む→戻る→また進む」に見える（YouTube の 30/60fps 素材で毎手これが起きていた）。
    for (const fps of [24, 23.976, 30, 59.94, 60]) {
      const starts = cfr(fps)
      const forward = runStep(starts, 10, 1, hint(24), 0, null)
      expect(forward.landedIdx).toBe(11)
      // 画面に出るのは基準のコマか目的地だけ（行き過ぎも戻りもしない）
      expect([...new Set(forward.shown)].sort()).toEqual([10, 11])
      // 下から詰めた着地は隣のコマだと確定するので、そのままコマ長の実測値になる
      expect(forward.frameDur).toBeCloseTo(1 / fps, 6)
    }
  })

  it('実測があれば近道を使い、前進は2回のシークで済む', () => {
    // 1手目の探索で確定した実測コマ長が次の手の近道になる（実測が入れば元の速さに戻る）。
    for (const fps of [24, 30, 60]) {
      const starts = cfr(fps)
      const measured = runStep(starts, 10, 1, hint(24), 0, null).frameDur
      const next = runStep(starts, 11, 1, hint(24), 0, measured)
      expect(next).toMatchObject({ landedIdx: 12, seeks: 2 })
      expect([...new Set(next.shown)].sort()).toEqual([11, 12])
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
        // 近道あり（実測が外れている場合も含む）／近道なし（実測がまだ無い）の両方
        for (const seed of [hint(hintFps), null]) {
          expect(runStep(starts, 20, 1, hint(hintFps), 0, seed).landedIdx).toBe(21)
          expect(runStep(starts, 20, -1, hint(hintFps), 0, seed).landedIdx).toBe(19)
        }
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
    const step = api.initialFrameStep(-1, 0.5, hint(24), false, null)
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
