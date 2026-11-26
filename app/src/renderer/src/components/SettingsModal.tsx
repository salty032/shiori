import { useState, useRef, useEffect } from 'react'
import type { Settings, ExtensionTimecode, StorageInfo, LibraryImportMode } from '../types'
import type { UpdateSetting } from '../hooks/useSettings'
import { space } from '../styles'
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
import { useExtensionConnected } from '../hooks/useExtensionConnected'

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
  onUpdateClipHotkey: (hotkey: string) => Promise<boolean>
  onUpdateSetting: UpdateSetting
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
  // 受信が途絶えたら「未受信」に戻す判定は初回の案内と共通（useExtensionConnected.ts）。
  const extensionConnected = useExtensionConnected(p.extensionStatus)
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
  // タブ（データ）へ切り替わった最初の一回だけ取りに行く。
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [storageLoading, setStorageLoading] = useState(false)
  const [storageFailed, setStorageFailed] = useState(false)
  const storageRequested = useRef(false)
  useEffect(() => {
    if (activeTab !== 'data') return
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
                          <button key={value} onClick={() => p.onUpdateSetting('theme', value)} data-current={active ? 'true' : undefined}
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
                          <button key={value} onClick={() => p.onUpdateSetting('language', value)} data-current={active ? 'true' : undefined}
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
                    <ToggleSwitch checked={p.settings.lowMemoryMode ?? false} onChange={(v) => p.onUpdateSetting('lowMemoryMode', v)} />
                  </div>
                </div>
                <div style={s.group}>
                  {/* 見出しの下の余白は行の側に付ける。見出しに付いたままだと、札と縦の真ん中で揃えたとき札が下がって見えた。 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: space.x8, paddingBottom: 6 }}>
                    <div style={{ ...s.section, paddingBottom: 0 }}>{t('settings.extension')}</div>
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
                    <ToggleSwitch checked={p.settings.captureNotify ?? true} onChange={(v) => p.onUpdateSetting('captureNotify', v)} />
                  </div>
                  <div style={s.toggleRow}>
                    <span style={s.label}>{t('clip.notifyOnFinish')}</span>
                    <ToggleSwitch checked={p.settings.clipNotify ?? true} onChange={(v) => p.onUpdateSetting('clipNotify', v)} />
                  </div>
                </div>
              </>
            )}

            {activeTab === 'tag' && (
              <>
                <div style={{ ...s.group, ...s.groupFirst }}>
                  {/* 機能そのものの状態は、見出しの横に札で出す（拡張機能の「受信中」と同じ）。
                      説明と容量の間に挟むと、何の準備ができたのかが読み取れなかった。 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: space.x8, paddingBottom: 6 }}>
                    <div style={{ ...s.section, paddingBottom: 0 }}>{t('settings.autoTagging')}</div>
                    {p.taggerReady && <span style={{ ...s.statusBadge, ...s.statusOk }}>{t('settings.taggerReady')}</span>}
                    {/* 削除は文字だけの控えめなボタン。めったにしない操作なのに、赤い大きなボタンでタブの中で一番目立ち、
                        普段使う「既存画像にタグ付け」より強く見えていた。消える容量はデータタブの使用量と、確認の文に出る。 */}
                    {p.taggerReady && (
                      <button style={{ ...s.quietBtn, marginLeft: 'auto' }} onClick={p.onTaggerDelete} title={t('settings.deleteModel')}>{t('action.delete')}</button>
                    )}
                  </div>
                  <div style={s.hint}>{t('settings.autoTaggingHint')}</div>
                  {p.taggerReady ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: space.x8 }}>
                      {p.retagProgress ? (
                        <div style={s.progressWrap}>
                          <div style={s.progressBar}>
                            <div style={{ ...s.progressFill, width: `${p.retagProgress.total > 0 ? Math.round(p.retagProgress.current / p.retagProgress.total * 100) : 0}%` }} />
                          </div>
                          <span style={s.progressLabel}>{p.retagProgress.current}/{p.retagProgress.total}</span>
                        </div>
                      ) : (
                        // ボタンのある行は、ほかのタブと同じく左に名前と説明を置く（説明だけだと何の行か読めない）。
                        <div style={s.actionRow}>
                          <div style={{ ...s.cardText, flex: 1 }}>
                            <span style={s.label}>{t('settings.retag')}</span>
                            <span style={s.hint}>{t('settings.retagHint')}</span>
                          </div>
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
                    // ダウンロードが要る話は、まだダウンロードしていないこの行にだけ出す。済んだ後は実際の容量が状態の行に出る。
                    <div style={s.actionRow}>
                      <div style={{ ...s.cardText, flex: 1 }}>
                        <span style={s.label}>{t('settings.model')}</span>
                        <span style={s.hint}>{t('settings.autoTaggingDownloadHint')}</span>
                      </div>
                      <button style={s.addBtn} onClick={p.onTaggerDownload}>
                        {t('settings.downloadModel')}
                      </button>
                    </div>
                  )}
                  {/* AI タグをサイドバーに出すかも、自動タグ付けの話なので同じまとまりに置く（見出し 1 つに 1 行だけの組を作らない）。 */}
                  <div style={s.toggleRow}>
                    <div style={s.cardText}>
                      <span style={s.label}>{t('settings.showAiTags')}</span>
                      <span style={s.hint}>{t('settings.showAiTagsHint')}</span>
                    </div>
                    <ToggleSwitch checked={p.settings.showAiTags ?? false} onChange={(v) => p.onUpdateSetting('showAiTags', v)} />
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
              onUpdateSetting={p.onUpdateSetting}
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
