import { beforeEach, describe, expect, it, vi } from 'vitest'

// 他のアプリに握られているキーは登録できない。takeOnRelease に入れたキーは、外した瞬間に他のアプリが取る。
const taken = new Set<string>()
const takeOnRelease = new Set<string>()
const registered = new Map<string, () => void>()
vi.mock('electron', () => ({
  globalShortcut: {
    register: (key: string, fn: () => void) => { if (taken.has(key)) return false; registered.set(key, fn); return true },
    unregister: (key: string) => { registered.delete(key); if (takeOnRelease.has(key)) taken.add(key) },
  },
}))

import { createHotkeySlot } from './hotkey-slot'

const slot = () => createHotkeySlot({ logTag: 't', initialHotkey: 'Alt+S', failedMessage: (k) => `failed ${k}` })

beforeEach(() => {
  taken.clear()
  takeOnRelease.clear()
  registered.clear()
})

// 静止画と録画で同じ実装を使う。別々だった頃、録画だけ「元のキーへ戻せなかった」を黙っていた。
describe('createHotkeySlot', () => {
  it('変更できなければ元のキーへ戻し、押したときの処理も元のまま', () => {
    taken.add('Alt+X')
    const onPress = vi.fn()
    const s = slot()
    s.register('Alt+S', onPress)
    const errors: string[] = []
    expect(s.change('Alt+X', (m) => errors.push(m))).toBe(false)
    expect(errors).toEqual(['failed Alt+X'])
    registered.get('Alt+S')!()
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('元のキーへ戻すのにも失敗したら、それも知らせる', () => {
    taken.add('Alt+X')
    takeOnRelease.add('Alt+S')
    const s = slot()
    s.register('Alt+S', () => {})
    const errors: string[] = []
    expect(s.change('Alt+X', (m) => errors.push(m))).toBe(false)
    expect(errors).toEqual(['failed Alt+X', 'failed Alt+S'])
  })

  it('変更できたら新しいキーで同じ処理が動く', () => {
    const onPress = vi.fn()
    const s = slot()
    s.register('Alt+S', onPress)
    expect(s.change('Alt+X')).toBe(true)
    registered.get('Alt+X')!()
    expect(onPress).toHaveBeenCalledTimes(1)
    expect(registered.has('Alt+S')).toBe(false)
  })
})
