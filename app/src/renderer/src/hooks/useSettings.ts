import { useEffect, useState } from 'react'
import type { ExtensionTimecode, Settings } from '../types'
import { useSettingsStore } from '../stores/settingsStore'
import type { ShowToast } from './useToast'
import { t } from '../i18n'

// 設定の「真実」は settingsStore（zustand）に一元化されている（C-4）。ここはそのストアを
// 購読し、起動状態・拡張ステータスなど settings.json 非永続の UI 状態を合わせて App 向けの
// インターフェースに組み立てる薄いラッパー。
export function useSettings(showToast?: ShowToast) {
  const settings = useSettingsStore((s) => s.settings)
  const setSettings = useSettingsStore((s) => s.setSettings)
  const update = useSettingsStore((s) => s.update)
  const applyCaptureHotkey = useSettingsStore((s) => s.applyCaptureHotkey)
  const init = useSettingsStore((s) => s.init)

  const [startup, setStartup] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [extensionStatus, setExtensionStatus] = useState<{ lastSeenAt: number; data: ExtensionTimecode } | null>(null)

  useEffect(() => {
    init()
    window.api.getStartup().then(setStartup)
  }, [init])

  useEffect(() => window.api.onOpenSettings(() => setShowSettings(true)), [])
  useEffect(() => window.api.onUpdateDownloaded((v) => setUpdateVersion(v)), [])
  useEffect(() => window.api.onExtensionTimecode((data) => setExtensionStatus({ lastSeenAt: Date.now(), data })), [])

  // <html data-theme> を settings.theme に追従させる。'system' は OS 設定を購読し、
  // 変化にもリアルタイムで追従する（settings.json 上は 'system' のまま、実際の
  // 明暗判定だけを都度差し替える）。
  useEffect(() => {
    const root = document.documentElement
    if (settings.theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const apply = (): void => { root.dataset.theme = mq.matches ? 'dark' : 'light' }
      apply()
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
    root.dataset.theme = settings.theme
    return undefined
  }, [settings.theme])

  async function toggleStartup(): Promise<void> {
    // 楽観更新（R-2）: レジストリ書き込み（Windows）の完了を待たず即座にスイッチを反映する。
    const next = !startup
    setStartup(next)
    try {
      await window.api.setStartup(next)
    } catch (err) {
      console.error('[settings] toggleStartup failed', err)
      setStartup(!next)
      showToast?.(t('toast.startupToggleFailed'), 'error')
    }
  }

  return {
    settings, setSettings,
    startup,
    showSettings, setShowSettings,
    updateVersion,
    extensionStatus,
    toggleStartup,
    quitAndInstallUpdate: () => window.api.updaterQuitAndInstall(),
    updateThumbnailSize: (v: number) => update('thumbnailSize', v, showToast),
    updateFrameFps: (v: number) => update('frameFps', v, showToast),
    updateFrameFpsAuto: (v: boolean) => update('frameFpsAuto', v, showToast),
    updateCaptureHotkey: applyCaptureHotkey,
    updateCaptureNotify: (v: boolean) => update('captureNotify', v, showToast),
    updateShowAiTags: (v: boolean) => update('showAiTags', v, showToast),
    updateTheme: (v: Settings['theme']) => update('theme', v, showToast),
    updateLanguage: (v: Settings['language']) => update('language', v, showToast),
  }
}
