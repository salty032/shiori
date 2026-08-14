// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import ProductTour from './ProductTour'

describe('ProductTour', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('後から描画されたメモ欄のクリックでも進み、続くfocusでは二重に進まない', () => {
    const onAdvance = vi.fn()
    render(<ProductTour step={3} onAdvance={onAdvance} onExit={() => {}} />)

    const memo = document.createElement('textarea')
    memo.dataset.tour = 'memo-input'
    document.body.appendChild(memo)
    fireEvent.pointerDown(memo)
    fireEvent.focusIn(memo)

    expect(onAdvance).toHaveBeenCalledTimes(1)
    memo.remove()
  })
})
