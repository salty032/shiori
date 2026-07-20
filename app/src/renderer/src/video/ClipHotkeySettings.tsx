import { useEffect, useState } from 'react'
import { buildAccelerator } from '../utils'
import { normalizeCaptureHotkey } from '../../../shared/hotkey'
import { font, color } from '../styles'
import { s, ToggleSwitch } from '../components/SettingsModal'
import { useSettingsStore } from '../stores/settingsStore'
import { videoApi } from './api'
import { useT } from '../i18n'

// SettingsModal の「キャプチャ」タブへ features/registry 経由で挿入される、録画専用の設定。
// 設定の読み書きは settingsStore（zustand）を購読する。以前は自前で getSettings() を
// fetch しており、hotkey/notification の2スロットがそれぞれ独立スナップショットを持つ
// ことでモーダルを開くたび IPC が2回走っていた（R-6）。
type Props = {
  onCapturingChange: (capturing: boolean) => void
  placement?: 'hotkey' | 'notification'
}

export default function ClipHotkeySettings({ onCapturingChange, placement }: Props) {
  const { t } = useT()
  const settings = useSettingsStore((s) => s.settings)
  const setSettings = useSettingsStore((s) => s.setSettings)
  const initSettings = useSettingsStore((s) => s.init)
  const [capturing, setCapturing] = useState(false)
  const [capturedAccel, setCapturedAccel] = useState<string | null>(null)
  const [hotkeyError, setHotkeyError] = useState<string | null>(null)

  useEffect(() => { initSettings() }, [initSettings])
  useEffect(() => { onCapturingChange(capturing) }, [capturing, onCapturingChange])

  useEffect(() => {
    if (!capturing) return
    const handler = (e: KeyboardEvent): void => {
      e.preventDefault()
      if (e.key === 'Escape') { setCapturing(false); setCapturedAccel(null); setHotkeyError(null); return }
      const accel = buildAccelerator(e)
      if (!accel) return
      // main（hotkey.ts）と同じ正規化規則で事前検証する（R2ついで、Q4と同種）。
      if (normalizeCaptureHotkey(accel)) {
        setCapturedAccel(accel)
        setHotkeyError(null)
      } else {
        setCapturedAccel(null)
        setHotkeyError(t('hotkey.unsupportedCombo'))
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [capturing])

  async function updateClipNotify(enabled: boolean): Promise<void> {
    // window.api.setSettings は main 側で loadSettings() とマージされる部分パッチなので、
    // 巻き戻りは起きない。
    setSettings({ ...settings, clipNotify: enabled })
    await window.api.setSettings({ clipNotify: enabled })
  }

  if (placement === 'notification') {
    return (
      <div style={s.toggleRow}>
        <span style={s.label}>{t('clip.notifyOnFinish')}</span>
        <ToggleSwitch checked={settings.clipNotify ?? true} onChange={updateClipNotify} />
      </div>
    )
  }

  return (
    <>
      <div style={s.row}>
        <span style={s.label}>{t('clip.hotkeyLabel')}</span>
        {capturing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={s.hotkeyCapture}>
              {capturedAccel || t('hotkey.pressKeys')}
            </div>
            <button style={s.sizeBtn} disabled={!capturedAccel} onClick={async () => {
              if (!capturedAccel) return
              const ok = await videoApi.setClipHotkey(capturedAccel)
              if (ok) {
                setCapturing(false)
                setHotkeyError(null)
                setSettings({ ...settings, clipHotkey: capturedAccel })
              } else {
                setHotkeyError(t('hotkey.conflict'))
              }
            }}>{t('action.confirm')}</button>
            <button style={s.sizeBtn} onClick={() => { setCapturing(false); setCapturedAccel(null); setHotkeyError(null) }}>{t('action.cancel')}</button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={s.hotkeyBadge}>{settings.clipHotkey}</span>
            <button style={s.sizeBtn} onClick={() => { setCapturing(true); setCapturedAccel(null); setHotkeyError(null) }}>{t('action.change')}</button>
          </div>
        )}
      </div>
      {hotkeyError && <div style={{ fontSize: font.sm, color: color.danger }}>{hotkeyError}</div>}
      <div style={s.hint}>
        {t('clip.hotkeyTroubleshoot')}
      </div>
    </>
  )
}
