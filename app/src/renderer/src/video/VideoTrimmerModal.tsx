import { useEffect, useState } from 'react'
import type { ImageRow, Settings } from '../types'
import { useTrimStore } from './trimStore'
import VideoTrimmer from './VideoTrimmer'

// App からは自身の状態を一切受け取らない自己完結モーダル（features/registry 経由で描画される）。
// 対象 id は trimStore、image/settings は自分で IPC から取得する。
export default function VideoTrimmerModal() {
  const trimImageId = useTrimStore((s) => s.trimImageId)
  const close = useTrimStore((s) => s.close)
  const [image, setImage] = useState<ImageRow | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    if (trimImageId === null) { setImage(null); setSettings(null); return }
    let cancelled = false
    Promise.all([window.api.getImage(trimImageId), window.api.getSettings()]).then(([img, s]) => {
      if (cancelled) return
      if (!img) { close(); return }
      setImage(img)
      setSettings(s)
    })
    return () => { cancelled = true }
  }, [trimImageId, close])

  if (trimImageId === null || !image || !settings) return null

  return (
    <VideoTrimmer
      image={image}
      settings={settings}
      onClose={close}
      // 保存成功時のサイドバー再取得は useCaptureSync の onCapture 購読が
      // capture:done（トリミングでも送られる）を受けて既にやっているため不要。
      onTrimmed={() => {}}
    />
  )
}
