import { create } from 'zustand'
import type { Settings } from '../types'
import { SETTINGS_DEFAULTS } from '../../../shared/settingsDefaults'
import { t } from '../i18n'

type ShowToast = (message: string, tone?: 'info' | 'success' | 'warning' | 'error', ms?: number) => void

type SettingsStoreState = {
  settings: Settings
  loaded: boolean
  init: () => void
  // 楽観更新（R-1）: 先にローカル state を更新して即描画し、その後 IPC を投げる。
  // main 側は部分パッチ＋マージ方式（bootstrap.ts）で他キーの巻き戻りを防いでいるので、
  // 失敗時はこのキーだけ旧値へロールバックすればよい。
  update: <K extends keyof Settings>(key: K, value: Settings[K], showToast?: ShowToast) => Promise<void>
  // useFilters 等が smartFolders 保存後にローカル反映だけ行うための素の setter（IPC は呼ばない）。
  setSettings: (updated: Settings) => void
  // キャプチャホットキーは main 側の登録可否（グローバルショートカット競合）が真実なので、
  // 他の設定と違い確定を待ってから反映する（悲観方式のまま維持）。
  applyCaptureHotkey: (hotkey: string) => Promise<boolean>
}

export const useSettingsStore = create<SettingsStoreState>((set, get) => ({
  settings: SETTINGS_DEFAULTS,
  loaded: false,

  init: () => {
    if (get().loaded) return
    window.api.getSettings()
      .then((s) => set({ settings: s, loaded: true }))
      .catch((err) => { console.error('[settings] load failed', err); set({ loaded: true }) })
  },

  update: async (key, value, showToast) => {
    const prevValue = get().settings[key]
    set((s) => ({ settings: { ...s.settings, [key]: value } }))
    try {
      await window.api.setSettings({ [key]: value } as Partial<Settings>)
    } catch (err) {
      console.error('[settings] update failed', key, err)
      // 巻き戻しは対象キーのみを最新 state に対して行う。全体スナップショット（prev）へ戻すと、
      // await 中に成功した別キーの変更まで消えてしまう（連続操作時の巻き添え）。
      set((s) => ({ settings: { ...s.settings, [key]: prevValue } }))
      showToast?.(t('toast.settingsSaveFailed'), 'error')
    }
  },

  setSettings: (updated) => set({ settings: updated }),

  applyCaptureHotkey: async (hotkey) => {
    const ok = await window.api.setCaptureHotkey(hotkey)
    if (ok) set((s) => ({ settings: { ...s.settings, captureHotkey: hotkey } }))
    return ok
  },
}))
