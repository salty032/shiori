import { useState, useRef, useEffect } from 'react'
import type { Settings, ExtensionTimecode, StorageInfo } from '../types'
import { font, color, modal, radius, space, control } from '../styles'
import { buildAccelerator, formatBytes } from '../utils'
import { normalizeCaptureHotkey } from '../../../shared/hotkey'
import { XIcon } from './Icon'
import { useExportStore } from '../stores/exportStore'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { getSettingsSlots } from '../features/registry'
import { useT } from '../i18n'
import { releaseNotesFor } from '../../../shared/releaseNotes'
import type { MessageKey } from '../../../shared/i18n'

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
  onShowWhatsNew: (version: string, notes: string[]) => void
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
  const { t, tp } = useT()
  const [shareExportStatus, setShareExportStatus] = useState<{ text: string; error?: boolean } | null>(null)
  const [shareImportStatus, setShareImportStatus] = useState<{ text: string; error?: boolean } | null>(null)
  const [shareExporting, setShareExporting] = useState(false)
  const [repairStatus, setRepairStatus] = useState<{ text: string; error?: boolean } | null>(null)
  const [repairing, setRepairing] = useState(false)
  const [shareImporting, setShareImporting] = useState(false)
  // D-2/UX-3: 進捗の購読自体は App.tsx が全体で行い exportStore に一元化している
  // （モーダルを閉じても進捗・中止ボタンが見え続けるようにするため）。ここではそれを読むだけ。
  const shareImportProgress = useExportStore((st) => st.shareImportProgress)
  // export:progress・中止ボタンは images/share の1系統しか持たないため、選択エクスポートが
  // 進行中は共有書き出しを disabled にして混線を防ぐ（B-6）。
  const otherExportActive = useExportStore((st) => st.exportKind === 'images')
  const [capturing, setCapturing] = useState(false)
  const [capturedAccel, setCapturedAccel] = useState<string | null>(null)
  const [hotkeyError, setHotkeyError] = useState<string | null>(null)
  const captureRef = useRef<HTMLDivElement>(null)
  // 登録スロット（録画ホットキー変更など）が独自にキー入力キャプチャ中かどうか。
  // SettingsModal 自身の capturing とは独立に管理し、Escape 自動クローズの抑止に使う。
  const [slotCapturing, setSlotCapturing] = useState(false)
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
  const notes = appVersion ? releaseNotesFor(appVersion, p.settings.language) : undefined
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
      if (e.key === 'Escape' && !capturing && !slotCapturing) closeSettings()
    }
    document.addEventListener('keydown', block)
    return () => document.removeEventListener('keydown', block)
  }, [capturing, slotCapturing])

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
      if (panelRef.current?.contains(e.target as Node)) return
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
                  {getSettingsSlots('capture').map((Slot, i) => (
                    <Slot key={i} onCapturingChange={setSlotCapturing} placement="hotkey" />
                  ))}
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
                  {getSettingsSlots('capture').map((Slot, i) => (
                    <Slot key={i} onCapturingChange={setSlotCapturing} placement="notification" />
                  ))}
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

            {activeTab === 'data' && (
              <>
                {/* 撮ったものの置き場所は、これまでアプリのどこにも出ていなかった。拡張のフォルダは
                    開けるのに自分の何百枚には辿り着けない状態だったので、パスをそのまま出して開ける
                    ようにする。保存先の変更は既存ファイルの移動と DB のパス書き換えを伴うため別件。 */}
                <div style={{ ...s.group, ...s.groupFirst }}>
                  <div style={s.section}>{t('settings.storage')}</div>
                  <div style={s.actionRow}>
                    <div style={s.pathBox}>{storage?.captureDir ?? '—'}</div>
                    <button style={s.addBtn} onClick={() => window.api.showCapturesFolder()}>
                      {t('settings.openCapturesFolder')}
                    </button>
                  </div>
                  <div style={s.hint}>{t('settings.storageHint')}</div>
                </div>
                {/* 書き出し・読み込み・修復はどれも分単位の作業なのに、「今どれだけあるか」が
                    無いまま押すことになっていた。作業ボタンより先に現状を出す。 */}
                <div style={s.group}>
                  <div style={s.section}>{t('settings.usage')}</div>
                  {storageLoading ? (
                    <div style={s.hint}>{t('settings.usageCalculating')}</div>
                  ) : storageFailed || !storage ? (
                    <div style={s.hint}>{t('settings.usageFailed')}</div>
                  ) : (
                    <>
                      <div style={s.label}>
                        {t('settings.usageCounts', {
                          images: storage.imageCount.toLocaleString(),
                          videos: storage.videoCount.toLocaleString(),
                        })}
                      </div>
                      {([
                        ['settings.usageCaptures', formatBytes(storage.captureBytes)],
                        ['settings.usageThumbnails', formatBytes(storage.thumbnailBytes)],
                        ['settings.usageDatabase', formatBytes(storage.dbBytes)],
                        ['settings.usageModel', storage.modelBytes > 0 ? formatBytes(storage.modelBytes) : t('settings.usageModelAbsent')],
                      ] as const).map(([labelKey, value]) => (
                        <div key={labelKey} style={s.row}>
                          <span style={s.hint}>{t(labelKey)}</span>
                          <span style={s.usageValue}>{value}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
                {/* 撮った静止画をどの解像度まで保存するか。**容量の話なので使用量のすぐ下に置く**
                    （4K 環境で C ドライブが埋まる、という声から入れた設定なので、今どれだけ使って
                    いるかを見た直後に目に入る位置でないと結び付かない）。行の名前を「静止画」に
                    しているのは、録画には効かないことを説明を読まずに読み取らせるため。 */}
                <div style={s.group}>
                  <div style={s.section}>{t('settings.captureResize')}</div>
                  <div style={s.row}>
                    <span style={s.label}>{t('settings.captureResizeTarget')}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: space.x4 }}>
                      {([['source', t('settings.captureResize.source')], ['fhd', t('settings.captureResize.fhd')], ['hd', t('settings.captureResize.hd')], ['screen', t('settings.captureResize.screen')]] as const).map(([value, label]) => {
                        const active = p.settings.captureResize === value
                        return (
                          <button key={value} onClick={() => p.onUpdateCaptureResize(value)} data-current={active ? 'true' : undefined}
                            style={{ ...s.sizeBtn, background: active ? 'var(--bg-surface-hover)' : 'transparent', color: active ? 'var(--accent-text)' : 'var(--text-secondary)', borderColor: active ? 'var(--accent)' : 'var(--border-default)' }}>
                            {label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <div style={s.hint}>{t('settings.captureResizeHint')}</div>
                </div>
                {/* 選んだものを書き出すときの動画の形式。**すぐ下の「エクスポート」はライブラリの共有
                    書き出しで、この設定を見ない。** 見出しに「書き出し」を使うと同じ語が隣り合って
                    見分けられなくなるため、こちらは「変換」と呼ぶ。 */}
                <div style={s.group}>
                  <div style={s.section}>{t('settings.videoExport')}</div>
                  <div style={s.row}>
                    <span style={s.label}>{t('settings.videoExportFormat')}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: space.x4 }}>
                      {([['original', t('settings.videoExportFormat.original')], ['h264', t('settings.videoExportFormat.h264')]] as const).map(([value, label]) => {
                        const active = p.settings.videoExportFormat === value
                        return (
                          <button key={value} onClick={() => p.onUpdateVideoExportFormat(value)} data-current={active ? 'true' : undefined}
                            style={{ ...s.sizeBtn, background: active ? 'var(--bg-surface-hover)' : 'transparent', color: active ? 'var(--accent-text)' : 'var(--text-secondary)', borderColor: active ? 'var(--accent)' : 'var(--border-default)' }}>
                            {label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <div style={s.hint}>{t('settings.videoExportFormatHint')}</div>
                </div>
                <div style={s.group}>
                  <div style={s.section}>{t('action.export')}</div>
                  <div style={s.actionRow}>
                    <div style={s.hint}>{t('settings.exportHint')}</div>
                    <button style={s.addBtn} disabled={shareExporting || otherExportActive} onClick={async () => {
                      setShareExporting(true)
                      setShareExportStatus(null)
                      useExportStore.getState().startExport('share')
                      try {
                        const result = await p.onShareExport()
                        if (result.canceled) {
                          if (result.count != null) setShareExportStatus({ text: tp('settings.stoppedCount', result.count) })
                          // count なし = フォルダ選択自体のキャンセル（無言、従来通り）
                        } else {
                          setShareExportStatus({ text: tp('toast.exported', result.count ?? 0) })
                        }
                      } catch (err) {
                        console.error('[settings] share export failed', err)
                        setShareExportStatus({ text: t('settings.exportFailed'), error: true })
                      } finally {
                        setShareExporting(false)
                        // 通常は onExportProgress 側（current>=total）でクリアされるが、途中キャンセル・
                        // 進捗が1件も届かない失敗ケースの保険としてここでも念のためクリアする。
                        useExportStore.getState().clearExport()
                      }
                    }}>
                      {shareExporting ? t('settings.exporting') : t('settings.exportLibrary')}
                    </button>
                  </div>
                  {shareExportStatus && <div style={{ ...s.statusLine, ...(shareExportStatus.error ? s.statusLineError : s.statusLineOk) }}>{shareExportStatus.text}</div>}
                </div>
                <div style={s.group}>
                  <div style={s.section}>{t('settings.import')}</div>
                  <div style={s.actionRow}>
                    <div style={s.hint}>{t('settings.importHint')}</div>
                    {shareImportProgress ? (
                      <div style={{ ...s.progressWrap, flex: '0 0 220px' }}>
                        <div style={s.progressBar}>
                          <div style={{ ...s.progressFill, width: `${shareImportProgress.total > 0 ? Math.round(shareImportProgress.current / shareImportProgress.total * 100) : 0}%` }} />
                        </div>
                        <span style={s.progressLabel}>{shareImportProgress.current}/{shareImportProgress.total}</span>
                        <button style={s.cancelBtn} onClick={() => window.api.shareImportCancel()}>{t('action.stop')}</button>
                      </div>
                    ) : (
                      <button style={s.addBtn} disabled={shareImporting} onClick={async () => {
                        setShareImporting(true)
                        setShareImportStatus(null)
                        try {
                          const result = await p.onShareImport()
                          if (result.canceled) {
                            if (result.count != null) setShareImportStatus({ text: tp('settings.stoppedCount', result.count) })
                            // count なし = フォルダ選択自体のキャンセル（無言、従来通り）
                          } else {
                            const errMsg = result.errors && result.errors.length > 0 ? t('settings.importErrorSuffix', { count: result.errors.length }) : ''
                            const folderMsg = result.importedFolders ? t('settings.importFolderSuffix', { count: result.importedFolders }) : ''
                            setShareImportStatus({ text: tp('settings.importedCount', result.count ?? 0) + folderMsg + errMsg })
                          }
                        } catch (err) {
                          console.error('[settings] share import failed', err)
                          setShareImportStatus({ text: t('settings.importFailed'), error: true })
                        } finally {
                          setShareImporting(false)
                          // 通常は onShareImportProgress 側（current>=total）でクリアされるが、途中キャンセル・
                          // 進捗が1件も届かない失敗ケースの保険としてここでも念のためクリアする。
                          useExportStore.getState().setShareImportProgress(null)
                        }
                      }}>
                        {shareImporting ? t('settings.importing') : t('settings.importLibrary')}
                      </button>
                    )}
                  </div>
                  {shareImportStatus && <div style={{ ...s.statusLine, ...(shareImportStatus.error ? s.statusLineError : s.statusLineOk) }}>{shareImportStatus.text}</div>}
                </div>
                <div style={s.group}>
                  <div style={s.section}>{t('settings.thumbRepair')}</div>
                  <div style={s.actionRow}>
                    <div style={s.hint}>{t('settings.thumbRepairHint')}</div>
                    <button style={s.addBtn} disabled={repairing} onClick={async () => {
                      setRepairing(true)
                      setRepairStatus(null)
                      try {
                        const { repaired, failed } = await window.api.imagesRepairThumbs()
                        const failMsg = failed > 0 ? t('settings.repairFailSuffix', { count: failed }) : ''
                        setRepairStatus({
                          text: repaired > 0 ? tp('settings.repairedCount', repaired) + failMsg : t('settings.repairNoIssues') + failMsg,
                        })
                      } catch (err) {
                        console.error('[settings] thumbnail repair failed', err)
                        setRepairStatus({ text: t('settings.repairFailed'), error: true })
                      } finally {
                        setRepairing(false)
                      }
                    }}>
                      {repairing ? t('settings.repairing') : t('settings.repairButton')}
                    </button>
                  </div>
                  {repairStatus && <div style={{ ...s.statusLine, ...(repairStatus.error ? s.statusLineError : s.statusLineOk) }}>{repairStatus.text}</div>}
                </div>
              </>
            )}

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
                        ここは読み返し用でしかない。
                        **文面が無いバージョンでは出さない**——押しても空のモーダルが開く
                        だけで、「まだ書いていない」と「変更が無かった」の区別も付かない。 */}
                    {appVersion && notes && notes.length > 0 && (
                      <button style={s.sizeBtn} onClick={() => p.onShowWhatsNew(appVersion, notes)}>
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

// 各種設定スロットが見た目を揃えるために再利用する共通スタイル。
//
// ── 崩すと「統一感がない」に戻る約束 ─────────────────────────────
// 1. 器はひとつ。タブの中身は必ず group（区切り線＋余白）で組む。背景付きのカードは使わない。
//    以前は「データ」タブだけが背景付きカード(dataBlock)で、他3タブの区切り線と別物に見えていた。
// 2. 文字は 3 段だけ: section(xs/secondary) > label(base/primary) > hint(sm/secondary)。
//    label を section より大きくしないこと。以前は label が lg(15) で見出し xs(12) より
//    目立ち、階層が反転していた。
// 3. 角丸は radius トークンのみ。操作部品(ボタン・入力・バッジ)= sm、器(パネル・タイル)= md。
//    以前は 3 と 4 が根拠なく混在していた。
// 4. ボタンは btnBase で高さ・角丸・字送りを固定し、色だけで役割を分ける。
//    以前は addBtn/sizeBtn/cancelBtn/deleteBtn が全部別の padding と font-size を持っていた。
const btnBase: React.CSSProperties = {
  height: control.lg, boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  flexShrink: 0, padding: '0 14px', borderRadius: radius.md, fontSize: font.base, fontWeight: 700,
  cursor: 'pointer', whiteSpace: 'nowrap' as const,
}

export const s: Record<string, React.CSSProperties> = {
  overlay: { ...modal.overlay, background: 'rgba(var(--scrim-rgb), 0.88)', zIndex: 2000, padding: 0 },
  panel: { ...modal.panel, width: 860, maxWidth: '90vw', height: 520, maxHeight: '88vh', display: 'flex', flexDirection: 'column' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '24px 24px 16px', flexShrink: 0, borderBottom: '1px solid var(--border-default)' },
  sidebar: { width: 124, padding: '8px 10px', gap: space.x2, flexShrink: 0, background: 'var(--bg-well)', borderRight: '1px solid var(--border-default)', display: 'flex', flexDirection: 'column', alignSelf: 'stretch' },
  tabBtn: { display: 'flex', justifyContent: 'flex-start', alignItems: 'center', fontSize: font.base, fontWeight: 600, color: 'var(--text-secondary)', padding: '7px 10px', borderRadius: radius.md, background: 'transparent', border: 'none', cursor: 'pointer', width: '100%' },
  tabBtnActive: { color: 'var(--accent-text)', background: 'rgba(var(--accent-rgb), 0.16)', fontWeight: 700 },
  // overscrollBehavior: タブの中身を端まで送ったあと、続きのホイールが背後の一覧へ
  // 渡って**設定を開いたまま裏がスクロールしていた**。contain で連鎖を止める。
  tabContent: { overflowY: 'auto' as const, overscrollBehavior: 'contain' as const, flex: 1, padding: '0 28px 28px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' },
  title: { fontSize: font.xxl, fontWeight: 800, color: 'var(--text-bright)' },
  close: { ...btnBase, width: 32, padding: 0, background: 'rgba(var(--surface-rgb), 0.5)', border: '1px solid transparent', color: 'var(--text-secondary)' },
  // 区切り線は 2 つ目以降の group にだけ出す。1 つ目に出すとヘッダーの下線と重なって
  // 二重線に見えるため、各タブの先頭 group には groupFirst を重ねること。
  // **タブごとに構造を変えない。** どのタブも「group を縦に並べるだけ」の 1 段で揃える。
  // 一度データタブだけカテゴリの段を足したが、他のタブは中身が 2〜4 つしかなく、同じ形に
  // すると子が 1 つだけのカテゴリができる。優先度の問題（バージョン・クレジットが
  // ライブラリへの操作と同列に並んでいた）は、それらを情報タブへ分けたことで解いている。
  group: { borderTop: '1px solid var(--border-default)', padding: '22px 0', display: 'flex', flexDirection: 'column', gap: space.x12, width: '100%', maxWidth: 620 },
  groupFirst: { borderTop: 'none' },
  section: { fontSize: font.xs, color: 'var(--text-secondary)', letterSpacing: 0.4, fontWeight: 800 },
  toggleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.x16 },
  // row と toggleRow は同一。外部の設定スロットが両方の名前を使っているため別名で残す。
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.x16 },
  label: { fontSize: font.base, color: 'var(--text-primary)', fontWeight: 700 },
  sizeBtn: { ...btnBase, padding: '0 16px', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', fontWeight: 600, transition: 'all 0.1s' },
  hint: { fontSize: font.sm, color: 'var(--text-secondary)', lineHeight: 1.7 },
  creditLink: { padding: 0, background: 'none', border: 'none', color: 'var(--accent-text)', fontSize: font.sm, fontFamily: 'inherit', cursor: 'pointer', textDecoration: 'underline' },
  hotkeyBadge: { ...btnBase, cursor: 'default', padding: '0 12px', background: 'var(--bg-surface)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', fontFamily: 'monospace', fontWeight: 400 },
  // hotkeyBadge と同じ「値そのものを見せる枠」。パスは省略すると意味を失う（どこか分からなく
  // なるのが元の問題）ので、切らずに折り返して全文を出し、選択してコピーできるようにする。
  pathBox: { flex: 1, minWidth: 0, padding: '7px 10px', background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: radius.md, color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: font.sm, lineHeight: 1.5, wordBreak: 'break-all' as const, userSelect: 'text' as const },
  // 使用量の数値。行の左は hint（説明側）なので、右の数字だけ primary で拾えるようにする。
  usageValue: { fontSize: font.base, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' as const },
  hotkeyCapture: { ...btnBase, cursor: 'text', padding: '0 12px', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', color: 'var(--accent-text)', fontFamily: 'monospace', fontWeight: 400, minWidth: 140, outline: 'none' },
  toggleSwitch: { width: 44, height: control.md, padding: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-start', flexShrink: 0, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 999, cursor: 'pointer', transition: 'background 0.16s ease, border-color 0.16s ease' },
  toggleSwitchOn: { background: 'rgba(var(--accent-rgb), 0.24)', borderColor: 'rgba(var(--accent-rgb), 0.6)' },
  toggleKnob: { width: 20, height: 20, borderRadius: 999, background: 'var(--text-secondary)', boxShadow: '0 1px 3px rgba(var(--scrim-rgb), 0.45)', transition: 'transform 0.16s cubic-bezier(.22,1,.36,1), background 0.16s ease' },
  toggleKnobOn: { background: 'var(--accent-text)' },
  statusBadge: { display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 8px', borderRadius: 999, fontSize: font.xs, fontWeight: 800, border: '1px solid', whiteSpace: 'nowrap' as const },
  statusOk: { color: 'var(--success)', background: 'rgba(var(--success-rgb), 0.12)', borderColor: 'rgba(var(--success-rgb), 0.35)' },
  statusMuted: { color: 'var(--text-secondary)', background: 'rgba(var(--text-rgb), 0.05)', borderColor: 'var(--border-soft)' },
  statusWarn: { color: 'var(--warning)', background: 'rgba(var(--warning-rgb), 0.12)', borderColor: 'rgba(var(--warning-rgb), 0.4)' },
  inputRow: { display: 'flex', gap: space.x8 },
  input: { flex: 1, height: control.lg, boxSizing: 'border-box' as const, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: radius.md, color: 'var(--text-primary)', padding: '0 10px', fontSize: font.base, outline: 'none' },
  actionRow: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.x16 },
  addBtn: { ...btnBase, background: 'rgba(var(--accent-rgb), 0.18)', border: '1px solid rgba(var(--accent-rgb), 0.45)', color: 'var(--accent-text)' },
  patternEmpty: { color: 'var(--text-secondary)', fontSize: font.base },
  patternList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: space.x4 },
  patternItem: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.x8, background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: radius.md, padding: '6px 10px' },
  code: { fontFamily: 'monospace', fontSize: font.sm, color: 'var(--text-secondary)', flex: 1 },
  removeBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px', flexShrink: 0 },
  deleteBtn: { ...btnBase, background: color.dangerBg, border: `1px solid ${color.dangerBorder}`, color: color.danger },
  cancelBtn: { ...btnBase, background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' },
  progressWrap: { display: 'flex', alignItems: 'center', gap: space.x8 },
  progressBar: { flex: 1, height: 6, background: 'var(--border-default)', borderRadius: radius.md, overflow: 'hidden' },
  progressFill: { height: '100%', background: 'var(--accent)', borderRadius: radius.md, transition: 'width 0.3s' },
  progressLabel: { color: 'var(--text-secondary)', fontSize: font.sm, width: 36, textAlign: 'right' as const },
  statusLine: { fontSize: font.sm, fontWeight: 700 },
  statusLineOk: { color: 'var(--success)' },
  statusLineError: { color: color.danger },
}
