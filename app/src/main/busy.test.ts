import { describe, expect, it, beforeEach } from 'vitest'

import { beginTask, endTask, hasActiveTasks, activeTaskLabels, resetTasksForTest } from './busy'

beforeEach(() => resetTasksForTest())

describe('busy レジストリ', () => {
  it('タスクが無ければ busy ではない', () => {
    expect(hasActiveTasks()).toBe(false)
    expect(activeTaskLabels()).toEqual([])
  })

  it('begin で busy になり、end で戻る', () => {
    beginTask('import')
    expect(hasActiveTasks()).toBe(true)
    endTask('import')
    expect(hasActiveTasks()).toBe(false)
  })

  it('日本語ラベルを返す（更新確認ダイアログの文面に使う）', () => {
    beginTask('retag')
    expect(activeTaskLabels()).toEqual(['AIタグ付け'])
  })

  it('複数種別が同時に走ればすべて挙げる', () => {
    beginTask('import')
    beginTask('model-download')
    expect(activeTaskLabels()).toEqual(['取り込み', 'AIモデルのダウンロード'])
  })

  it('同種の多重 begin は同じ数だけ end するまで busy のまま', () => {
    beginTask('export')
    beginTask('export')
    endTask('export')
    expect(hasActiveTasks()).toBe(true)
    endTask('export')
    expect(hasActiveTasks()).toBe(false)
  })

  it('ラベルは重複しない（同種2件でも1つ）', () => {
    beginTask('export')
    beginTask('export')
    expect(activeTaskLabels()).toEqual(['エクスポート'])
  })

  // end 漏れの逆（余分な end）でカウンタが負に沈むと、以降 begin しても
  // busy と見なされない穴になるため 0 で止める。
  it('余分な end を呼んでもカウンタが負にならない', () => {
    endTask('import')
    endTask('import')
    beginTask('import')
    expect(hasActiveTasks()).toBe(true)
    endTask('import')
    expect(hasActiveTasks()).toBe(false)
  })
})
