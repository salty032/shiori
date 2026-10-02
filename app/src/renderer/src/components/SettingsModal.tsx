import { useState, useRef, useEffect } from 'react'
import type { Settings, ExtensionTimecode, StorageInfo } from '../types'
import { color, font, space } from '../styles'
import { buildAccelerator, formatBytes } from '../utils'
import { normalizeCaptureHotkey } from '../../../shared/hotkey'
import { XIcon } from './Icon'
import SettingsDataTab from './SettingsDataTab'
import { s } from './settingsStyles'
import { useFocusTrap } from '../hooks/useFocusTrap'
import ClipHotkeySettings from '../video/ClipHotkeySettings'
import { useT } from '../i18n'
import { allReleaseNotes, type ReleaseNoteEntry } from '../../../shared/releaseNotes'
import type { MessageKey } from '../../../shared/i18n'

export { s } from './settingsStyles'

type Props = {
  settings: Settings
  startup: boolean
  taggerReady: boolean
  taggerProgress: number | null
  retagProgress: { current: number; total: number } | null
  extensionStatus: { lastSeenAt: number; data: ExtensionTimecode } | null
  onClose: () => void
  onToggleStartup: () => void
  onUpdateFrameFps: (fps: number) => void
  onUpdateFrameFpsAuto: (enabled: boolean) => void
  onUpdateCaptureHotkey: (hotkey: string) => Promise<boolean>
  onUpdateCaptureNotify: (enabled: boolean) => void
  onUpdateShowAiTags: (enabled: boolean) => void
  onUpdateTheme: (theme: Settings['theme']) => void
  onUpdateVideoExportFormat: (value: Settings['videoExportFormat']) => void
  onUpdateCaptureResize: (value: Settings['captureResize']) => void
  onUpdateLanguage: (language: Settings['language']) => void
  onTaggerDownload: () => void
  onTaggerCancelDownload: () => void
  onTaggerDelete: () => void
  onTaggerRetagAll: () => void
  onShareExport: () => Promise<{ canceled: boolean; count?: number; path?: string }>
  onShareImport: () => Promise<{ canceled: boolean; count?: number; errors?: string[]; importedFolders?: number }>
  /** 「情報」タブから変更点モーダルを開く（設定画面自身は中身を持たない） */
  onShowWhatsNew: (entries: ReleaseNoteEntry[]) => void
}

const CLOSE_MS = 110

// M-4: 表示ラベルと状態識別子を分離する（ラベル文言の変更が型・状態キーの変更を兼ねないように）。
type TabId = 'general' | 'capture' | 'tag' | 'data' | 'about'
const TABS: { id: TabId; labelKey: MessageKey }[] = [
  { id: 'general', labelKey: 'settings.tab.general' },
  { id: 'capture', labelKey: 'settings.tab.capture' },
  { id: 'tag', labelKey: 'settings.tab.tag' },
  { id: 'data', labelKey: 'settings.tab.data' },
  { id: 'about', labelKey: 'settings.tab.about' },
]

export function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      style={{ ...s.toggleSwitch, ...(checked ? s.toggleSwitchOn : {}) }}
      onClick={() => onChange(!checked)}
    >
      <span style={{ ...s.toggleKnob, ...(checked ? s.toggleKnobOn : {}), transform: checked ? 'translateX(18px)' : 'translateX(0)' }} />
    </button>
  )
}

export default function SettingsModal(p: Props) {
  const { t } = useT()
  const [capturing, setCapturing] = useState(false)
  const [capturedAccel, setCapturedAccel] = useState<string | null>(null)
  const [hotkeyError, setHotkeyError] = useState<string | null>(null)
  const captureRef = useRef<HTMLDivElement>(null)
  // 登録スロット（録画ホットキー変更など）が独自にキー入力キャプチャ中かどうか。
  // SettingsModal 自身の capturing とは独立に管理し、Escape 自動クローズの抑止に使う。
  const [clipCapturing, setClipCapturing] = useState(false)
  // extensionStatus は最後に受信したイベントのスナップショットなので、拡張を無効化したり
  // ブラウザを閉じたりしても「受信中」のまま変わらない。モーダル表示中は定期的に
  // lastSeenAt からの経過時間を見て、タイムコード送信間隔（5秒）の3回分途絶えたら
  // 「未受信」とみなす。
  const EXTENSION_TIMEOUT_MS = 15_000
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  // 自動アップデートが適用されたかをいつでも確認できるよう、データタブにバージョンを表示する
  const [appVersion, setAppVersion] = useState<string | null>(null)
  useEffect(() => {
    window.api.getAppVersion().then(setAppVersion).catch(() => {})
  }, [])
  // 変更点の文面は shared にあるので main へ問い合わせずに引ける（更新直後の自動表示は
  // bootstrap.ts が push する。**同じ 1 本の RELEASE_NOTES を見ていること**）。
  // 今の版だけでなく収録分すべてを渡す。**今の版に文面が無くても押せる**——ここは
  // 読み返し用で、押せなくなると過去の版まで道連れに読めなくなる。
  const history = allReleaseNotes(p.settings.language)
  // 拡張と繋がるポート。候補を全部確保できなかったときは null で、この場合は拡張を入れ直しても
  // ページを再読み込みしても直らない（原因がアプリの外にある）。未取得の undefined と区別する。
  const [wsPort, setWsPort] = useState<number | null | undefined>(undefined)
  useEffect(() => {
    window.api.getWsPort().then(setWsPort).catch(() => setWsPort(null))
  }, [])
  const wsPortUnavailable = wsPort === null
  const extensionConnected = p.extensionStatus !== null && now - p.extensionStatus.lastSeenAt <= EXTENSION_TIMEOUT_MS
  // 拡張の更新案内は起動直後のOS通知1回だけで見逃しやすいため、受信中の拡張バージョンが
  // バンドル済み最新版と食い違っていれば設定画面にもバッジで出す（UX-9）。
  const extensionVersionMismatch = extensionConnected && p.extensionStatus?.data.versionMismatch === true

  // モーダル表示中はすべてのキーイベントの window 伝搬を遮断する
  useEffect(() => {
    const block = (e: KeyboardEvent): void => {
      e.stopPropagation()
      if (e.key === 'Escape' && !capturing && !clipCapturing) closeSettings()
    }
    document.addEventListener('keydown', block)
    return () => document.removeEventListener('keydown', block)
  }, [capturing, clipCapturing])

  useEffect(() => {
    if (!capturing) return
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.key === 'Escape') { setCapturing(false); setCapturedAccel(null); setHotkeyError(null); return }
      const accel = buildAccelerator(e)
      if (!accel) return
      // main（hotkey.ts）と同じ正規化規則で事前検証する（Q4）。ここを通さないと
      // UI 側だけが「キャプチャできた」ように見えて、確定時に main 側の
      // normalizeCaptureHotkey が拒否し「競合しています」という不正確なエラーになる。
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

  const [activeTab, setActiveTab] = useState<TabId>('general')

  // 保存場所と使用量。全ファイルを stat するので数万件では数秒かかる。モーダルを開くたびに
  // 走らせると「基本」タブだけ見て閉じる人にも毎回コストがかかるため、実際に数字を出す
  // タブ（データ・タグ）へ切り替わった最初の一回だけ取りに行く。
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [storageLoading, setStorageLoading] = useState(false)
  const [storageFailed, setStorageFailed] = useState(false)
  const storageRequested = useRef(false)
  useEffect(() => {
    if (activeTab !== 'data' && activeTab !== 'tag') return
    if (storageRequested.current) return
    storageRequested.current = true
    setStorageLoading(true)
    window.api.getStorageInfo()
      .then(setStorage)
      .catch((err) => {
        console.error('[settings] storage info failed', err)
        setStorageFailed(true)
      })
      .finally(() => setStorageLoading(false))
  }, [activeTab])

  // fps カスタム数値入力は1打鍵ごとに保存すると IPC + 拡張への再送が無駄に多い（R-3）。
  // ローカル state に持ち、300ms 入力が止まってから確定する。プリセットボタン側は
  // 即時反映のままでよいので、外部から settings.frameFps が変わったときだけ同期する。
  const FPS_INPUT_DEBOUNCE_MS = 300
  const [fpsInputDraft, setFpsInputDraft] = useState(String(p.settings.frameFps))
  const fpsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fpsInputDraftRef = useRef(fpsInputDraft)
  useEffect(() => {
    const value = String(p.settings.frameFps)
    setFpsInputDraft(value)
    fpsInputDraftRef.current = value
  }, [p.settings.frameFps])
  useEffect(() => () => { if (fpsDebounceRef.current) clearTimeout(fpsDebounceRef.current) }, [])

  function flushPendingFps(): void {
    if (!fpsDebounceRef.current) return
    clearTimeout(fpsDebounceRef.current)
    fpsDebounceRef.current = null
    const raw = fpsInputDraftRef.current
    const value = Number(raw)
    if (raw && value >= 1 && value <= 60) p.onUpdateFrameFps(value)
  }

  const [closing, setClosing] = useState(false)

  function closeSettings(): void {
    if (closing) return
    flushPendingFps()
    setClosing(true)
    window.setTimeout(p.onClose, CLOSE_MS)
  }

  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true)

  // 設定を開いている間、パネルの外で回したホイールは黙って捨てる。
  //
  // 幕（overlay）を敷いているのにカーソルを裏へ置いて回すと、背後の一覧が動いていた。
  // overscroll-behavior はスクロールする箱にしか効かず、幕そのものはスクロールしないので
  // ここには届かない。**どの箱が動いたかを突き止めて塞ぐのではなく、「パネルの外では
  // 何も動かない」という結果の側で決める**——背後には一覧・サイドバー・右パネルと
  // スクロールする箱が3つあり、1つずつ塞ぐと次に足した箱で同じことが起きる。
  //
  // capture かつ passive: false で登録する。React が付けるホイールは passive なので、
  // onWheel prop 側では preventDefault が効かない（Viewer.tsx と同じ理由）。
  useEffect(() => {
    const block = (e: WheelEvent): void => {
      // 通す条件は「設定のパネルの中か」ではなく「どれかのモーダルの中か」。設定の上に
      // さらにモーダルが乗ることがあり（「変更点」）、自分のパネルだけを通していると、
      // その中の一覧がホイールで動かなくなる。目印は data-modal——背後の一覧・サイドバー・
      // 右パネルには付いていないので、幕の裏が動かないことは変わらない。
      if ((e.target as HTMLElement | null)?.closest?.('[data-modal]')) return
      e.preventDefault()
    }
    document.addEventListener('wheel', block, { passive: false, capture: true })
    return () => document.removeEventListener('wheel', block, { capture: true })
  }, [])

  return (
    <div style={{ ...s.overlay, animation: closing ? 'shioriOverlayOut 0.11s ease-out forwards' : 'shioriOverlayIn 0.12s ease-out' }} onMouseDown={closeSettings}>
      <div style={{ ...s.panel, animation: closing ? 'shioriPopOut 0.11s ease-out forwards' : 'shioriPopIn 0.15s ease-out' }} ref={panelRef} onMouseDown={(e) => e.stopPropagation()} data-modal>
        <div style={s.header}>
          <span style={s.title}>{t('menu.settings')}</span>
          <button style={s.close} onClick={closeSettings} title={t('action.close')}><XIcon size={17} /></button>
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div style={s.sidebar}>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                className={activeTab === tab.id ? undefined : 'shiori-menu-item'}
                data-current={activeTab === tab.id ? 'true' : undefined}
                style={{ ...s.tabBtn, ...(activeTab === tab.id ? s.tabBtnActive : {}) }}
                onClick={() => setActiveTab(tab.id)}
              >
                {t(tab.labelKey)}
              </button>
            ))}
          </div>

          <div style={s.tabContent}>
            {activeTab === 'general' && (
              <>
                <div style={{ ...s.group, ...s.groupFirst }}>
                  <div style={s.section}>{t('settings.appearance')}</div>
                  <div style={s.row}>
                    <span style={s.label}>{t('settings.theme')}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: space.x4 }}>
                      {([['system', t('settings.theme.system')], ['dark', t('settings.theme.dark')], ['light', t('settings.theme.light')]] as const).map(([value, label]) => {
                        const active = p.settings.theme === value
                        return (
                          <button key={value} onClick={() => p.onUpdateTheme(value)} data-current={active ? 'true' : undefined}
                            style={{ ...s.sizeBtn, background: active ? 'var(--bg-surface-hover)' : 'transparent', color: active ? 'var(--accent-text)' : 'var(--text-secondary)', borderColor: active ? 'var(--accent)' : 'var(--border-default)' }}>
                            {label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <div style={s.row}>
                    <span style={s.label}>{t('settings.language')}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: space.x4 }}>
                      {([['ja', '日本語'], ['en', 'English']] as const).map(([value, label]) => {
                        const active = p.settings.language === value
                        return (
                          <button key={value} onClick={() => p.onUpdateLanguage(value)} data-current={active ? 'true' : undefined}
                            style={{ ...s.sizeBtn, background: active ? 'var(--bg-surface-hover)' : 'transparent', color: active ? 'var(--accent-text)' : 'var(--text-secondary)', borderColor: active ? 'var(--accent)' : 'var(--border-default)' }}>
                            {label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
                <div style={s.group}>
                  <div style={s.section}>{t('settings.startup')}</div>
                  <div style={s.toggleRow}>
                    <span style={s.label}>{t('settings.startOnLogin')}</span>
                    <ToggleSwitch checked={p.startup} onChange={() => p.onToggleStartup()} />
                  </div>
                </div>
                <div style={s.group}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: space.x8 }}>
                    <div style={s.section}>{t('settings.extension')}</div>
                    <span style={{ ...s.statusBadge, ...(wsPortUnavailable ? s.statusWarn : extensionVersionMismatch ? s.statusWarn : extensionConnected ? s.statusOk : s.statusMuted) }}>
                      {t(wsPortUnavailable ? 'settings.extPortBlocked' : extensionVersionMismatch ? 'settings.extReloadNeeded' : extensionConnected ? 'settings.extConnected' : 'settings.extDisconnected')}
                    </span>
                  </div>
                  <div style={s.actionRow}>
                    <div style={s.hint}>
                      {/* ポートを1つも確保できていないなら、拡張を入れ直してもページを再読み込みしても
                          直らない（原因がアプリの外にある）。ここで従来の案内を出すと、直らない手順を
                          延々と繰り返させることになるので、先に理由へ差し替える。 */}
                      {wsPortUnavailable
                        ? t('settings.extPortBlockedHint')
                        : extensionVersionMismatch
                          ? t('settings.extReloadHint')
                          : t('settings.extStatusHint')}
                    </div>
                    {!wsPortUnavailable && (!extensionConnected || extensionVersionMismatch) && (
                      <button style={s.addBtn} onClick={() => window.api.showExtensionFolder()}>
                        {t('onboarding.openExtensionFolder')}
                      </button>
                    )}
                  </div>
                  {/* 繋がらないときに自分で確かめられる唯一の手掛かりなので、正常時も出しておく
                      （不調になってから探しても、そのときには表示が出ない状態になっている）。 */}
                  {wsPort != null && (
                    <div style={s.hint}>{t('settings.extPort', { port: String(wsPort) })}</div>
                  )}
                </div>
              </>
            )}

            {activeTab === 'capture' && (
              <>
                <div style={{ ...s.group, ...s.groupFirst }}>
                  <div style={s.section}>{t('settings.hotkey')}</div>
                  <div style={s.row}>
                    <span style={s.label}>{t('settings.captureHotkey')}</span>
                    {capturing ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: space.x4 }}>
                        <div ref={captureRef} style={s.hotkeyCapture}>
                          {capturedAccel || t('hotkey.pressKeys')}
                        </div>
                        <button style={s.sizeBtn} disabled={!capturedAccel} onClick={async () => {
                          if (!capturedAccel) return
                          const ok = await p.onUpdateCaptureHotkey(capturedAccel)
                          if (ok) { setCapturing(false); setHotkeyError(null) }
                          else setHotkeyError(t('hotkey.conflict'))
                        }}>{t('action.confirm')}</button>
                        <button style={s.sizeBtn} onClick={() => { setCapturing(false); setCapturedAccel(null); setHotkeyError(null) }}>{t('action.cancel')}</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: space.x8 }}>
                        <span style={s.hotkeyBadge}>{p.settings.captureHotkey}</span>
                        <button style={s.sizeBtn} onClick={() => { setCapturing(true); setCapturedAccel(null); setHotkeyError(null) }}>{t('action.change')}</button>
                      </div>
                    )}
                  </div>
                  {hotkeyError && <div style={{ fontSize: font.sm, color: color.danger }}>{hotkeyError}</div>}
                  <ClipHotkeySettings onCapturingChange={setClipCapturing} placement="hotkey" />
                </div>
                {/* UX-8: コマ送り(, / .)もキャプチャ体験の設定のため「基本」タブから移動 */}
                <div style={s.group}>
                  <div style={s.section}>{t('settings.frameStep')}</div>
                  <div style={s.row}>
                    <span style={s.label}>FPS</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: space.x8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: space.x8, color: 'var(--text-secondary)', fontSize: font.base }}>
                        <ToggleSwitch checked={p.settings.frameFpsAuto} onChange={p.onUpdateFrameFpsAuto} />
                        {t('settings.autoDetect')}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: space.x4, opacity: p.settings.frameFpsAuto ? 0.35 : 1, pointerEvents: p.settings.frameFpsAuto ? 'none' : 'auto' }}>
                        {[24, 30, 60].map((fps) => {
                          const active = p.settings.frameFps === fps
                          return (
                            <button key={fps} onClick={() => p.onUpdateFrameFps(fps)} data-current={active ? 'true' : undefined}
                              style={{ ...s.sizeBtn, background: active ? 'rgba(var(--accent-rgb), 0.16)' : 'transparent', color: active ? 'var(--accent-text)' : 'var(--text-secondary)', borderColor: active ? 'rgba(var(--accent-rgb), 0.4)' : 'var(--border-default)' }}>
                              {fps}
                            </button>
                          )
                        })}
                        <input type="number" min={1} max={60} value={fpsInputDraft}
                          onChange={(e) => {
                             const raw = e.target.value
                             setFpsInputDraft(raw)
                             fpsInputDraftRef.current = raw
                             if (fpsDebounceRef.current) clearTimeout(fpsDebounceRef.current)
                             fpsDebounceRef.current = null
                             const v = Number(raw)
                             if (!raw || !(v >= 1 && v <= 60)) return
                             fpsDebounceRef.current = setTimeout(() => {
                               fpsDebounceRef.current = null
                               p.onUpdateFrameFps(v)
                             }, FPS_INPUT_DEBOUNCE_MS)
                          }}
                          onBlur={() => {
                            if (!fpsDebounceRef.current) return
                            clearTimeout(fpsDebounceRef.current)
                            fpsDebounceRef.current = null
                            const raw = fpsInputDraftRef.current
                            const v = Number(raw)
                            if (raw && v >= 1 && v <= 60) p.onUpdateFrameFps(v)
                            else setFpsInputDraft(String(p.settings.frameFps))
                          }}
                          style={{ ...s.input, width: 52, textAlign: 'center' as const, padding: '6px 4px' }} />
                        <span style={{ color: 'var(--text-secondary)', fontSize: font.base }}>fps</span>
                      </div>
                    </div>
                  </div>
                  <div style={s.hint}>{t('settings.fpsHint')}</div>
                </div>
                <div style={s.group}>
                  <div style={s.section}>{t('settings.notifications')}</div>
                  <div style={s.toggleRow}>
                    <span style={s.label}>{t('settings.notifyOnCapture')}</span>
                    <ToggleSwitch checked={p.settings.captureNotify ?? true} onChange={p.onUpdateCaptureNotify} />
                  </div>
                  <ClipHotkeySettings onCapturingChange={setClipCapturing} placement="notification" />
                </div>
              </>
            )}

            {activeTab === 'tag' && (
              <>
                <div style={{ ...s.group, ...s.groupFirst }}>
                  <div style={s.section}>{t('settings.autoTagging')}</div>
                  <div style={s.hint}>{t('settings.autoTaggingHint')}</div>
                  {p.taggerReady ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: space.x8 }}>
                      {/* 数百MBの実体に「削除」だけがあり、押していいか判断する材料が無かった。
                          消える容量を削除ボタンと同じ行に出す。 */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: space.x8 }}>
                          <span style={{ ...s.statusBadge, ...s.statusOk }}>{t('settings.taggerReady')}</span>
                          {storage && storage.modelBytes > 0 && (
                            <span style={s.usageValue}>{formatBytes(storage.modelBytes)}</span>
                          )}
                        </div>
                        <button style={s.deleteBtn} onClick={p.onTaggerDelete}>{t('settings.deleteModel')}</button>
                      </div>
                      {p.retagProgress ? (
                        <div style={s.progressWrap}>
                          <div style={s.progressBar}>
                            <div style={{ ...s.progressFill, width: `${p.retagProgress.total > 0 ? Math.round(p.retagProgress.current / p.retagProgress.total * 100) : 0}%` }} />
                          </div>
                          <span style={s.progressLabel}>{p.retagProgress.current}/{p.retagProgress.total}</span>
                        </div>
                      ) : (
                        <div style={s.actionRow}>
                          <div style={s.hint}>{t('settings.retagHint')}</div>
                          <button style={s.addBtn} onClick={p.onTaggerRetagAll}>
                            {t('settings.retagButton')}
                          </button>
                        </div>
                      )}
                    </div>
                  ) : p.taggerProgress !== null ? (
                    <div style={s.progressWrap}>
                      <div style={s.progressBar}>
                        <div style={{ ...s.progressFill, width: `${Math.round(p.taggerProgress * 100)}%` }} />
                      </div>
                      <span style={s.progressLabel}>{Math.round(p.taggerProgress * 100)}%</span>
                      <button style={s.cancelBtn} onClick={p.onTaggerCancelDownload}>{t('action.stop')}</button>
                    </div>
                  ) : (
                    <div style={s.actionRow}>
                      <div style={s.hint}>{t('settings.modelSaveHint')}</div>
                      <button style={s.addBtn} onClick={p.onTaggerDownload}>
                        {t('settings.downloadModel')}
                      </button>
                    </div>
                  )}
                </div>
                <div style={s.group}>
                  <div style={s.section}>{t('settings.sidebarDisplay')}</div>
                  <div style={s.toggleRow}>
                    <span style={s.label}>{t('settings.showAiTags')}</span>
                    <ToggleSwitch checked={p.settings.showAiTags ?? false} onChange={p.onUpdateShowAiTags} />
                  </div>
                  <div style={s.hint}>{t('settings.showAiTagsHint')}</div>
                </div>
              </>
            )}

            {/* タブ切替で実行中の状態・結果を失わないよう、非表示でもマウントを保つ。 */}
            <SettingsDataTab
              active={activeTab === 'data'}
              settings={p.settings}
              storage={storage}
              storageLoading={storageLoading}
              storageFailed={storageFailed}
              onStorageChanged={setStorage}
              onUpdateVideoExportFormat={p.onUpdateVideoExportFormat}
              onUpdateCaptureResize={p.onUpdateCaptureResize}
              onShareExport={p.onShareExport}
              onShareImport={p.onShareImport}
            />

            {activeTab === 'about' && (
              <>
                {/* バージョンとクレジットは操作対象ではないので、右側にボタンを置く actionRow は
                    使わず見出し＋説明だけにする。以前は他と同じ「左に見出し・右にボタン」の
                    カードに入っていて、右半分が空いたまま操作できそうな見た目になっていた。 */}
                <div style={{ ...s.group, ...s.groupFirst }}>
                  <div style={s.section}>{t('settings.version')}</div>
                  <div style={s.actionRow}>
                    <div style={s.hint}>Shiori {appVersion ? `v${appVersion}` : '—'}</div>
                    {/* 変更点はここに置く。版と同じ「このアプリ自体の話」で、性格が揃う。
                        以前はサイドバー下部に常時リンクを出していたが、使い方・報告と 3 つ
                        並ぶと幅に入らず 2 行へ折り返していた。更新直後は勝手に出るので、
                        ここは読み返し用でしかない——だから今の版だけでなく、収録されている
                        版を全部渡す。
                        文面が 1 件も無いときだけ出さない。押しても空のモーダルが開くだけで、
                        「まだ書いていない」と「変更が無かった」の区別も付かない。 */}
                    {history.length > 0 && (
                      <button style={s.sizeBtn} onClick={() => p.onShowWhatsNew(history)}>
                        {t('help.whatsNew')}
                      </button>
                    )}
                  </div>
                </div>
                {/* Icons8 の無料ライセンスはアプリ内のクレジット表示とリンクを条件にしている。
                    他のサードパーティ表記も同じ場所にまとめ、詳細は NOTICE.md に委ねる。 */}
                <div style={s.group}>
                  <div style={s.section}>{t('settings.credits')}</div>
                  <div style={s.hint}>
                    {t('settings.creditIcons')}<button style={s.creditLink} onClick={() => window.api.openUrl('https://icons8.com')}>Icons8</button>
                    {' ／ '}
                    {t('settings.creditTagger')}<button style={s.creditLink} onClick={() => window.api.openUrl('https://huggingface.co/SmilingWolf/wd-vit-tagger-v3')}>WD ViT Tagger v3</button>
                    {' ／ '}
                    {t('settings.creditVideo')}<button style={s.creditLink} onClick={() => window.api.openUrl('https://ffmpeg.org')}>FFmpeg</button>
                  </div>
                  <div style={s.hint}>{t('settings.creditsHint')}</div>
                </div>
              </>
            )}

          </div>
        </div>
      </div>
    </div>
  )
}
