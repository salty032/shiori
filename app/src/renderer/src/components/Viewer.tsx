import { useEffect, useRef, useState } from 'react'
import type { ImageRow } from '../types'
import { cleanTitle, mediaUrl, thumbSrc } from '../utils'
import { s } from '../styles'
import { XIcon } from './Icon'
import VideoPlayer, { type VideoPlayerHandle } from './VideoPlayer'
import { getMediaActions, useFeatureOverlayOpen } from '../features/registry'
import { useT } from '../i18n'
import type { Timesheet } from '../hooks/useTimesheet'

// フィルムストリップの 1 枚。サムネ生成失敗（ファイル欠落等）時は
// 割れ画像になるため、フォールバックのプレースホルダに切り替える。
function FilmstripThumb({ img, active, onClick }: { img: ImageRow; active: boolean; onClick: (e: React.MouseEvent) => void }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const style = { ...s.filmstripThumb, ...(active ? s.filmstripThumbActive : {}) }
  if (failed) return <div style={{ ...style, ...s.thumbFallback }} onClick={onClick} />
  return (
    <img src={thumbSrc(img)} style={style} onClick={onClick}
      onError={() => setFailed(true)} alt="" draggable={false} />
  )
}

type Props = {
  images: ImageRow[]
  index: number
  // 表示位置の指示。null で閉じる。呼び出し元（App）がこれを画像 id に読み替えて保持する。
  setIndex: (index: number | null) => void
  // 全体の総数（無限スクロールで未読み込みの分も含む）。カウンタ表示に使う。
  total: number
  titleStrip: string[]
  // 動画のコマ送り（, / .）の刻み幅に使う素材の fps。
  frameFps: number
  // Tab で DetailPanel の表示/非表示を切り替える（呼び出し元が状態を持つ。デフォルトは表示）。
  onToggleDetailPanel: () => void
  // 手打ちのタイムシート。**表そのものは App が詳細パネルの場所に出す**ので、ここは
  // 現在コマを流し込むのと、開いている間キーを譲るのが役目。
  timesheet: Timesheet
}

// 画像の全画面ビューア。ズーム・パン・閉じるアニメ・フィルムストリップは
// すべてビューア内部の状態。開閉位置（index）だけは選択・キャプチャ追従のため親が持つ。
// タグ編集等の詳細情報は DetailPanel（隣に常時表示、ビューアには覆われない）が担う（P1）。
export default function Viewer({ images, index, setIndex, total, titleStrip, frameFps, onToggleDetailPanel, timesheet }: Props) {
  const { t } = useT()
  // トリミング等のオーバーレイに覆われている間は再生を止める（registry の注記を参照）。
  const overlayOpen = useFeatureOverlayOpen()
  const [closing, setClosing] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const imgRef = useRef<HTMLImageElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
  const videoPlayerRef = useRef<VideoPlayerHandle>(null)
  // まずサムネを表示し、原本のデコードが終わったら差し替える（DetailPanel の R-7 と同じ方針）。
  // 矢印キーで連続移動したときにフル解像度デコード待ちで白フラッシュするのを防ぐ。
  const [fullSrc, setFullSrc] = useState<string | null>(null)

  // 画像が切り替わったらズーム・パンをリセット
  useEffect(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [index])

  // 表は詳細パネルの場所（ビューアの外）に出るので、映像を動かす口をここで預ける。
  // ref は描画のあとに埋まるため、依存を付けず毎描画で入れ直す。
  useEffect(() => {
    timesheet.bindPlayer(videoPlayerRef.current)
    return () => timesheet.bindPlayer(null)
  })

  useEffect(() => {
    const current = images[index]
    if (!current) return
    setFullSrc(null)
    let canceled = false
    const preload = new Image()
    preload.onload = () => { if (!canceled) setFullSrc(mediaUrl(current.id)) }
    preload.src = mediaUrl(current.id)
    // 前後1枚は表示には使わないが、先読みしてブラウザキャッシュに載せておく
    // （次に進んだときの preload.onload までの待ちを短くする）。
    for (const n of [images[index - 1], images[index + 1]]) {
      if (n) new Image().src = mediaUrl(n.id)
    }
    return () => { canceled = true }
  }, [images, index])

  function close(): void {
    if (closing) return
    setClosing(true)
    window.setTimeout(() => setIndex(null), 110)
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || Boolean(el?.isContentEditable)
      if (isEditing) return
      // **タイムシートを開いている間は、ぶつかるキーをシートに譲る。**
      // Enter は「確定」であって「閉じる」ではないし、数字はズームではない——東映
      // デジタルタイムシートの操作系をそのまま持ってくるには、ここで先に通すしかない
      // （譲る範囲は useTimesheet の handleKey が持つ。コマ送りと再生はこちらに残る）。
      if (timesheet.handleKey(e)) return
      if (e.code === 'Space') {
        // **Space は「再生/一時停止」だけに使う。** 画像では再生するものが無いので何もしない
        // （閉じるのは Enter / Escape）。以前は画像で閉じていたが、そうすると ← → で画像と
        // 動画をまたぐたびに同じキーの意味が入れ替わり、動画で一時停止のつもりが閉じるという
        // 事故になる。preventDefault だけは残す（既定のスクロールを起こさないため）。
        e.preventDefault()
        if (images[index].media_type === 'video') videoPlayerRef.current?.togglePlay()
        return
      }
      // M は音を消す / 戻す。動画プレーヤーの慣習（YouTube・VLC 等）に合わせる。
      // Space と同じく**動画のときだけ**効かせる（画像には消す音が無い）。
      // 修飾キー付きは既存のショートカットに譲る。
      if (images[index].media_type === 'video' && (e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        videoPlayerRef.current?.toggleMute()
        return
      }
      // コマ送り。動画編集ソフト（Premiere 等）と同じ , / . に合わせる。
      // 日本語配列では「、」「。」の位置がそのまま前コマ・次コマになる。
      if (images[index].media_type === 'video' && (e.key === ',' || e.key === '.')) {
        e.preventDefault()
        videoPlayerRef.current?.stepFrame(e.key === '.' ? 1 : -1)
        return
      }
      // ズームは画像・クリップの区別なく効かせる。**録画の画質を確かめるには等倍以上で
      // 見られることが必須**で、クリップだけ拡大できないと線画の粗（モスキートノイズ）を
      // 目視で判定できない。クリックは再生/一時停止のままにしてあるので意味は衝突しない。
      if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '0') {
        e.preventDefault()
        if (e.key === '0') { setZoom(1); setPan({ x: 0, y: 0 }); return }
        zoomByKeyboard(e.key === '-' ? 0.8 : 1.25)
        return
      }
      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        setIndex(e.key === 'Home' ? 0 : images.length - 1)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        onToggleDetailPanel()
        return
      }
      // Enter は「プレビューの開閉」のトグル（一覧で開き、ここで閉じる）。Quick Look の Space と
      // 同じ 1 つの概念で、開く／閉じるという別々の意味を 1 キーに詰めているわけではない。
      // **狙いと違うものを開いたとき、開いたキーをもう一度押すだけで戻れることが重要**なので、
      // Escape だけにはしない。
      //
      // この役目を Space ではなく Enter が持つのは、Space を「動画の再生/一時停止」専用に
      // 空けるため。Space に開閉も持たせると、← → で画像と動画をまたいだ瞬間に同じキーの
      // 意味が入れ替わる（しかも動画では、止めるつもりが閉じるという実害のある事故になる）。
      if (e.key !== 'Escape' && (e.key !== 'Enter' || e.isComposing)) return
      e.preventDefault()
      close()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closing, images, index, zoom, pan, onToggleDetailPanel, timesheet.handleKey])

  // +/-/0: ホイールズームと同じ倍率係数(1.25/0.8)で、画像の描画矩形中心を基準にズームする
  // （マウスカーソル基準の handleWheel と違い、キーボード操作にはカーソル位置の意味がないため）。
  function zoomByKeyboard(factor: number): void {
    const nextZoom = Math.max(1, Math.min(8, zoom * factor))
    if (nextZoom === zoom) return
    if (nextZoom <= 1) {
      setZoom(1)
      setPan({ x: 0, y: 0 })
      return
    }
    const rect = mediaEl()?.getBoundingClientRect()
    const centerX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2
    const centerY = rect ? rect.top + rect.height / 2 : window.innerHeight / 2
    setPan(clampPan(panForZoomAt(centerX, centerY, nextZoom, zoom, pan), nextZoom))
    setZoom(nextZoom)
  }

  // カーソル直下の画像上の点を動かさずにズームするための pan 補正。
  // transform は scale(zoom) translate(pan/zoom) なので、中心基準のスクリーンオフセットは zoom*p + pan。
  // 同じ点 p をカーソル位置 C に保つには pan1 = C - (C - pan0) * (zoom1/zoom0)。
  function panForZoomAt(clientX: number, clientY: number, nextZoom: number, prevZoom: number, prevPan: { x: number; y: number }): { x: number; y: number } {
    const rect = mediaEl()?.getBoundingClientRect()
    if (!rect) return prevPan
    const cx = clientX - (rect.left + rect.width / 2)
    const cy = clientY - (rect.top + rect.height / 2)
    const ratio = nextZoom / prevZoom
    return { x: cx - (cx - prevPan.x) * ratio, y: cy - (cy - prevPan.y) * ratio }
  }

  // いま表示している媒体の要素と実寸。**画像と動画で同じズームを動かすための 1 か所**。
  // ここを分けると、片方だけ直して他方が取り残される（コマ送りの 2 系統と同じ轍）。
  function mediaEl(): HTMLImageElement | HTMLVideoElement | null {
    return images[index]?.media_type === 'video'
      ? videoPlayerRef.current?.element() ?? null
      : imgRef.current
  }

  function mediaNatural(el: HTMLImageElement | HTMLVideoElement): { w: number; h: number } {
    return el instanceof HTMLVideoElement
      ? { w: el.videoWidth, h: el.videoHeight }
      : { w: el.naturalWidth, h: el.naturalHeight }
  }

  // pan を「媒体の描画矩形（contain 表示の実サイズ）が表示枠から離れない」範囲にクランプする。
  // getBoundingClientRect() は現在の zoom 状態の transform が適用済みのため、
  // 現在の zoom（closure 変数）で割り戻して transform 適用前の枠サイズを求め、
  // そこから targetZoom 時点の描画サイズを計算し直す。
  function clampPan(rawPan: { x: number; y: number }, targetZoom: number): { x: number; y: number } {
    const el = mediaEl()
    if (!el || targetZoom <= 1) return { x: 0, y: 0 }
    const rect = el.getBoundingClientRect()
    const domScale = zoom > 1 ? zoom : 1
    const frameW = rect.width / domScale
    const frameH = rect.height / domScale
    const { w: naturalW, h: naturalH } = mediaNatural(el)
    if (!naturalW || !naturalH || frameW <= 0 || frameH <= 0) return rawPan
    const frameRatio = frameW / frameH
    const mediaRatio = naturalW / naturalH
    const containW = (mediaRatio > frameRatio ? frameW : frameH * mediaRatio) * targetZoom
    const containH = (mediaRatio > frameRatio ? frameW / mediaRatio : frameH) * targetZoom
    const maxX = Math.max(0, (containW - frameW) / 2)
    const maxY = Math.max(0, (containH - frameH) / 2)
    return {
      x: containW > frameW ? Math.min(maxX, Math.max(-maxX, rawPan.x)) : 0,
      y: containH > frameH ? Math.min(maxY, Math.max(-maxY, rawPan.y)) : 0,
    }
  }

  // React 17+ はホイールイベントをルートに passive: true で登録するため、onWheel prop 内の
  // preventDefault は無効（console に intervention 警告が出るだけで効果がない）。
  // ズームには scroll 連鎖の阻止が必須なので、ref に対して passive: false で自前登録する。
  useEffect(() => {
    const el = viewerRef.current
    if (!el) return
    const onWheelNative = (e: WheelEvent): void => {
      e.preventDefault()
      const factor = e.deltaY < 0 ? 1.25 : 0.8
      const nextZoom = Math.max(1, Math.min(8, zoom * factor))
      if (nextZoom === zoom) return
      if (nextZoom <= 1) {
        setZoom(1)
        setPan({ x: 0, y: 0 })
        return
      }
      setPan(clampPan(panForZoomAt(e.clientX, e.clientY, nextZoom, zoom, pan), nextZoom))
      setZoom(nextZoom)
    }
    el.addEventListener('wheel', onWheelNative, { passive: false })
    return () => el.removeEventListener('wheel', onWheelNative)
  }, [zoom, pan, images, index])

  function toggleZoomAt(clientX: number, clientY: number): void {
    if (zoom > 1) {
      setZoom(1)
      setPan({ x: 0, y: 0 })
      return
    }
    setPan(clampPan(panForZoomAt(clientX, clientY, 2, 1, { x: 0, y: 0 }), 2))
    setZoom(2)
  }

  // S7-20: ネイティブ dblclick は「連続クリック列（click streak）」の中では最初の1回
  // （detail が 1→2 になった瞬間）しか発火せず、間を置かず3回目・4回目とクリックを続けても
  // （移動量ゼロでも）再発火しないことを実機ログで確認した。ユーザーが「反応しない」と感じて
  // 焦って連打するほど同じ streak に巻き込まれて悪化するため、ネイティブ dblclick には頼らず
  // pointerdown の時刻・距離だけで自前にダブルプレスを判定する（ズームの両方向で共通）。
  const DOUBLE_PRESS_MS = 400
  const DOUBLE_PRESS_PX = 24
  const lastPointerDownRef = useRef<{ time: number; x: number; y: number } | null>(null)

  // ドラッグ開始しきい値。pointerdown 即 setPointerCapture すると、実際には動かしていない
  // ただのクリックまで「ドラッグ開始」として扱われてしまうため、実際に一定距離動いてから
  // 初めてドラッグとして capture する。手ブレによるクリック中の数px程度の揺れは正常な範囲のため、
  // それより十分大きい値にする（小さすぎると通常のクリックでも簡単にドラッグ判定に入ってしまう）。
  const DRAG_START_THRESHOLD_PX = 8
  function handleImagePointerDown(e: React.PointerEvent<HTMLImageElement>): void {
    const now = performance.now()
    const last = lastPointerDownRef.current
    const isDoublePress = last !== null
      && now - last.time <= DOUBLE_PRESS_MS
      && Math.abs(e.clientX - last.x) <= DOUBLE_PRESS_PX
      && Math.abs(e.clientY - last.y) <= DOUBLE_PRESS_PX
    lastPointerDownRef.current = isDoublePress ? null : { time: now, x: e.clientX, y: e.clientY }
    if (isDoublePress) {
      toggleZoomAt(e.clientX, e.clientY)
      return
    }
    startPanDrag(e)
  }

  // 拡大中に掴んで動かす。**クリップでは映像そのものではなく外枠に付ける**
  // （映像のクリックは再生/一時停止で埋まっているため）。ドラッグしたときは
  // draggedRef を立て、離した直後のクリックを飲む（掴んで放すたびに再生が
  // 切り替わると、コマを見比べている最中に画が動いてしまう）。
  const draggedRef = useRef(false)

  function startPanDrag(e: React.PointerEvent): void {
    if (zoom <= 1) return
    // 映像そのものの上でだけ掴む。外枠に付けている都合でコントロール（シークバー・音量）にも
    // 届いてしまい、掴んだままだとシーク操作とパンが同時に走る。
    if (e.target !== mediaEl()) return
    const target = e.target as HTMLElement
    const pointerId = e.pointerId
    const startClientX = e.clientX
    const startClientY = e.clientY
    const startPan = pan
    let dragging = false
    const onMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - startClientX
      const dy = ev.clientY - startClientY
      if (!dragging) {
        if (Math.abs(dx) < DRAG_START_THRESHOLD_PX && Math.abs(dy) < DRAG_START_THRESHOLD_PX) return
        dragging = true
        draggedRef.current = true
        ev.preventDefault()
        target.setPointerCapture(pointerId)
      }
      setPan(clampPan({ x: startPan.x + dx, y: startPan.y + dy }, zoom))
    }
    const onUp = (): void => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function isInsideContainedMedia(el: HTMLElement, clientX: number, clientY: number, mediaWidth: number, mediaHeight: number): boolean {
    if (mediaWidth <= 0 || mediaHeight <= 0) return true
    const rect = el.getBoundingClientRect()
    const frameRatio = rect.width / rect.height
    const mediaRatio = mediaWidth / mediaHeight
    const drawnWidth = mediaRatio > frameRatio ? rect.width : rect.height * mediaRatio
    const drawnHeight = mediaRatio > frameRatio ? rect.width / mediaRatio : rect.height
    const left = rect.left + (rect.width - drawnWidth) / 2
    const top = rect.top + (rect.height - drawnHeight) / 2
    return clientX >= left && clientX <= left + drawnWidth && clientY >= top && clientY <= top + drawnHeight
  }

  function handleImageClick(e: React.MouseEvent<HTMLImageElement>): void {
    if (zoom > 1 || isInsideContainedMedia(e.currentTarget, e.clientX, e.clientY, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)) {
      e.stopPropagation()
    }
  }

  function handleVideoClick(e: React.MouseEvent<HTMLVideoElement>): boolean {
    // パンし終えた直後のクリックは飲む（false = 再生も切り替えないし閉じもしない）。
    if (draggedRef.current) {
      draggedRef.current = false
      return false
    }
    // 拡大中は「枠の外＝映像の外」ではない（transform で映像が枠をはみ出している）ので、
    // 余白判定で閉じない。画像側が zoom > 1 のとき伝播を止めているのと同じ理由。
    if (zoom > 1) return true
    if (isInsideContainedMedia(e.currentTarget, e.clientX, e.clientY, e.currentTarget.videoWidth, e.currentTarget.videoHeight)) {
      return true
    }
    close()
    return false
  }

  const img = images[index]
  const filmSlots = Array.from({ length: 9 }, (_, i) => index - 4 + i)
  const title = img.title ? cleanTitle(img.title, titleStrip) : ''

  return (
    <div ref={viewerRef} style={{ ...s.viewer, animation: closing ? 'shioriPopOut 0.11s ease-out forwards' : 'shioriPopIn 0.15s ease-out' }} onClick={close}>
      <div style={s.viewerTopBar} onClick={(e) => e.stopPropagation()}>
        <div style={s.viewerTitle} title={title}>{title}</div>
        <div style={s.viewerActions}>
          {/* U-6: End は読み込み済み分の末尾（images.length-1）までしか移動しないため、
              未読み込みが残る間はカウンタと End の到達点がズレる。実害は小さい
              （後続ロードで辿れる）ため、挙動は変えずツールチップで補足するに留める。 */}
          {getMediaActions(img, { close })}
          {/* 撮り逃し 0 のクリップでしか出ない。出ていない理由を説明する文言は置かない
              （出ない＝このクリップでは保証できない、という一点だけが意味）。 */}
          {timesheet.ready && (
            <button
              style={{ ...s.viewerClose, color: timesheet.open ? 'rgba(255,255,255,0.92)' : '#999', fontSize: 11, fontWeight: 800 }}
              onClick={() => timesheet.setOpen(!timesheet.open)}
              title={t('timesheet.toggle')}>
              {t('timesheet.title')}
            </button>
          )}
          <span style={s.viewerCounter} title={images.length < total ? t('viewer.endHint') : undefined}>{index + 1} / {Math.max(total, images.length)}</span>
          <button data-tour="viewer-close" style={s.viewerClose} onClick={close} title={t('viewer.close')}><XIcon size={15} /></button>
        </div>
      </div>
      <div
        style={{
          ...s.viewerMediaStack,
          cursor: img.media_type === 'video' && zoom > 1 ? 'grab' : undefined,
        }}
        onPointerDown={img.media_type === 'video' ? startPanDrag : undefined}>
        {img.media_type === 'video' ? (
          <VideoPlayer ref={videoPlayerRef} id={img.id} wrapperStyle={s.viewerMediaFrame}
            videoStyle={{
              ...s.viewerImg,
              transform: zoom > 1 ? `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)` : undefined,
            }}
            autoPlay pauseWhen={overlayOpen} fps={img.fps ?? frameFps} showRateLoop preloadFrameTable clipSource={img.source} onVideoClick={handleVideoClick}
            onFramesReady={timesheet.onFramesReady} onFrameIndex={timesheet.onFrameIndex} />
        ) : (
          <img
            ref={imgRef}
            src={fullSrc ?? thumbSrc(img)}
            style={{
              ...s.viewerImg,
              transform: zoom > 1 ? `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)` : undefined,
              cursor: zoom > 1 ? 'grab' : 'default',
            }}
            onPointerDown={handleImagePointerDown}
            onClick={handleImageClick}
            alt=""
            draggable={false}
          />
        )}
      </div>
      {zoom > 1 && (
        <div style={s.viewerZoomHud} onClick={(e) => e.stopPropagation()}>
          <span style={s.viewerZoomValue}>{Math.round(zoom * 100)}%</span>
        </div>
      )}

      {index > 0 && (
        <button style={{ ...s.viewerArrow, left: 16 }}
          onClick={(e) => { e.stopPropagation(); setIndex(index - 1) }}
          title={t('viewer.prev')}>
          <svg width="10" height="18" viewBox="0 0 10 18" fill="none"><polyline points="9,1 1,9 9,17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      )}
      {index < images.length - 1 && (
        <button style={{ ...s.viewerArrow, right: 16 }}
          onClick={(e) => { e.stopPropagation(); setIndex(index + 1) }}
          title={t('viewer.next')}>
          <svg width="10" height="18" viewBox="0 0 10 18" fill="none"><polyline points="1,1 9,9 1,17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      )}
      <div style={s.filmstrip}>
        {filmSlots.map((absIdx) => {
          const fImg = images[absIdx]
          if (!fImg) return <div key={`empty-${absIdx}`} style={s.filmstripThumbPlaceholder} />
          return (
            <FilmstripThumb
              key={fImg.id}
              img={fImg}
              active={absIdx === index}
              onClick={(e) => { e.stopPropagation(); setIndex(absIdx) }}
            />
          )
        })}
      </div>
    </div>
  )
}
