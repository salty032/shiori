import { describe, expect, it } from 'vitest'
import {
  buildToeiClipboard,
  canBuildTimesheet,
  decodeTimesheet,
  encodeTimesheet,
  normalizeTimesheetValue,
  requiredSheetLength,
  timesheetGlyph,
  timesheetLabels,
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
    expect(canBuildTimesheet(clip(captured(100)))).toBe(true)
  })

  it('撮り逃しが 1 コマでもあれば出さない', () => {
    const q = captured(100)
    q[42] = FRAME_QUALITY.reused
    expect(canBuildTimesheet(clip(q))).toBe(false)
  })

  it('流用でも「前後の絵が同一と検証済み」を例外にしない（撮れてはいない）', () => {
    const q = captured(100)
    q[7] = FRAME_QUALITY.reusedSame
    expect(canBuildTimesheet(clip(q))).toBe(false)
  })

  it('要確認のコマがあれば当然出さない', () => {
    const q = captured(100)
    q[7] = FRAME_QUALITY.reusedChanged
    expect(canBuildTimesheet(clip(q))).toBe(false)
  })

  it('表が無い・素材のコマ単位でないクリップでは出さない', () => {
    expect(canBuildTimesheet(null)).toBe(false)
    expect(canBuildTimesheet(undefined)).toBe(false)
    expect(canBuildTimesheet(clip([], true))).toBe(false)
    expect(canBuildTimesheet(clip(captured(100), false))).toBe(false)
  })

  it('コマごとの確からしさが欠けていたら出さない（分からない＝保証できない）', () => {
    expect(canBuildTimesheet({ pts: [0, 1, 2], sourceBased: true, quality: [] })).toBe(false)
    expect(canBuildTimesheet({ pts: [0, 1, 2], sourceBased: true, quality: captured(2) })).toBe(false)
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
