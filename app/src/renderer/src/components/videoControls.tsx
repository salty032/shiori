// VideoPlayer（ビューア/詳細パネル）と VideoTrimmer（トリム画面）で共通の
// 再生コントロール部品。旧レビュー V-20 / U-7 で指摘された重複（音量ポップアップ・
// shiori-vc-styles 注入・再生/ミュートアイコン）を 1 箇所に集約し、片方だけ直して
// 挙動が食い違う温床を無くす。挙動は両コンポーネントの従来実装と同一。
import { useEffect, useRef, useState } from 'react'
import { font } from '../styles'

// 音量ポップアップのスライドイン/アウト用 keyframes を一度だけ注入する。
// 両コンポーネントが同じ id で個別に注入していたのを共通化（内容は同一）。
export function useVcStyles(): void {
  useEffect(() => {
    if (document.getElementById('shiori-vc-styles')) return
    const style = document.createElement('style')
    style.id = 'shiori-vc-styles'
    style.textContent = '@keyframes vcVolSlideUp { from { opacity:0; transform:translateX(-50%) translateY(6px); } to { opacity:1; transform:translateX(-50%) translateY(0); } } @keyframes vcVolSlideDown { from { opacity:1; transform:translateX(-50%) translateY(0); } to { opacity:0; transform:translateX(-50%) translateY(6px); } }'
    document.head.appendChild(style)
  }, [])
}

// コントロールバーのアイコンボタン共通スタイル（再生/ミュート）。
export const vcBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#94a0b7', cursor: 'pointer',
  minWidth: 30, minHeight: 30, padding: 4,
  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
}

// コントロールバー本体（映像に重なる A層＝意図的な非テーマ暗色）。
// VideoPlayer と VideoTrimmer の両方から参照する単一定義（片方だけ直す食い違いを防ぐ、V-20/U-7 と同方針）。
export const vcBarStyle: React.CSSProperties = {
  position: 'absolute', bottom: 0, left: 0, right: 0, display: 'flex', alignItems: 'center',
  gap: 6, padding: '4px 8px', background: 'rgba(13,15,20,0.82)', backdropFilter: 'blur(4px)',
  height: 34, boxSizing: 'border-box'
}

// シークバー: 可視はスリム(高さ6)のまま、掴める判定を実効16pxへ広げる。
// 透明トラック(高さ16)の中に、可視バー・フィル・つまみを縦中央配置する。
export const vcSeekTrackStyle: React.CSSProperties = {
  position: 'relative', flex: 1, height: 16, cursor: 'pointer', display: 'flex', alignItems: 'center'
}
export const vcSeekBarStyle: React.CSSProperties = {
  position: 'absolute', left: 0, right: 0, top: '50%', transform: 'translateY(-50%)',
  height: 6, background: '#272c3a', borderRadius: 3, pointerEvents: 'none'
}
export const vcSeekFillStyle: React.CSSProperties = {
  position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
  height: 6, background: 'rgba(var(--accent-rgb), 1)', borderRadius: 3, pointerEvents: 'none'
}
export const vcSeekThumbStyle: React.CSSProperties = {
  position: 'absolute', top: '50%', marginTop: -6, width: 12, height: 12, borderRadius: 999,
  background: 'var(--accent-text)', boxShadow: '0 0 0 3px rgba(var(--accent-rgb), 0.18)', pointerEvents: 'none'
}

export function PlayPauseIcon({ playing }: { playing: boolean }): React.JSX.Element {
  return playing ? (
    <svg width="9" height="11" viewBox="0 0 9 11" fill="currentColor">
      <rect x="0" y="0" width="3" height="11" rx="1" />
      <rect x="6" y="0" width="3" height="11" rx="1" />
    </svg>
  ) : (
    <svg width="9" height="11" viewBox="0 0 9 11" fill="currentColor">
      <polygon points="0,0 9,5.5 0,11" />
    </svg>
  )
}

function MuteIcon({ muted }: { muted: boolean }): React.JSX.Element {
  return muted ? (
    <svg width="13" height="11" viewBox="0 0 13 11" fill="currentColor">
      <path d="M0 3.5v4h2.5L6 11V0L2.5 3.5H0z" />
      <line x1="8.5" y1="2.5" x2="12.5" y2="8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="12.5" y1="2.5" x2="8.5" y2="8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ) : (
    <svg width="14" height="11" viewBox="0 0 14 11" fill="currentColor">
      <path d="M0 3.5v4h2.5L6 11V0L2.5 3.5H0z" />
      <path d="M8 3 C9.5 4 9.5 7 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10 1.5 C13 3 13 8 10 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

type VolumeControlProps = {
  videoRef: React.RefObject<HTMLVideoElement | null>
  // 表示用の現在値（親が onVolumeChange で反映する）。実際の設定は videoRef 経由で行う。
  volume: number
  muted: boolean
}

// ミュートボタン＋ホバーで出る縦スライダーのポップアップ。ホバー離脱から 200ms 後に
// 閉じ、閉じアニメーションを再生する挙動は従来どおり。
export function VolumeControl({ videoRef, volume, muted }: VolumeControlProps): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  const [closing, setClosing] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  function handleVolPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    e.preventDefault()
    e.stopPropagation()
    const el = trackRef.current
    if (!el) return
    const update = (clientY: number): void => {
      const rect = el.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height))
      const v = videoRef.current
      if (!v) return
      v.volume = pct
      v.muted = false
    }
    update(e.clientY)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent): void => update(ev.clientY)
    // pointerup 以外に、タッチ操作の中断等で発火する pointercancel でも確実に解除する
    // （片方だけだと、キャンセル経路でリスナーが残ったまま次のドラッグと二重に動く恐れがある）。
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const volPct = muted ? 0 : volume
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}
      onMouseEnter={() => { if (timerRef.current) clearTimeout(timerRef.current); setVisible(true); setClosing(false) }}
      onMouseLeave={() => { setClosing(true); timerRef.current = setTimeout(() => setVisible(false), 200) }}
    >
      <button style={vcBtnStyle} onClick={() => { const v = videoRef.current; if (v) v.muted = !v.muted }}>
        <MuteIcon muted={muted} />
      </button>
      {visible && (
        <div style={{ ...s.vcVolPopup, animation: closing ? 'vcVolSlideDown 0.2s ease-out forwards' : 'vcVolSlideUp 0.2s ease-out' }}>
          <div ref={trackRef} style={s.vcVolTrack} onPointerDown={handleVolPointerDown}>
            <div style={{ ...s.vcVolFill, height: `${volPct * 100}%` }} />
            <div style={{ ...s.vcVolThumb, bottom: `calc(${volPct * 100}% - 6px)` }} />
          </div>
        </div>
      )}
    </div>
  )
}

// 音量スライダーの時刻ラベルなど、コントロールバーで共有する数値表示スタイル。
export const vcTimeLabelStyle: React.CSSProperties = {
  fontSize: font.xs, color: '#7f899f', flexShrink: 0, fontVariantNumeric: 'tabular-nums', letterSpacing: 0
}

const s: Record<string, React.CSSProperties> = {
  vcVolPopup: { position: 'absolute', bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)', background: '#171a23', border: '1px solid #2b3243', borderRadius: 4, padding: '10px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, boxShadow: '0 18px 40px rgba(0,0,0,0.42)' },
  vcVolTrack: { position: 'relative', width: 6, height: 60, background: '#272c3a', borderRadius: 3, cursor: 'pointer', flexShrink: 0 },
  vcVolFill: { position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(var(--accent-rgb), 1)', borderRadius: 3 },
  vcVolThumb: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', width: 12, height: 12, borderRadius: 999, background: 'var(--accent-text)', boxShadow: '0 0 0 3px rgba(var(--accent-rgb), 0.18)', pointerEvents: 'none' },
}
