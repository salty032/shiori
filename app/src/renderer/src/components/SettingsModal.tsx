import { useState, useRef, useEffect } from 'react'
import type { Settings, ExtensionTimecode, StorageInfo, LibraryImportMode } from '../types'
import { space } from '../styles'
import { formatBytes } from '../utils'
import { XIcon } from './Icon'
import SettingsDataTab from './SettingsDataTab'
import { s } from './settingsStyles'
import { useModal } from '../hooks/useModal'
import ModalFrame from './ModalFrame'
import { useLatestRef } from '../hooks/useLatestRef'
import HotkeyField from './HotkeyField'
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
  onUpdateCaptureHotkey: (hotkey: string) => Promise<boolean>
  onUpdateCaptureNotify: (enabled: boolean) => void
  onUpdateClipHotkey: (hotkey: string) => Promise<boolean>
  onUpdateClipNotify: (enabled: boolean) => void
  onUpdateLowMemoryMode: (enabled: boolean) => void
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
  onShareImport: (mode: LibraryImportMode) => Promise<{ canceled: boolean; count?: number; errors?: string[] }>
  /** 「情報」タブから変更点モーダルを開く（設定画面自身は中身を持たない） */
  onShowWhatsNew: (entries: ReleaseNoteEntry[]) => void
}

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
  // ホットキーの欄（キャプチャ・録画）がキーを待っているか。待っている間は Escape で設定画面を閉じない。
  const [captureKeyWaiting, setCaptureKeyWaiting] = useState(false)
  const [clipKeyWaiting, setClipKeyWaiting] = useState(false)
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
  // 自動アップデートが適用されたかをいつでも確認できるよう、情報タブにバージョンを表示する
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

  // Escape で閉じるのは、ホットキーの欄がキーを待っていないときだけ（待っている間の Escape は入力の取り消し）。
  const keyWaitingRef = useLatestRef(captureKeyWaiting || clipKeyWaiting)
  const modal = useModal(p.onClose, { canClose: () => !keyWaitingRef.current })
  const closeSettings = (): void => modal.close()

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

  return (
    <ModalFrame modal={modal} overlayStyle={s.overlay} panelStyle={s.panel}>
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
                  <div style={s.section}>{t('settings.behavior')}</div>
                  <div style={s.toggleRow}>
                    <span style={s.label}>{t('settings.startOnLogin')}</span>
                    <ToggleSwitch checked={p.startup} onChange={() => p.onToggleStartup()} />
                  </div>
                  <div style={s.toggleRow}>
                    <div style={s.cardText}>
                      <span style={s.label}>{t('settings.lowMemoryMode')}</span>
                      <span style={s.hint}>{t('settings.lowMemoryModeHint')}</span>
                    </div>
                    <ToggleSwitch checked={p.settings.lowMemoryMode ?? false} onChange={p.onUpdateLowMemoryMode} />
                  </div>
                </div>
                <div style={s.group}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: space.x8 }}>
                    <div style={s.section}>{t('settings.extension')}</div>
                    <span style={{ ...s.statusBadge, ...(wsPortUnavailable ? s.statusWarn : extensionVersionMismatch ? s.statusWarn : extensionConnected ? s.statusOk : s.statusMuted) }}>
                      {t(wsPortUnavailable ? 'settings.extPortBlocked' : extensionVersionMismatch ? 'settings.extReloadNeeded' : extensionConnected ? 'settings.extConnected' : 'settings.extDisconnected')}
                    </span>
                  </div>
                  <div style={s.plainRow}>
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
                  <HotkeyField label={t('settings.captureHotkey')} value={p.settings.captureHotkey}
                    onCommit={p.onUpdateCaptureHotkey} onCapturingChange={setCaptureKeyWaiting} />
                  <HotkeyField label={t('clip.hotkeyLabel')} value={p.settings.clipHotkey}
                    onCommit={p.onUpdateClipHotkey} onCapturingChange={setClipKeyWaiting} />
                  <div style={s.hint}>{t('clip.hotkeyTroubleshoot')}</div>
                </div>
                <div style={s.group}>
                  <div style={s.section}>{t('settings.notifications')}</div>
                  <div style={s.toggleRow}>
                    <span style={s.label}>{t('settings.notifyOnCapture')}</span>
                    <ToggleSwitch checked={p.settings.captureNotify ?? true} onChange={p.onUpdateCaptureNotify} />
                  </div>
                  <div style={s.toggleRow}>
                    <span style={s.label}>{t('clip.notifyOnFinish')}</span>
                    <ToggleSwitch checked={p.settings.clipNotify ?? true} onChange={p.onUpdateClipNotify} />
                  </div>
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
                      <div style={s.row}>
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
                    <div style={{ ...s.actionRow, justifyContent: 'flex-end' }}>
                      <button style={s.addBtn} onClick={p.onTaggerDownload}>
                        {t('settings.downloadModel')}
                      </button>
                    </div>
                  )}
                </div>
                <div style={s.group}>
                  <div style={s.section}>{t('settings.sidebarDisplay')}</div>
                  <div style={s.toggleRow}>
                    <div style={s.cardText}>
                      <span style={s.label}>{t('settings.showAiTags')}</span>
                      <span style={s.hint}>{t('settings.showAiTagsHint')}</span>
                    </div>
                    <ToggleSwitch checked={p.settings.showAiTags ?? false} onChange={p.onUpdateShowAiTags} />
                  </div>
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
                  <div style={s.plainRow}>
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
    </ModalFrame>
  )
}
