import { describe, expect, it } from 'vitest'
import {
  buildToeiClipboard,
  canBuildTimesheet,
  countReusedFrames,
  decodeTimesheet,
  encodeTimesheet,
  expandMarks,
  GAP_ROW,
  normalizeTimesheetValue,
  requiredSheetLength,
  timesheetGlyph,
  timesheetLabels,
  timesheetRows,
  TOEI_SYMBOL,
  TOEI_CLIPBOARD_HEADER,
  TOEI_FRAME_BASE,
  type TimesheetMark
} from './timesheet'
import { FRAME_QUALITY, type ClipFrames, type FrameQuality } from './api.video'

// 打鍵（動画番号は打っていない＝通し番号が振られる）。
const at = (...frames: number[]): TimesheetMark[] => frames.map((frame) => ({ frame }))

function clip(quality: FrameQuality[], sourceBased = true): ClipFrames {
  return { pts: quality.map((_, i) => i / 24), sourceBased, quality }
}
const captured = (n: number): FrameQuality[] => Array.from({ length: n }, () => FRAME_QUALITY.captured)

// 貼り付け先が受け取る形は実測でしか分かっていない（docs/TIMESHEET.md 2-6）。
// 「読めるが黙って別の場所に入る」が一番怖い壊れ方なので、値そのものを固定する。
function parse(text: string): { fieldId: number; layers: { frames: { data: unknown[]; frame: number }[]; inlineNo: number; trackNo: number }[] } {
  const nl = text.indexOf('\n')
  return JSON.parse(text.slice(nl + 1))
}
const hasValue = (f: { data: unknown[] }): boolean => 'values' in (f.data[0] as object)
const valueOf = (f: { data: unknown[] }): string => (f.data[0] as { values: string[] }).values[0]

describe('buildToeiClipboard', () => {
  it('1 行目は固定文字列で、2 行目から JSON', () => {
    const text = buildToeiClipboard(at(0), 1)
    expect(text.split('\n')[0]).toBe(TOEI_CLIPBOARD_HEADER)
    expect(text.split('\n')[0]).toBe('toeiDigitalTimeSheet Copy Data')
    expect(() => parse(text)).not.toThrow()
  })

  // 実機のコピーは字下げ 4・この項目順で出てくる。後から実物と目視で突き合わせられるよう、
  // 整形まで含めて 1 コマぶんを丸ごと固定する。
  it('字下げと項目の順番まで実機のコピーと同じ', () => {
    expect(buildToeiClipboard(at(0), 1)).toBe(
      [
        'toeiDigitalTimeSheet Copy Data',
        '{',
        '    "fieldId": 4,',
        '    "layers": [',
        '        {',
        '            "frames": [',
        '                {',
        '                    "data": [',
        '                        {',
        '                            "fontColorId": 0,',
        '                            "id": 0,',
        '                            "values": [',
        '                                "1"',
        '                            ]',
        '                        }',
        '                    ],',
        '                    "frame": 24',
        '                }',
        '            ],',
        '            "inlineNo": 0,',
        '            "trackNo": 0',
        '        }',
        '    ]',
        '}',
        ''
      ].join('\n')
    )
  })

  it('実機で採ったサンプルと同じ形になる（12 コマ・1/2/3/4 が 0,2,6,8 コマ目）', () => {
    expect(parse(buildToeiClipboard(at(0, 2, 6, 8), 12))).toEqual({
      fieldId: 4,
      layers: [
        {
          frames: [
            { data: [{ fontColorId: 0, id: 0, values: ['1'] }], frame: 24 },
            { data: [{ id: 0 }], frame: 25 },
            { data: [{ fontColorId: 0, id: 0, values: ['2'] }], frame: 26 },
            { data: [{ id: 0 }], frame: 27 },
            { data: [{ id: 0 }], frame: 28 },
            { data: [{ id: 0 }], frame: 29 },
            { data: [{ fontColorId: 0, id: 0, values: ['3'] }], frame: 30 },
            { data: [{ id: 0 }], frame: 31 },
            { data: [{ fontColorId: 0, id: 0, values: ['4'] }], frame: 32 },
            { data: [{ id: 0 }], frame: 33 },
            { data: [{ id: 0 }], frame: 34 },
            { data: [{ id: 0 }], frame: 35 }
          ],
          inlineNo: 0,
          trackNo: 0
        }
      ]
    })
  })

  // fieldId / trackNo は貼り付け先を決めない（貼る前に選んでいるマスで決まる）。
  // 実測サンプルと突き合わせられるよう値を固定するだけで、意味は持たせない。
  it('fieldId / trackNo は実測サンプルどおり固定で出す', () => {
    const body = parse(buildToeiClipboard(at(), 1))
    expect(body.fieldId).toBe(4)
    expect(body.layers[0].trackNo).toBe(0)
    expect(body.layers[0].inlineNo).toBe(0)
  })

  it('frame は 0 起点ではなく 24 起点の連番', () => {
    const frames = parse(buildToeiClipboard(at(), 5)).layers[0].frames
    expect(TOEI_FRAME_BASE).toBe(24)
    expect(frames.map((f) => f.frame)).toEqual([24, 25, 26, 27, 28])
  })

  it('範囲内の全コマがエントリを持つ（絵が続くコマも省かない）', () => {
    const frames = parse(buildToeiClipboard(at(0), 700)).layers[0].frames
    expect(frames).toHaveLength(700)
    expect(frames.filter(hasValue)).toHaveLength(1)
  })

  it('番号を打っていなければ上から通し番号を振る', () => {
    const frames = parse(buildToeiClipboard(at(8, 0, 4), 12)).layers[0].frames
    const numbered = frames.filter(hasValue)
    expect(numbered.map((f) => f.frame)).toEqual([24, 28, 32])
    expect(numbered.map(valueOf)).toEqual(['1', '2', '3'])
  })

  // 東映側は動画番号を人が打つ（原画から引き継ぐと連番にならない）。打った番号は
  // そのまま出し、打っていないところだけ通し番号で埋める。
  it('打った動画番号はそのまま出す。混ざっていても打った方を優先する', () => {
    const frames = parse(buildToeiClipboard([{ frame: 0, value: '12' }, { frame: 3 }, { frame: 6, value: '14A' }], 9)).layers[0].frames
    expect(frames.filter(hasValue).map(valueOf)).toEqual(['12', '2', '14A'])
  })

  it('同じコマを重ねて打っても番号は 1 つ', () => {
    const frames = parse(buildToeiClipboard(at(3, 3, 3), 6)).layers[0].frames
    expect(frames.filter(hasValue)).toHaveLength(1)
  })

  it('範囲の外・整数でない指定は落とす（コマ数だけは必ず total と一致させる）', () => {
    const frames = parse(buildToeiClipboard(at(-1, 3, 99, 1.5), 5)).layers[0].frames
    expect(frames).toHaveLength(5)
    expect(frames.filter(hasValue).map((f) => f.frame)).toEqual([27])
  })

  it('打っていなければ番号は 1 つも出ない', () => {
    const frames = parse(buildToeiClipboard(at(), 3)).layers[0].frames
    expect(frames).toHaveLength(3)
    expect(frames.every((f) => !hasValue(f))).toBe(true)
  })
})

describe('canBuildTimesheet', () => {
  // ここが緩むと「保証できないものを保証できる顔で渡す」に直結する。
  it('素材のコマ単位で、全コマ撮れているクリップでだけ出す', () => {
    expect(canBuildTimesheet(clip(captured(100)), 24)).toBe(true)
  })

  it('素材 fps が未確定なら、全コマ撮れていても出さない', () => {
    const frames = clip(captured(100))
    expect(canBuildTimesheet(frames, null)).toBe(false)
    expect(canBuildTimesheet(frames, undefined)).toBe(false)
    expect(canBuildTimesheet(frames, 0)).toBe(false)
    expect(canBuildTimesheet(frames, Number.NaN)).toBe(false)
  })

  // **流用は番号を壊さない。** 表に行はあり、素材のコマとの対応も保たれていて、出ている絵が
  // 直前と同じになるだけ。1 コマで止めていた頃は、壊れていないものまで止めていた。
  it('数コマの流用では止めない（番号はずれていない）', () => {
    const q = captured(100)
    q[42] = FRAME_QUALITY.reused
    q[7] = FRAME_QUALITY.reused
    expect(canBuildTimesheet(clip(q), 24)).toBe(true)
  })

  it('流用がコマ送りの赤と同じ割合を超えたら出さない', () => {
    const q = captured(100)
    for (let i = 0; i < 5; i++) q[i] = FRAME_QUALITY.reused
    // ちょうど 5%（100 コマ中 5 コマ）は許す。赤くならない側と一致させる。
    expect(canBuildTimesheet(clip(q), 24)).toBe(true)
    q[5] = FRAME_QUALITY.reused
    expect(canBuildTimesheet(clip(q), 24)).toBe(false)
  })

  // 供給（実測 51枚/秒）が 60 コマに足りず、流用が常時 11〜17% 出る。
  it('60fps 素材は従来どおり外れる（流用が割合を超えるため）', () => {
    const q = captured(100)
    for (let i = 0; i < 15; i++) q[i * 6] = FRAME_QUALITY.reused
    expect(canBuildTimesheet(clip(q), 59.94)).toBe(false)
  })

  // 流用より重い。出ている絵が何なのか分からない＝打った位置がどのコマかも決められない。
  it('対応崩れは 1 コマでもあれば出さない（割合で見ない）', () => {
    const q = captured(100)
    q[42] = FRAME_QUALITY.misaligned
    expect(canBuildTimesheet(clip(q), 24)).toBe(false)
  })

  it('表が無い・素材のコマ単位でないクリップでは出さない', () => {
    expect(canBuildTimesheet(null, 24)).toBe(false)
    expect(canBuildTimesheet(undefined, 24)).toBe(false)
    expect(canBuildTimesheet(clip([], true), 24)).toBe(false)
    expect(canBuildTimesheet(clip(captured(100), false), 24)).toBe(false)
  })

  it('コマごとの確からしさが欠けていたら出さない（分からない＝保証できない）', () => {
    expect(canBuildTimesheet({ pts: [0, 1, 2], sourceBased: true, quality: [] }, 24)).toBe(false)
    expect(canBuildTimesheet({ pts: [0, 1, 2], sourceBased: true, quality: captured(2) }, 24)).toBe(false)
  })

  // 抜けは、その位置に空のコマを差し込んで出す（timesheetRows）。場所も枚数も分かって
  // いるので番号は元の動画と一致する。**quality には現れない**（抜けたコマは表に行が
  // 無いので、残った行はすべて captured のまま）ため、gaps を直に見る必要がある。
  it('少しの抜けなら出す（差し込んで番号を合わせる）', () => {
    const frames = {
      ...clip(captured(100)), gaps: [{ afterIndex: 42, missing: 2, measured: false, animeMissing: 1 }]
    }
    expect(frames.quality.every((q) => q === FRAME_QUALITY.captured)).toBe(true)
    expect(canBuildTimesheet(frames, 24)).toBe(true)
  })

  // 抜けた枚数は推定値なので、多いほど並び全体が信用できない。線は撮り逃しと同じ割合・
  // 同じ定数で引く（詳細パネルが「要注意」を出す条件と揃える）。
  it('抜けが多すぎるものは出さない', () => {
    const many = {
      ...clip(captured(100)), gaps: [{ afterIndex: 10, missing: 41, measured: false, animeMissing: 40 }]
    }
    expect(canBuildTimesheet(many, 24)).toBe(false)
  })

  it('通知欠落数しか分からない区間では、正しい行数を作れないので出さない', () => {
    const unresolved = { ...clip(captured(100)), gaps: [{ afterIndex: 42, missing: 3, measured: false }] }
    expect(canBuildTimesheet(unresolved, 24)).toBe(false)
  })

  it('流用の数は数えるが、それ自体は可否を決めない', () => {
    const q = captured(100)
    q[3] = FRAME_QUALITY.reused
    q[9] = FRAME_QUALITY.reused
    expect(countReusedFrames(clip(q))).toBe(2)
    expect(countReusedFrames(clip(captured(100)))).toBe(0)
    expect(countReusedFrames(null)).toBe(0)
  })

  it('gaps が空・未定義なら従来どおり出す', () => {
    expect(canBuildTimesheet({ ...clip(captured(100)), gaps: [] }, 24)).toBe(true)
    expect(canBuildTimesheet(clip(captured(100)), 24)).toBe(true)
  })
})

describe('timesheetLabels', () => {
  it('打った番号を優先し、無ければ上から数えた通し番号', () => {
    expect(timesheetLabels([{ frame: 0 }, { frame: 4, value: '7' }, { frame: 9 }])).toEqual(['1', '7', '3'])
  })
})

describe('normalizeTimesheetValue', () => {
  it('半角英数字だけ残す（東映側の入力に合わせる）', () => {
    expect(normalizeTimesheetValue('12A')).toBe('12A')
    expect(normalizeTimesheetValue('あ1-2 ')).toBe('12')
  })

  it('長すぎる入力は切る', () => {
    expect(normalizeTimesheetValue('123456789012')).toHaveLength(8)
  })

  // 記号はアンダースコアを含む決まった綴り。英数字だけ残す規則に巻き込むと崩れる。
  it('記号の綴りはそのまま通す', () => {
    expect(normalizeTimesheetValue('SYMBOL_TICK_1')).toBe('SYMBOL_TICK_1')
    expect(normalizeTimesheetValue('SYMBOL_TICK_2')).toBe('SYMBOL_TICK_2')
    expect(normalizeTimesheetValue('SYMBOL_NULL_CELL')).toBe('SYMBOL_NULL_CELL')
  })
})

describe('記号（実物のコピーから採った綴り）', () => {
  it('○ / ● / × の綴りを固定する', () => {
    expect(TOEI_SYMBOL.inbetween).toBe('SYMBOL_TICK_1')
    expect(TOEI_SYMBOL.reverse).toBe('SYMBOL_TICK_2')
    expect(TOEI_SYMBOL.empty).toBe('SYMBOL_NULL_CELL')
  })

  it('画面には記号で出すが、保存とコピーは綴りのまま', () => {
    expect(timesheetGlyph(TOEI_SYMBOL.inbetween)).toBe('○')
    expect(timesheetGlyph(TOEI_SYMBOL.reverse)).toBe('●')
    expect(timesheetGlyph(TOEI_SYMBOL.empty)).toBe('×')
    expect(timesheetGlyph('12A')).toBe('12A')
  })

  it('記号は数字と同じ形でコピーに載る（fontColorId 付きの values）', () => {
    const frames = parse(buildToeiClipboard([
      { frame: 0, value: TOEI_SYMBOL.inbetween },
      { frame: 1, value: TOEI_SYMBOL.reverse },
      { frame: 2, value: TOEI_SYMBOL.empty },
    ], 3)).layers[0].frames
    expect(frames.map(valueOf)).toEqual(['SYMBOL_TICK_1', 'SYMBOL_TICK_2', 'SYMBOL_NULL_CELL'])
    expect(frames[0].data[0]).toEqual({ fontColorId: 0, id: 0, values: ['SYMBOL_TICK_1'] })
  })

  it('保存しても綴りが壊れない', () => {
    const marks: TimesheetMark[] = [{ frame: 3, value: TOEI_SYMBOL.empty }]
    expect(decodeTimesheet(encodeTimesheet(marks))).toEqual(marks)
  })
})

describe('decodeTimesheet / encodeTimesheet', () => {
  it('往復しても変わらない', () => {
    const marks: TimesheetMark[] = [{ frame: 0 }, { frame: 12, value: '3A' }, { frame: 30, memo: 'カット12' }]
    expect(decodeTimesheet(encodeTimesheet(marks))).toEqual(marks)
  })

  it('コマ順に並べ、重複は落とす', () => {
    expect(decodeTimesheet('[[30],[0],[30],[12]]')).toEqual([{ frame: 0 }, { frame: 12 }, { frame: 30 }])
  })

  it('壊れた行があっても、読める打鍵は残す', () => {
    expect(decodeTimesheet('[[0],"x",[-1],[2.5],[7,"","メモ"]]')).toEqual([{ frame: 0 }, { frame: 7, memo: 'メモ' }])
  })

  it('JSON として壊れていたら空にする（例外で画面を落とさない）', () => {
    expect(decodeTimesheet('{')).toEqual([])
    expect(decodeTimesheet(null)).toEqual([])
    expect(decodeTimesheet('')).toEqual([])
  })

  it('長すぎるメモは切る', () => {
    const long = 'あ'.repeat(500)
    expect(decodeTimesheet(JSON.stringify([[0, '', long]]))[0].memo).toHaveLength(200)
  })

  it('打鍵だけの行は余分な空要素を持たない（1 クリップで数百組になるため）', () => {
    expect(encodeTimesheet([{ frame: 5 }])).toBe('[[5]]')
    expect(encodeTimesheet([{ frame: 5, value: '2' }])).toBe('[[5,"2"]]')
  })
})

describe('requiredSheetLength', () => {
  // 貼り付け先の尺（「秒 数」欄）を超えたコマは灰色になる。クリップボード形式に尺を書く欄が
  // 無いので、必要な長さは画面に出すしかない。
  it('素材 fps で秒とコマに割る', () => {
    expect(requiredSheetLength(720, 24)).toEqual({ seconds: 30, frames: 0 })
    expect(requiredSheetLength(725, 24)).toEqual({ seconds: 30, frames: 5 })
    expect(requiredSheetLength(900, 30)).toEqual({ seconds: 30, frames: 0 })
  })

  it('23.976 のような端数の fps は四捨五入して 24 コマで割る', () => {
    expect(requiredSheetLength(720, 23.976)).toEqual({ seconds: 30, frames: 0 })
    expect(requiredSheetLength(899, 29.97)).toEqual({ seconds: 29, frames: 29 })
  })
})

describe('timesheetRows', () => {
  const clipOf = (n: number, gaps?: { afterIndex: number; missing: number; measured: boolean; animeMissing?: number }[]) => ({
    pts: Array.from({ length: n }, (_, i) => i / 24),
    sourceBased: true,
    quality: Array.from({ length: n }, () => FRAME_QUALITY.captured),
    gaps,
  })

  it('抜けが無ければ表の行がそのまま並ぶ', () => {
    expect(timesheetRows(clipOf(3))).toEqual([0, 1, 2])
  })

  // ここが肝。差し込まないと、抜けた枚数だけ下が詰まって番号が元の動画とずれる。
  it('抜けの位置に、抜けた枚数だけ空のコマが入る', () => {
    expect(timesheetRows(clipOf(3, [{ afterIndex: 0, missing: 3, measured: false, animeMissing: 2 }])))
      .toEqual([0, GAP_ROW, GAP_ROW, 1, 2])
  })

  it('抜けが複数あっても、それぞれの位置に入る', () => {
    expect(timesheetRows(clipOf(3, [
      { afterIndex: 0, missing: 2, measured: false, animeMissing: 1 },
      { afterIndex: 2, missing: 2, measured: false, animeMissing: 1 }
    ])))
      .toEqual([0, GAP_ROW, 1, 2, GAP_ROW])
  })

  it('アニメの枚数を推定できない抜けには、通知欠落数ぶんの行を作らない', () => {
    expect(timesheetRows(clipOf(3, [{ afterIndex: 0, missing: 3, measured: false }])))
      .toEqual([0, 1, 2])
  })

  it('表が空なら何も並ばない', () => {
    expect(timesheetRows(null)).toEqual([])
  })
})

describe('expandMarks', () => {
  // 打った内容は表の行の添字で保存してある。書き出すときだけ、抜けを含めた位置へ移す。
  it('抜けのぶんだけ後ろへずれる', () => {
    const rows = [0, GAP_ROW, GAP_ROW, 1, 2]
    expect(expandMarks([{ frame: 0 }, { frame: 1 }, { frame: 2 }], rows))
      .toEqual([{ frame: 0 }, { frame: 3 }, { frame: 4 }])
  })

  it('打った内容（動画番号・メモ）はそのまま持ち越す', () => {
    expect(expandMarks([{ frame: 1, value: 'A1', memo: 'め' }], [0, GAP_ROW, 1]))
      .toEqual([{ frame: 2, value: 'A1', memo: 'め' }])
  })
})
