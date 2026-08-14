export type SetupGuideState = {
  tutorialSeen: boolean
  browserPrepared: boolean
  extensionReady: boolean
  firstCaptureDone: boolean
}

export const SETUP_GUIDE_STORAGE_KEY = 'shiori-setup-guide-v1'

export const EMPTY_SETUP_GUIDE_STATE: SetupGuideState = {
  tutorialSeen: false,
  browserPrepared: false,
  extensionReady: false,
  firstCaptureDone: false,
}

// セットアップ状態は端末固有（ブラウザ設定・ローカル拡張の導入状況）なので、ライブラリと
// 一緒に移動する settings.json ではなく renderer の localStorage に置く。壊れた値や
// 保存禁止環境でも初回画面そのものを壊さないよう、読み書きは必ずフォールバックする。
export function loadSetupGuideState(storage: Pick<Storage, 'getItem'> = localStorage): SetupGuideState {
  try {
    const raw = storage.getItem(SETUP_GUIDE_STORAGE_KEY)
    if (!raw) return EMPTY_SETUP_GUIDE_STATE
    const value = JSON.parse(raw) as Partial<Record<keyof SetupGuideState, unknown>>
    return {
      tutorialSeen: value.tutorialSeen === true,
      browserPrepared: value.browserPrepared === true,
      extensionReady: value.extensionReady === true,
      firstCaptureDone: value.firstCaptureDone === true,
    }
  } catch {
    return EMPTY_SETUP_GUIDE_STATE
  }
}

export function saveSetupGuideState(
  state: SetupGuideState,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    storage.setItem(SETUP_GUIDE_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // セットアップ案内は補助機能。保存失敗でキャプチャ本体を妨げない。
  }
}

export function completedSetupSteps(state: SetupGuideState): number {
  return Number(state.browserPrepared) + Number(state.extensionReady) + Number(state.firstCaptureDone)
}

// 初回キャプチャは前段2つを通過できた証拠。既に firstCaptureDone だけが保存された不整合も
// 起動時に直し、完了後に前段だけ未完了へ戻る不可能な状態を残さない。
export function reconcileCaptureCompletion(state: SetupGuideState, hasCapturedItem: boolean): SetupGuideState {
  if (!state.firstCaptureDone && !hasCapturedItem) return state
  if (state.browserPrepared && state.extensionReady && state.firstCaptureDone) return state
  return { ...state, browserPrepared: true, extensionReady: true, firstCaptureDone: true }
}
