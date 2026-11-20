import { useEffect, useState } from 'react'
import { color, font, space } from '../styles'
import { buildAccelerator } from '../utils'
import { normalizeCaptureHotkey } from '../../../shared/hotkey'
import { s } from './settingsStyles'
import { useT } from '../i18n'

// 設定画面のホットキーの 1 行（「変更」→ キーを押す → 「確定」）。キャプチャと録画で共通。
// 以前は 2 行それぞれに同じ処理が丸ごと書かれていて、片方を直してももう片方は直らなかった。
//
// onCommit は登録できたら true（他のアプリと重なって登録できなければ false で「競合」を出す）。
// onCapturingChange は、キーを待っている間 Escape で設定画面ごと閉じないよう、設定画面へ知らせる。
export default function HotkeyField({ label, value, onCommit, onCapturingChange }: {
  label: string
  value: string
  onCommit: (accel: string) => Promise<boolean>
  onCapturingChange: (capturing: boolean) => void
}) {
  const { t } = useT()
  const [capturing, setCapturing] = useState(false)
  const [capturedAccel, setCapturedAccel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { onCapturingChange(capturing) }, [capturing, onCapturingChange])

  useEffect(() => {
    if (!capturing) return
    const handler = (e: KeyboardEvent): void => {
      e.preventDefault()
      if (e.key === 'Escape') { setCapturing(false); setCapturedAccel(null); setError(null); return }
      const accel = buildAccelerator(e)
      if (!accel) return
      // main（hotkey.ts）と同じ正規化規則で事前検証する（Q4）。ここを通さないと
      // 画面だけが「受け付けた」ように見えて、確定時に main 側の normalizeCaptureHotkey が拒否し
      // 「競合しています」という不正確なエラーになる。
      if (normalizeCaptureHotkey(accel)) {
        setCapturedAccel(accel)
        setError(null)
      } else {
        setCapturedAccel(null)
        setError(t('hotkey.unsupportedCombo'))
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [capturing, t])

  const start = (): void => { setCapturing(true); setCapturedAccel(null); setError(null) }
  const cancel = (): void => { setCapturing(false); setCapturedAccel(null); setError(null) }

  return (
    <>
      <div style={s.row}>
        <span style={s.label}>{label}</span>
        {capturing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: space.x4 }}>
            <div style={s.hotkeyCapture}>
              {capturedAccel || t('hotkey.pressKeys')}
            </div>
            <button style={s.sizeBtn} disabled={!capturedAccel} onClick={async () => {
              if (!capturedAccel) return
              const ok = await onCommit(capturedAccel)
              if (ok) { setCapturing(false); setError(null) }
              else setError(t('hotkey.conflict'))
            }}>{t('action.confirm')}</button>
            <button style={s.sizeBtn} onClick={cancel}>{t('action.cancel')}</button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: space.x8 }}>
            <span style={s.hotkeyBadge}>{value}</span>
            <button style={s.sizeBtn} onClick={start}>{t('action.change')}</button>
          </div>
        )}
      </div>
      {error && <div style={{ fontSize: font.sm, color: color.danger }}>{error}</div>}
    </>
  )
}
