import { useState, useRef, useEffect } from 'react'
import type { Settings, ExtensionTimecode } from '../types'
import { font, color } from '../styles'
import { buildAccelerator } from '../utils'
import { normalizeCaptureHotkey } from '../../../shared/hotkey'
import { XIcon } from './Icon'
import { useExportStore } from '../stores/exportStore'

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
  onTaggerDownload: () => void
  onTaggerCancelDownload: () => void
  onTaggerDelete: () => void
  onTaggerRetagAll: () => void
  onShareExport: () => Promise<{ canceled: boolean; count?: number; path?: string }>
  onShareImport: () => Promise<{ canceled: boolean; count?: number; errors?: string[] }>
}

export function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      style={{ ...s.toggleSwitch, ...(checked ? s.toggleSwitchOn : {}) }}
      onClick={() => onChange(!checked)}
    >
      <span style={{ ...s.toggleKnob, ...(checked ? s.toggleKnobOn : {}), transform: checked ? 'translateX(18px)' : 'translateX(0)' }} />
    </button>
  )
}

export default function SettingsModal(p: Props) {
  const [shareExportStatus, setShareExportStatus] = useState<{ text: string; error?: boolean } | null>(null)
  const [shareImportStatus, setShareImportStatus] = useState<{ text: string; error?: boolean } | null>(null)
  const [shareExporting, setShareExporting] = useState(false)
  const [shareImporting, setShareImporting] = useState(false)
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
  const extensionConnected = p.extensionStatus !== null && now - p.extensionStatus.lastSeenAt <= EXTENSION_TIMEOUT_MS

  // モーダル表示中はすべてのキーイベントの window 伝搬を遮断する
  useEffect(() => {
    const block = (e: KeyboardEvent): void => {
      e.stopPropagation()
      if (e.key === 'Escape' && !capturing && !slotCapturing) p.onClose()
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
        setHotkeyError('このキーの組み合わせは使用できません')
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [capturing])

  const [activeTab, setActiveTab] = useState<'基本' | 'キャプチャ' | 'タグ' | 'データ'>('基本')
  const TABS = ['基本', 'キャプチャ', 'タグ', 'データ'] as const

  // fps カスタム数値入力は1打鍵ごとに保存すると IPC + 拡張への再送が無駄に多い（R-3）。
  // ローカル state に持ち、300ms 入力が止まってから確定する。プリセットボタン側は
  // 即時反映のままでよいので、外部から settings.frameFps が変わったときだけ同期する。
  const FPS_INPUT_DEBOUNCE_MS = 300
  const [fpsInputDraft, setFpsInputDraft] = useState(String(p.settings.frameFps))
  const fpsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { setFpsInputDraft(String(p.settings.frameFps)) }, [p.settings.frameFps])
  useEffect(() => () => { if (fpsDebounceRef.current) clearTimeout(fpsDebounceRef.current) }, [])

  return (
    <div style={s.overlay} onClick={p.onClose}>
      <div style={s.panel} onClick={(e) => e.stopPropagation()}>
        <div style={s.header}>
          <span style={s.title}>設定</span>
          <button style={s.close} onClick={p.onClose} title="閉じる"><XIcon size={17} /></button>
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div style={s.sidebar}>
            {TABS.map((tab) => (
              <button
                key={tab}
                className="shiori-menu-item"
                style={{ ...s.tabBtn, ...(activeTab === tab ? s.tabBtnActive : {}) }}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>

          <div style={s.tabContent}>
            {activeTab === '基本' && (
              <>
                <div style={s.group}>
                  <div style={s.section}>起動</div>
                  <div style={s.toggleRow}>
                    <span style={s.label}>ログイン時に自動起動</span>
                    <ToggleSwitch checked={p.startup} onChange={() => p.onToggleStartup()} />
                  </div>
                </div>
                <div style={s.group}>
                  <div style={s.section}>コマ送り (Shift+←/→)</div>
                  <div style={s.row}>
                    <span style={s.label}>FPS</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#888', fontSize: font.base }}>
                        <ToggleSwitch checked={p.settings.frameFpsAuto} onChange={p.onUpdateFrameFpsAuto} />
                        自動検出
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: p.settings.frameFpsAuto ? 0.35 : 1, pointerEvents: p.settings.frameFpsAuto ? 'none' : 'auto' }}>
                        {[24, 30, 60].map((fps) => {
                          const active = p.settings.frameFps === fps
                          return (
                            <button key={fps} onClick={() => p.onUpdateFrameFps(fps)}
                              style={{ ...s.sizeBtn, background: active ? '#1e2a3a' : 'transparent', color: active ? '#9ea5ff' : '#7f899f', borderColor: active ? '#33445e' : '#272c3a' }}>
                              {fps}
                            </button>
                          )
                        })}
                        <input type="number" min={1} max={60} value={fpsInputDraft}
                          onChange={(e) => {
                            const raw = e.target.value
                            setFpsInputDraft(raw)
                            const v = Number(raw)
                            if (!raw || !(v >= 1 && v <= 60)) return
                            if (fpsDebounceRef.current) clearTimeout(fpsDebounceRef.current)
                            fpsDebounceRef.current = setTimeout(() => p.onUpdateFrameFps(v), FPS_INPUT_DEBOUNCE_MS)
                          }}
                          onBlur={() => {
                            if (!fpsDebounceRef.current) return
                            clearTimeout(fpsDebounceRef.current)
                            fpsDebounceRef.current = null
                            const v = Number(fpsInputDraft)
                            if (fpsInputDraft && v >= 1 && v <= 60) p.onUpdateFrameFps(v)
                            else setFpsInputDraft(String(p.settings.frameFps))
                          }}
                          style={{ ...s.input, width: 52, textAlign: 'center' as const, padding: '6px 4px' }} />
                        <span style={{ color: '#7f899f', fontSize: font.base }}>fps</span>
                      </div>
                    </div>
                  </div>
                  <div style={s.hint}>自動検出ON: 動画から計測。OFF: 固定fps（アニメ ≈ 24、実写 ≈ 30）</div>
                </div>
                <div style={s.group}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={s.section}>拡張機能</div>
                    <span style={{ ...s.statusBadge, ...(extensionConnected ? s.statusOk : s.statusMuted) }}>
                      {extensionConnected ? '受信中' : '未受信'}
                    </span>
                  </div>
                  <div style={s.actionRow}>
                    <div style={s.hint}>対応サイトの動画ページから Shiori に情報が届いているかを表示します。</div>
                    {!extensionConnected && (
                      <button style={s.addBtn} onClick={() => window.api.showExtensionFolder()}>
                        拡張機能フォルダを開く
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}

            {activeTab === 'キャプチャ' && (
              <>
                <div style={s.group}>
                  <div style={s.section}>ホットキー</div>
                  <div style={s.row}>
                    <span style={s.label}>キャプチャホットキー</span>
                    {capturing ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div ref={captureRef} style={s.hotkeyCapture}>
                          {capturedAccel || 'キーを押してください...'}
                        </div>
                        <button style={s.sizeBtn} disabled={!capturedAccel} onClick={async () => {
                          if (!capturedAccel) return
                          const ok = await p.onUpdateCaptureHotkey(capturedAccel)
                          if (ok) { setCapturing(false); setHotkeyError(null) }
                          else setHotkeyError('競合しています')
                        }}>確定</button>
                        <button style={s.sizeBtn} onClick={() => { setCapturing(false); setCapturedAccel(null); setHotkeyError(null) }}>キャンセル</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={s.hotkeyBadge}>{p.settings.captureHotkey}</span>
                        <button style={s.sizeBtn} onClick={() => { setCapturing(true); setCapturedAccel(null); setHotkeyError(null) }}>変更</button>
                      </div>
                    )}
                  </div>
                  {hotkeyError && <div style={{ fontSize: font.sm, color: color.danger }}>{hotkeyError}</div>}
                </div>
                <div style={s.group}>
                  <div style={s.section}>通知</div>
                  <div style={s.toggleRow}>
                    <span style={s.label}>キャプチャ完了時に通知する</span>
                    <ToggleSwitch checked={p.settings.captureNotify ?? true} onChange={p.onUpdateCaptureNotify} />
                  </div>
                </div>
              </>
            )}

            {activeTab === 'タグ' && (
              <>
                <div style={s.group}>
                  <div style={s.section}>自動タグ付け (WD Tagger)</div>
                  <div style={s.hint}>キャプチャ時にアニメ特化のAIがタグ候補を自動生成します。初回はモデルファイル（約600MB）のダウンロードが必要です。</div>
                  {p.taggerReady ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ ...s.statusBadge, ...s.statusOk }}>準備完了</span>
                        <button style={s.deleteBtn} onClick={p.onTaggerDelete}>モデルを削除</button>
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
                          <div style={s.hint}>タグが未付与の既存画像をまとめて処理します。</div>
                          <button style={s.addBtn} onClick={p.onTaggerRetagAll}>
                            既存画像にタグ付け...
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
                      <button style={s.cancelBtn} onClick={p.onTaggerCancelDownload}>中止</button>
                    </div>
                  ) : (
                    <div style={s.actionRow}>
                      <div style={s.hint}>モデルを保存すると、以後のキャプチャで自動タグ付けを使えます。</div>
                      <button style={s.addBtn} onClick={p.onTaggerDownload}>
                        モデルをダウンロード
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}

            {activeTab === 'データ' && (
              <div style={s.group}>
                <div style={s.section}>データ</div>
                <div style={s.dataBlock}>
                  <div style={s.dataHeader}>
                    <div>
                      <div style={s.dataTitle}>書き出し</div>
                      <div style={s.hint}>キャプチャ、タグ、メモ、スマートフォルダをフォルダへ保存します。</div>
                    </div>
                    <button style={s.addBtn} disabled={shareExporting} onClick={async () => {
                      setShareExporting(true)
                      setShareExportStatus(null)
                      useExportStore.getState().startExport('share')
                      try {
                        const result = await p.onShareExport()
                        if (result.canceled) {
                          if (result.count != null) setShareExportStatus({ text: `${result.count} 件で中止しました` })
                          // count なし = フォルダ選択自体のキャンセル（無言、従来通り）
                        } else {
                          setShareExportStatus({ text: `${result.count ?? 0} 件を書き出しました` })
                        }
                      } catch (err) {
                        console.error('[settings] share export failed', err)
                        setShareExportStatus({ text: '書き出しに失敗しました', error: true })
                      } finally {
                        setShareExporting(false)
                        // 通常は onExportProgress 側（current>=total）でクリアされるが、途中キャンセル・
                        // 進捗が1件も届かない失敗ケースの保険としてここでも念のためクリアする。
                        useExportStore.getState().clearExport()
                      }
                    }}>
                      {shareExporting ? '書き出し中...' : 'ライブラリを書き出す...'}
                    </button>
                  </div>
                  {shareExportStatus && <div style={{ ...s.statusLine, ...(shareExportStatus.error ? s.statusLineError : s.statusLineOk) }}>{shareExportStatus.text}</div>}
                </div>
                <div style={s.dataBlock}>
                  <div style={s.dataHeader}>
                    <div>
                      <div style={s.dataTitle}>読み込み</div>
                      <div style={s.hint}>画像とメタデータをライブラリに追加します。既存のキャプチャとは区別されます。</div>
                    </div>
                    <button style={s.addBtn} disabled={shareImporting} onClick={async () => {
                      setShareImporting(true)
                      setShareImportStatus(null)
                      try {
                        const result = await p.onShareImport()
                        if (!result.canceled) {
                          const errMsg = result.errors && result.errors.length > 0 ? `（エラー ${result.errors.length} 件）` : ''
                          setShareImportStatus({ text: `${result.count ?? 0} 件を読み込みました${errMsg}` })
                        }
                      } catch (err) {
                        console.error('[settings] share import failed', err)
                        setShareImportStatus({ text: '読み込みに失敗しました', error: true })
                      } finally {
                        setShareImporting(false)
                      }
                    }}>
                      {shareImporting ? '読み込み中...' : 'ライブラリを読み込む...'}
                    </button>
                  </div>
                  {shareImportStatus && <div style={{ ...s.statusLine, ...(shareImportStatus.error ? s.statusLineError : s.statusLineOk) }}>{shareImportStatus.text}</div>}
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  )
}

// 各種設定スロットが見た目を揃えるために再利用する共通スタイル。
export const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(3,5,10,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 },
  panel: { background: '#0d0f14', border: '1px solid #20242f', borderRadius: 4, width: 860, maxWidth: '90vw', height: 520, maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 70px rgba(0,0,0,0.62)', overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '24px 24px 16px', flexShrink: 0, borderBottom: '1px solid #20242f' },
  sidebar: { width: 124, padding: '8px 10px', gap: 2, flexShrink: 0, background: '#090c12', borderRight: '1px solid #1e2230', display: 'flex', flexDirection: 'column', alignSelf: 'stretch' },
  tabBtn: { display: 'flex', justifyContent: 'flex-start', alignItems: 'center', fontSize: font.base, fontWeight: 600, color: '#717a92', padding: '7px 10px', borderRadius: 3, background: 'transparent', border: 'none', cursor: 'pointer', width: '100%' },
  tabBtnActive: { color: '#c8cff7', background: '#1a1f35', fontWeight: 700 },
  tabContent: { overflowY: 'auto' as const, flex: 1, padding: '0 28px 28px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' },
  title: { fontSize: font.xxl, fontWeight: 800, color: '#f7f9ff' },
  close: { width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', color: '#6f778b', cursor: 'pointer', padding: 0 },
  group: { borderTop: '1px solid #293142', paddingTop: 22, paddingBottom: 22, display: 'flex', flexDirection: 'column', gap: 16, width: '100%', maxWidth: 620 },
  section: { fontSize: font.xs, color: '#7f899f', letterSpacing: 0.4, fontWeight: 800 },
  toggleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontSize: font.lg, color: '#dce3f2', fontWeight: 700 },
  sizeBtn: { padding: '6px 18px', background: '#171a23', borderRadius: 3, border: '1px solid #2b3243', color: '#dce3f2', cursor: 'pointer', fontSize: font.base, transition: 'all 0.1s' },
  hint: { fontSize: font.sm, color: '#8791a8', lineHeight: 1.7 },
  hotkeyBadge: { padding: '4px 10px', background: '#171a23', border: '1px solid #272c3a', borderRadius: 3, color: '#dce3f2', fontSize: font.base, fontFamily: 'monospace' },
  hotkeyCapture: { padding: '4px 10px', background: '#171a23', border: '1px solid #3b4355', borderRadius: 3, color: '#9ea5ff', fontSize: font.base, fontFamily: 'monospace', minWidth: 140, outline: 'none', cursor: 'text' },
  toggleSwitch: { width: 40, height: 22, padding: 2, display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-start', flexShrink: 0, background: '#171a23', border: '1px solid #343b4c', borderRadius: 999, cursor: 'pointer', transition: 'background 0.16s ease, border-color 0.16s ease' },
  toggleSwitchOn: { background: 'rgba(111,111,242,0.24)', borderColor: 'rgba(126,138,255,0.6)' },
  toggleKnob: { width: 16, height: 16, borderRadius: 999, background: '#8a94aa', boxShadow: '0 1px 3px rgba(0,0,0,0.45)', transition: 'transform 0.16s cubic-bezier(.22,1,.36,1), background 0.16s ease' },
  toggleKnobOn: { background: '#c5cbff' },
  statusBadge: { display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 8px', borderRadius: 999, fontSize: font.xs, fontWeight: 800, border: '1px solid', whiteSpace: 'nowrap' as const },
  statusOk: { color: '#7cb87c', background: 'rgba(45,130,70,0.12)', borderColor: 'rgba(90,170,105,0.35)' },
  statusMuted: { color: '#7f899f', background: 'rgba(127,137,159,0.08)', borderColor: 'rgba(127,137,159,0.22)' },
  inputRow: { display: 'flex', gap: 8 },
  input: { flex: 1, background: '#171a23', border: '1px solid #2b3243', borderRadius: 3, color: '#e7ebf5', padding: '7px 10px', fontSize: font.base, outline: 'none' },
  actionRow: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  addBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: '7px 14px', background: '#1d2b40', border: '1px solid #38506d', borderRadius: 3, color: '#aeb8ff', cursor: 'pointer', fontSize: font.base, whiteSpace: 'nowrap' as const, fontWeight: 700 },
  patternEmpty: { color: '#7f899f', fontSize: font.base },
  patternList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  patternItem: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: '#171a23', border: '1px solid #272c3a', borderRadius: 3, padding: '6px 10px' },
  code: { fontFamily: 'monospace', fontSize: font.sm, color: '#b9c2d6', flex: 1 },
  removeBtn: { background: 'none', border: 'none', color: '#6f778b', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px', flexShrink: 0 },
  deleteBtn: { padding: '5px 12px', background: color.dangerBg, border: `1px solid ${color.dangerBorder}`, borderRadius: 3, color: color.danger, cursor: 'pointer', fontSize: font.sm, fontWeight: 700 },
  cancelBtn: { padding: '5px 10px', background: 'transparent', border: '1px solid #3b4255', borderRadius: 3, color: '#b6bed2', cursor: 'pointer', fontSize: font.sm, fontWeight: 700, flexShrink: 0 },
  progressWrap: { display: 'flex', alignItems: 'center', gap: 8 },
  progressBar: { flex: 1, height: 6, background: '#20242f', borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%', background: '#7b7bf6', borderRadius: 2, transition: 'width 0.3s' },
  progressLabel: { color: '#8791a8', fontSize: font.sm, width: 36, textAlign: 'right' as const },
  dataBlock: { display: 'flex', flexDirection: 'column' as const, gap: 12, width: '100%', padding: '14px 16px', background: '#11141c', border: '1px solid #293142', borderRadius: 4, boxSizing: 'border-box' as const },
  dataHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  dataTitle: { color: '#dce3f2', fontSize: font.base, fontWeight: 800 },
  statusLine: { fontSize: font.sm, fontWeight: 700 },
  statusLineOk: { color: '#7cb87c' },
  statusLineError: { color: color.danger },
}
