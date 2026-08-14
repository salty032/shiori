import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_SETUP_GUIDE_STATE,
  SETUP_GUIDE_STORAGE_KEY,
  completedSetupSteps,
  loadSetupGuideState,
  reconcileCaptureCompletion,
  saveSetupGuideState,
} from './setupGuideState'

describe('setupGuideState', () => {
  it('loads only explicit boolean completions', () => {
    const storage = {
      getItem: vi.fn(() => JSON.stringify({
        tutorialSeen: true,
        browserPrepared: 'yes',
        extensionReady: true,
      })),
    }
    expect(loadSetupGuideState(storage)).toEqual({
      tutorialSeen: true,
      browserPrepared: false,
      extensionReady: true,
      firstCaptureDone: false,
    })
  })

  it('falls back when storage is corrupt or unavailable', () => {
    expect(loadSetupGuideState({ getItem: () => '{broken' })).toEqual(EMPTY_SETUP_GUIDE_STATE)
    expect(loadSetupGuideState({ getItem: () => { throw new Error('blocked') } })).toEqual(EMPTY_SETUP_GUIDE_STATE)
  })

  it('saves without surfacing storage failures', () => {
    const setItem = vi.fn()
    saveSetupGuideState({ ...EMPTY_SETUP_GUIDE_STATE, browserPrepared: true }, { setItem })
    expect(setItem).toHaveBeenCalledWith(
      SETUP_GUIDE_STORAGE_KEY,
      JSON.stringify({ ...EMPTY_SETUP_GUIDE_STATE, browserPrepared: true }),
    )
    expect(() => saveSetupGuideState(EMPTY_SETUP_GUIDE_STATE, { setItem: () => { throw new Error('full') } })).not.toThrow()
  })

  it('counts the three actionable steps, not tutorial dismissal', () => {
    expect(completedSetupSteps({
      tutorialSeen: true,
      browserPrepared: true,
      extensionReady: false,
      firstCaptureDone: true,
    })).toBe(2)
  })

  it('first capture completion always keeps its prerequisite steps completed', () => {
    const inconsistent = { ...EMPTY_SETUP_GUIDE_STATE, firstCaptureDone: true }
    expect(reconcileCaptureCompletion(inconsistent, false)).toEqual({
      ...inconsistent,
      browserPrepared: true,
      extensionReady: true,
    })
    expect(reconcileCaptureCompletion(EMPTY_SETUP_GUIDE_STATE, true)).toEqual({
      ...EMPTY_SETUP_GUIDE_STATE,
      browserPrepared: true,
      extensionReady: true,
      firstCaptureDone: true,
    })
  })
})
