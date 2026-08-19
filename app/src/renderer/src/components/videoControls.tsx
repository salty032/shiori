// VideoPlayer（ビューア/詳細パネル）と VideoTrimmer（トリム画面）で共通の
// 再生コントロール部品。旧レビュー V-20 / U-7 で指摘された重複（音量ポップアップ・
// shiori-vc-styles 注入・再生/ミュートアイコン）を 1 箇所に集約し、片方だけ直して
// 挙動が食い違う温床を無くす。挙動は両コンポーネントの従来実装と同一。
import { useEffect, useRef, useState } from 'react'
import { font, radius } from '../styles'
import { useT } from '../i18n'

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
// 映像に直接重なる層なので、暗色スラブ前提のくすんだ青灰ではなく、
// どんな映像の上でも読めるオンビデオの明色（半透明ホワイト）に統一する。
export const vcBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: 'rgba(255,255,255,0.9)', cursor: 'pointer',
  minWidth: 24, minHeight: 22, padding: 2,
  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
}

// コントロールバー本体の「見た目」だけの定義（不透明の帯）。位置は使う側で決める:
// VideoTrimmer は映像下端に absolute で重ねる（不透明スラブのまま）。VideoPlayer は
// 下の vcBarOverlayStyle を重ねてホバー時だけ出るオーバーレイにする。
// VideoPlayer と VideoTrimmer の両方から参照する単一定義（片方だけ直す食い違いを防ぐ、V-20/U-7 と同方針）。
// 地は #12151c（青みの強い黒）だった。アプリの地は中立のグレーに寄せてあるので、
// ここだけ青く沈んで別のアプリの部品に見えていた。映像（黒）の直下に置く帯なので
// テーマでは反転させず、暗いまま中立色にする。
// 境目の 1px 線も外す（面の段差は線ではなく明るさで作る、が全体の方針）。
export const VC_BAR_HEIGHT = 30
export const vcBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center',
  gap: 6, padding: '0 8px', height: VC_BAR_HEIGHT, boxSizing: 'border-box',
  background: '#1a1a1a'
}

// VideoPlayer 用: バーを映像の「外・下」に積むのをやめ、映像下端に重ねる版。
// 以前は通常フローで下に置いていたため動画だけ全体が VC_BAR_HEIGHT 分高くなり、
// 詳細パネルでは画像側に同じ高さの余白を足して辻褄を合わせていた（＝画像とタイトルの間が
// 不自然に空く原因）。重ねる方式なら動画と画像の外形が完全に一致するので、その余白は不要になる。
// 不透明スラブだと映像の下端を隠してしまうので、グラデーションで溶かす。
//
// 読みやすさをスクリムの濃さだけで稼がないこと。濃い帯で押し切ると映像の下部が黒く潰れる
// （0.86 まで上げたら「黒がかかりすぎ」になった）。帯は輪郭がぼやけない程度に抑え、
// 不足分はコントロール側の自前の影（vcSeekBarStyle の boxShadow、vcTimeLabelStyle の
// textShadow）で稼ぐ。こうすると明るい映像の上でも、暗い映像の上でも破綻しない。
export const VC_OVERLAY_HEIGHT = 42
export const vcBarOverlayStyle: React.CSSProperties = {
  position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 2,
  height: VC_OVERLAY_HEIGHT,
  // スクリムのために伸ばした分は padding-top で吸収する。こうすると box-sizing:border-box と
  // 合わせてコンテンツ高が VC_BAR_HEIGHT のまま残り、vcBarStyle の alignItems:center が
  // そのまま効いて再生ボタン・シークバー・時刻・音量の縦位置が揃う。
  // align-items:flex-end で下に寄せると、箱の高さが違う（ボタン22 / トラック24 / ラベル~14）
  // 分だけ各コントロールの視覚的な中心がズレる。
  paddingTop: VC_OVERLAY_HEIGHT - VC_BAR_HEIGHT,
  background: 'linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.46) 48%, rgba(0,0,0,0.12) 80%, rgba(0,0,0,0) 100%)',
  borderTop: 'none',
  transition: 'opacity 0.15s ease',
}

// シークバー: 可視はスリム(高さ6)のまま、掴める判定を実効24pxへ広げる。
// 透明トラック(高さ24)の中に、可視バー・フィル・つまみを縦中央配置する。
//
// **バーの中でいちばん狙いにくい要素にしないこと。** 以前は 16px で、隣の再生ボタン(22px)
// より低かった。いちばん細かく狙う操作（コマの位置に置く）が、いちばん外しやすい判定に
// なっていたことになる。バーの内容高は 30px なので、24 までは他のコントロールの縦位置を
// 動かさずに広げられる。
export const vcSeekTrackStyle: React.CSSProperties = {
  position: 'relative', flex: 1, height: 24, cursor: 'pointer', display: 'flex', alignItems: 'center'
}
// 空トラックも映像に重なるため、暗色スラブ前提の #272c3a ではなく半透明ホワイトにする
// （どんな映像の上でも溝として認識できる）。0.26 では明るい映像に溶けるので上げたうえで、
// 下に落とす影で映像から浮かせる。薄いスクリムでも溝の輪郭が残るのはこの影のおかげ。
export const vcSeekBarStyle: React.CSSProperties = {
  position: 'absolute', left: 0, right: 0, top: '50%', transform: 'translateY(-50%)',
  height: 6, background: 'rgba(255,255,255,0.46)', borderRadius: radius.md, pointerEvents: 'none',
  boxShadow: '0 1px 3px rgba(0,0,0,0.55)'
}
export const vcSeekFillStyle: React.CSSProperties = {
  position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
  height: 6, background: 'rgba(var(--accent-rgb), 1)', borderRadius: radius.md, pointerEvents: 'none'
}
// つまみは映像の上に出るので白で固定する。--accent-text はライトテーマで濃紺になり、
// アクセント色のフィルの上に暗い点が乗って、どこを掴んでいるのか分からなくなっていた。
// 影は溝（vcSeekBarStyle）と同じものを使い、映像から浮かせる。
export const vcSeekThumbStyle: React.CSSProperties = {
  position: 'absolute', top: '50%', marginTop: -6, width: 12, height: 12, borderRadius: 999,
  background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.6)', pointerEvents: 'none'
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

// 再生の速さ。null は等速（そのまま再生する）、数値は**コマ再生で 1 コマを何秒見せるか**。
//
// コマ側を「N コマ/秒」ではなく 1 コマの表示時間で持つのは、画面で体験しているのが
// こちらの値だから（「1コマ 0.5秒」）。換算せずにそのまま読める。
//
// 遅い側の 1 秒は 1 コマを確かめるため、速い側の 0.1 秒は溜めの長さを流れとして掴むため。
// これより速くしてもコマごとのシークが追いつかず、実効速度が頭打ちになるだけ。
//
// 速い順に上から並べる（縦位置と速さの直感を一致させる）。等速が最も速い。
export const PLAYBACK_SPEEDS = [null, 0.1, 0.25, 0.5, 1] as const
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number]

// 速さボタン＋ホバーで出る選択ポップアップ。**ここは選ぶだけで、再生はしない**——
// 再生/停止は左端の ▶ ボタン 1 つに集約する。バーに再生ボタンが 2 つあると、
// どちらを押せばよいのかが画面から読めない。
// 開閉の作法（200ms 猶予・閉じアニメ）は VolumeControl と揃える。
export function SpeedControl({ speed, onPick }: {
  speed: PlaybackSpeed
  onPick: (speed: PlaybackSpeed) => void
}): React.JSX.Element {
  const { t } = useT()
  const [visible, setVisible] = useState(false)
  const [closing, setClosing] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  // ボタンは 1 つで立っているので、単位を省くと何の数字か分からなくなる（「1コマ 0.5秒」）。
  // ポップアップの行は見出しの下に並ぶので、共通部分は見出しへ預けて数字だけにする。
  const label = (sp: PlaybackSpeed): string =>
    sp === null ? t('viewer.speedNormal') : t('viewer.frameHold', { sec: String(sp) })

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}
      onMouseEnter={() => { if (timerRef.current) clearTimeout(timerRef.current); setVisible(true); setClosing(false) }}
      onMouseLeave={() => { setClosing(true); timerRef.current = setTimeout(() => setVisible(false), 200) }}
    >
      <button
        style={{ ...vcBtnStyle, ...s.vcStepBtn, ...(speed !== null ? s.vcStepBtnActive : {}) }}
        title={t(speed === null ? 'viewer.speedNormalHint' : 'viewer.framePlayHint', { sec: String(speed) })}
      >
        {label(speed)}
      </button>
      {visible && (
        <div style={{ ...s.vcStepPopup, animation: closing ? 'vcVolSlideDown 0.2s ease-out forwards' : 'vcVolSlideUp 0.2s ease-out' }}>
          {/* 等速とコマ送りは種類が違う（時間軸を持つ再生か、コマを 1 つずつ送るか）。
              5 つを同列に並べるとその違いが読み取れないので、見出しで切る。 */}
          <button
            data-current={speed === null ? 'true' : undefined}
            className={speed === null ? undefined : 'shiori-menu-item'}
            style={{ ...s.vcStepItem, ...(speed === null ? s.vcStepItemActive : {}) }}
            onClick={() => onPick(null)}
          >
            {t('viewer.speedNormal')}
          </button>
          <div style={s.vcStepGroup}>
            <span style={s.vcStepRule} />
            <span>{t('viewer.frameHoldGroup')}</span>
            <span style={s.vcStepRule} />
          </div>
          {PLAYBACK_SPEEDS.filter((sp) => sp !== null).map((sp) => (
            <button
              key={String(sp)}
              data-current={sp === speed ? 'true' : undefined}
              className={sp === speed ? undefined : 'shiori-menu-item'}
              style={{ ...s.vcStepItem, ...(sp === speed ? s.vcStepItemActive : {}) }}
              onClick={() => onPick(sp)}
            >
              {t('viewer.frameHoldShort', { sec: String(sp) })}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function LoopIcon(): React.JSX.Element {
  return (
    <svg width="13" height="11" viewBox="0 0 13 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 4.2V3.6A1.6 1.6 0 0 1 4.1 2h5.3" />
      <polyline points="8.2,0.8 9.6,2 8.2,3.2" />
      <path d="M10.5 6.8v0.6A1.6 1.6 0 0 1 8.9 9H3.6" />
      <polyline points="4.8,10.2 3.4,9 4.8,7.8" />
    </svg>
  )
}

// ループ再生トグル。数秒のカットを繰り返し見るのが研究の基本動作なので、
// 既定の「終わったら止まる」より前に出す位置（バー上の常設ボタン）に置く。
export function LoopButton({ loop, onToggle }: { loop: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <button
      style={{ ...vcBtnStyle, ...(loop ? s.vcLoopActive : {}) }}
      onClick={onToggle}
    >
      <LoopIcon />
    </button>
  )
}

// 音量スライダーの時刻ラベルなど、コントロールバーで共有する数値表示スタイル。
// 映像に直接重なるので、地の明暗に関わらず読めるよう文字自身に影を持たせる
// （スクリムを濃くして映像を潰す代わりの手当て。vcBarOverlayStyle の注記参照）。
export const vcTimeLabelStyle: React.CSSProperties = {
  fontSize: font.xs, color: 'rgba(255,255,255,0.92)', flexShrink: 0, fontVariantNumeric: 'tabular-nums', letterSpacing: 0,
  textShadow: '0 1px 3px rgba(0,0,0,0.9)'
}

const s: Record<string, React.CSSProperties> = {
  // 秒数は桁が変わる（1秒 ↔ 0.25秒）ので固定幅にしないと、選び直すたびにバーの他の
  // コントロールが左右に動く。
  vcStepBtn: { minWidth: 92, gap: 4, fontSize: font.xs, fontWeight: 800, fontVariantNumeric: 'tabular-nums', letterSpacing: 0, whiteSpace: 'nowrap' },
  // コマ再生が走っていることは一目で分かる必要がある（映像は止まったまま少しずつ動くので、
  // 手で送っているのか自動なのかが画面から区別できないと迷う）。
  vcStepBtnActive: { color: 'var(--accent-text)' },
  // 速さ・音量のポップアップは映像の外へ浮く「メニュー」なので、右クリックメニュー
  // （ContextMenu の menu）とまったく同じ地・枠・角丸・影にする。以前は #171a23 の地に
  // #2b3243 の枠という、ここだけの青灰だった（アプリ本体は中立のグレー）。
  vcStepPopup: { position: 'absolute', bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, padding: 4, display: 'flex', flexDirection: 'column', gap: 2, zIndex: 10, boxShadow: '0 18px 40px rgba(var(--scrim-rgb), 0.42)' },
  vcStepItem: { background: 'none', border: 'none', borderRadius: radius.md, color: 'var(--text-primary)', cursor: 'pointer', padding: '3px 8px', fontSize: font.xs, fontWeight: 700, fontVariantNumeric: 'tabular-nums', textAlign: 'center', whiteSpace: 'nowrap' },
  vcStepItemActive: { background: 'rgba(var(--accent-rgb), 0.22)', color: 'var(--accent-text)' },
  // 選択肢ではなく見出しなので、押せる行と同じ明るさにしない（押せるものと見分けが付かなくなる）。
  vcStepGroup: { display: 'flex', alignItems: 'center', gap: 5, padding: '4px 4px 2px', color: 'var(--text-secondary)', fontSize: font.xs, fontWeight: 700, whiteSpace: 'nowrap' },
  vcStepRule: { flex: 1, height: 1, background: 'rgba(var(--text-rgb), 0.14)' },
  vcLoopActive: { color: 'var(--accent-text)' },
  vcVolPopup: { position: 'absolute', bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, padding: '10px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, boxShadow: '0 18px 40px rgba(var(--scrim-rgb), 0.42)' },
  // ポップアップの中はアプリの面なので、溝も映像用の半透明ホワイトではなくアプリの溝に合わせる。
  vcVolTrack: { position: 'relative', width: 6, height: 60, background: 'var(--bg-inset-strong)', borderRadius: radius.md, cursor: 'pointer', flexShrink: 0 },
  vcVolFill: { position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(var(--accent-rgb), 1)', borderRadius: radius.md },
  // 映像ではなくアプリの面に乗る点なので、こちらは白ではなくアクセントの実色にする
  // （--accent-text は文字用で、ライトの面に置くと塗り潰しの点としては沈む）。
  vcVolThumb: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', width: 12, height: 12, borderRadius: 999, background: 'var(--accent)', boxShadow: '0 0 0 3px rgba(var(--accent-rgb), 0.18)', pointerEvents: 'none' },
}
