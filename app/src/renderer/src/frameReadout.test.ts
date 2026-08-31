import { describe, expect, it } from 'vitest'
import { FRAME_QUALITY, type ClipFrames, type ClipGap } from '../../shared/api.video'
import {
  buildGapIndex, frameReadout, sourceFrameNo, walkFrames, FRAME_COLOR,
} from './frameReadout'

// 文言そのものではなく「どのキーがどの値で選ばれたか」を見る。訳文を変えてもテストは
// 落ちないが、出し分けを間違えれば落ちる。
const tr = ((key: string, params?: Record<string, string>) =>
  params ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})` : key) as never

function gap(afterIndex: number, missing: number, animeMissing?: number): ClipGap {
  return { afterIndex, missing, measured: true, ...(animeMissing != null ? { animeMissing } : {}) }
}

function frames(over: Partial<ClipFrames> = {}): ClipFrames {
  const pts = over.pts ?? [0, 0.04, 0.08, 0.12]
  return {
    pts,
    sourceBased: true,
    quality: over.quality ?? pts.map(() => FRAME_QUALITY.captured),
    gaps: over.gaps,
    ...over,
  }
}

describe('buildGapIndex - 抜けの積み上げ', () => {
  it('抜けが無ければ積み上げは全部 0 で、母数は行数と同じ', () => {
    const idx = buildGapIndex(frames())
    expect(idx.gapBefore).toEqual([0, 0, 0, 0])
    expect(idx.totalWithGaps).toBe(4)
  })

  // 行 1 の後ろに 2 コマ抜けていれば、行 2 以降の番号は 2 つ先へずれる。
  it('抜けの後ろの行は、抜けたぶんだけ番号が進む', () => {
    const idx = buildGapIndex(frames({ gaps: [gap(1, 3, 2)] }))
    expect(idx.gapBefore).toEqual([0, 0, 2, 2])
    expect(idx.totalWithGaps).toBe(6)
  })

  // **通知欠落数（missing）とアニメの抜け（animeMissing）を混ぜない**（FRAME-GAPS.md 0 章）。
  // 番号に使うのは animeMissing だけ。
  it('推定できなかった抜けは 0 コマ扱いで、known が false になる', () => {
    const idx = buildGapIndex(frames({ gaps: [gap(1, 3)] }))
    expect(idx.gapBefore).toEqual([0, 0, 0, 0])
    expect(idx.totalWithGaps).toBe(4)
    expect(idx.gaps.get(1)).toEqual({ missing: 0, technicalMissing: 3, known: false })
  })

  it('コマ表が無ければ空の索引を返す', () => {
    expect(buildGapIndex(null)).toEqual({ gaps: new Map(), gapBefore: [], totalWithGaps: 0 })
  })
})

describe('sourceFrameNo - 画面に出すコマ番号', () => {
  it('番号は 1 始まり', () => expect(sourceFrameNo(0, [0, 0, 0])).toBe(1))

  // ここが詰まると「同じコマなのにビューアとタイムシートで違う番号」になる（2026-08-31）。
  it('抜けたコマも 1 コマとして数える', () => expect(sourceFrameNo(2, [0, 0, 2])).toBe(5))

  it('抜けの中に居るぶんも足す', () => expect(sourceFrameNo(1, [0, 0, 2], 2)).toBe(4))
})

describe('walkFrames - 実測行と推定した抜けをまたいで歩く', () => {
  // 行 1 の後ろに 2 コマ抜け。1 → (抜け1) → (抜け2) → 2 の順で進む。
  const missingAfter = (i: number): number => (i === 1 ? 2 : 0)

  it('抜けの中を 1 コマずつ通ってから次の行へ移る', () => {
    expect(walkFrames(1, 0, 1, 4, missingAfter)).toEqual({ idx: 1, gap: 1 })
    expect(walkFrames(1, 1, 1, 4, missingAfter)).toEqual({ idx: 1, gap: 2 })
    expect(walkFrames(1, 2, 1, 4, missingAfter)).toEqual({ idx: 2, gap: 0 })
  })

  it('戻るときは次の行から抜けの最後に入る', () => {
    expect(walkFrames(2, 0, -1, 4, missingAfter)).toEqual({ idx: 1, gap: 2 })
    expect(walkFrames(1, 2, -1, 4, missingAfter)).toEqual({ idx: 1, gap: 1 })
    expect(walkFrames(1, 1, -1, 4, missingAfter)).toEqual({ idx: 1, gap: 0 })
  })

  // 「1 つずつ、飛ばさず・戻らず」（ANIME-FRAMES.md 3 章）。まとめて送っても
  // 1 コマずつ送ったのと同じ場所に着く。
  it('まとめて送っても 1 コマずつ送ったのと同じ場所に着く', () => {
    expect(walkFrames(1, 0, 3, 4, missingAfter)).toEqual({ idx: 2, gap: 0 })
    expect(walkFrames(2, 0, -3, 4, missingAfter)).toEqual({ idx: 1, gap: 0 })
  })

  it('端では止まる（先頭より前・末尾より先へは行かない）', () => {
    expect(walkFrames(0, 0, -5, 4, missingAfter)).toEqual({ idx: 0, gap: 0 })
    expect(walkFrames(3, 0, 5, 4, missingAfter)).toEqual({ idx: 3, gap: 0 })
  })

  it('動かさなければ位置は変わらない', () => {
    expect(walkFrames(1, 1, 0, 4, missingAfter)).toEqual({ idx: 1, gap: 1 })
  })
})

describe('frameReadout - 何を出すか', () => {
  const base = {
    idx: 0,
    gap: 0,
    frames: frames(),
    index: buildGapIndex(frames()),
    unreliable: false,
    uncapturedSevere: false,
    estimatedFps: 24,
  }

  // 読み込み中と fps 換算は「コマ単位で何も言えない」状態。**ここでタイムシートへ位置を
  // 知らせると、実測でない番号が行として通ってしまう。**
  it('読み込み中は位置を知らせない', () => {
    const out = frameReadout({ ...base, kind: 'loading' }, tr)
    expect(out?.cur).toBeNull()
    expect(out?.text).toBe('viewer.frameLoading')
    expect(out?.color).toBe(FRAME_COLOR.muted)
  })

  it('fps 換算のときは位置を知らせず、刻みの fps を出す', () => {
    const out = frameReadout({ ...base, kind: 'estimated', estimatedFps: 30 }, tr)
    expect(out?.cur).toBeNull()
    expect(out?.text).toBe('viewer.frameEstimated(fps=30)')
    expect(out?.color).toBe(FRAME_COLOR.warn)
  })

  it('コマ表が無ければ表示を書き換えない（null を返す）', () => {
    expect(frameReadout({ ...base, kind: 'source', frames: null }, tr)).toBeNull()
    expect(frameReadout({ ...base, kind: 'source', frames: frames({ pts: [] }) }, tr)).toBeNull()
  })

  // 録画クリップのファイルのフレームは画面キャプチャの供給レートの産物で、素材のコマとは
  // 対応しない。**取り込み動画と同じ顔で出してはいけない。**
  it('表が無い録画クリップは、素材のコマではないと分かる出し方にする', () => {
    const out = frameReadout({ ...base, kind: 'file', clipSource: 'clip' }, tr)
    expect(out?.text).toBe('viewer.frameIndexFile(cur=1,total=4)')
    expect(out?.color).toBe(FRAME_COLOR.warn)
  })

  it('取り込み動画のファイルのフレームは素材のコマなので、そのまま出す', () => {
    const out = frameReadout({ ...base, kind: 'file', clipSource: 'import' }, tr)
    expect(out?.text).toBe('viewer.frameIndex(cur=1,total=4)')
    expect(out?.color).toBe(FRAME_COLOR.ok)
  })

  it('問題が無いコマは番号だけを出す（注記を足さない）', () => {
    const out = frameReadout({ ...base, kind: 'source', idx: 1 }, tr)
    expect(out?.text).toBe('viewer.frameIndex(cur=2,total=4)')
    expect(out?.color).toBe(FRAME_COLOR.ok)
  })

  // 抜けの中は録画画像が無く、映像は手前の行のまま。**番号だけ進めることを黙らせない。**
  it('推定した抜けの中に居ることを、常に添えて出す', () => {
    const f = frames({ gaps: [gap(1, 3, 2)] })
    const out = frameReadout({ ...base, kind: 'source', frames: f, index: buildGapIndex(f), idx: 1, gap: 1 }, tr)
    expect(out?.text).toBe('viewer.frameIndex(cur=3,total=6) · viewer.frameInGapEstimated')
    expect(out?.color).toBe(FRAME_COLOR.warn)
  })

  it('未取得のコマには注記を添える', () => {
    const f = frames({ quality: [FRAME_QUALITY.captured, FRAME_QUALITY.reused, FRAME_QUALITY.captured, FRAME_QUALITY.captured] })
    const out = frameReadout({ ...base, kind: 'source', frames: f, index: buildGapIndex(f), idx: 1 }, tr)
    expect(out?.text).toBe('viewer.frameIndex(cur=2,total=4) · viewer.frameNeedsReview')
    expect(out?.color).toBe(FRAME_COLOR.warn)
  })

  // 未取得は「そのクリップで多いとき」だけ赤へ上げる（詳細パネルと同じ 5%）。
  it('未取得が多いクリップでは、未取得のコマを赤にする', () => {
    const f = frames({ quality: [FRAME_QUALITY.captured, FRAME_QUALITY.reused, FRAME_QUALITY.captured, FRAME_QUALITY.captured] })
    const out = frameReadout({ ...base, kind: 'source', frames: f, index: buildGapIndex(f), idx: 1, uncapturedSevere: true }, tr)
    expect(out?.color).toBe(FRAME_COLOR.alert)
  })

  it('枚数を推定できなかった抜けの手前では「未確認」と出す', () => {
    const f = frames({ gaps: [gap(1, 3)] })
    const out = frameReadout({ ...base, kind: 'source', frames: f, index: buildGapIndex(f), idx: 1 }, tr)
    expect(out?.text).toBe('viewer.frameIndex(cur=2,total=4) · viewer.frameGapUnknown')
    expect(out?.title).toBe('viewer.frameGapUnknownHint(count=3)')
    expect(out?.color).toBe(FRAME_COLOR.warn)
  })

  it('抜けの手前では、この先何コマ抜けるかを出す', () => {
    const f = frames({ gaps: [gap(1, 3, 2)] })
    const out = frameReadout({ ...base, kind: 'source', frames: f, index: buildGapIndex(f), idx: 1 }, tr)
    expect(out?.text).toBe('viewer.frameIndex(cur=2,total=6) · viewer.frameGapAfterEstimated(count=2)')
  })

  // 注記は重ねない。**重いものが 1 つだけ出る**（並べると判断が変わらないのに読む量だけ増える）。
  describe('注記が重なったら重い方だけを出す', () => {
    const f = frames({
      quality: [FRAME_QUALITY.captured, FRAME_QUALITY.reused, FRAME_QUALITY.captured, FRAME_QUALITY.captured],
      gaps: [gap(1, 3, 2)],
    })
    const at = (over: Record<string, unknown>) =>
      frameReadout({ ...base, kind: 'source', frames: f, index: buildGapIndex(f), idx: 1, ...over }, tr)

    it('クリップ全体が当てにならないなら、それだけを赤で出す', () => {
      const out = at({ unreliable: true })
      expect(out?.text).toBe('viewer.frameIndex(cur=2,total=6) · viewer.frameUnreliable')
      expect(out?.color).toBe(FRAME_COLOR.alert)
    })

    it('全体が無事なら、抜けが未取得より先に出る', () => {
      expect(at({})?.text).toBe('viewer.frameIndex(cur=2,total=6) · viewer.frameGapAfterEstimated(count=2)')
    })
  })

  it('添字が範囲の外でも端に丸める', () => {
    expect(frameReadout({ ...base, kind: 'source', idx: 99 }, tr)?.cur).toBe(3)
    expect(frameReadout({ ...base, kind: 'source', idx: -5 }, tr)?.cur).toBe(0)
  })
})
