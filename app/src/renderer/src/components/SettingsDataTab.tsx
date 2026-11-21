import { useState, useEffect } from 'react'
import type { Settings, StorageInfo, LibraryImportMode } from '../types'
import type { UpdateSetting } from '../hooks/useSettings'
import type { ChooseCaptureRootResult } from '../../../shared/types'
import ConfirmDialog from './ConfirmDialog'
import ChoiceDialog from './ChoiceDialog'
import { space } from '../styles'
import { formatBytes } from '../utils'
import { useExportStore } from '../stores/exportStore'
import { useT } from '../i18n'
import { s } from './settingsStyles'

type Props = {
  active: boolean
  settings: Pick<Settings, 'captureResize' | 'videoExportFormat'>
  storage: StorageInfo | null
  storageLoading: boolean
  storageFailed: boolean
  onStorageChanged: (storage: StorageInfo) => void
  onUpdateSetting: UpdateSetting
  onShareExport: () => Promise<{ canceled: boolean; count?: number; path?: string }>
  onShareImport: (mode: LibraryImportMode) => Promise<{ canceled: boolean; count?: number; errors?: string[] }>
}

export default function SettingsDataTab(p: Props) {
  const { t, tp } = useT()
  const { storage, storageLoading, storageFailed } = p
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
  const [captureRootStatus, setCaptureRootStatus] = useState<{ text: string; error?: boolean } | null>(null)
  // 移動の進み具合。total が 0 なら動いていない。**押している間ずっと出す**——実体の
  // コピーで分単位かかるので、何も出ないと固まったようにしか見えない。
  const [moveProgress, setMoveProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 })
  useEffect(() => window.api.onCaptureMoveProgress(setMoveProgress), [])
  // 移すものがあるときの確認（アプリの確認画面で聞く。Windows 標準の画面だと見た目が浮く）。
  const [movePrompt, setMovePrompt] = useState<{ path: string; count: number; bytes: number } | null>(null)
  // インポートの読み込み方を聞いている間。
  const [importPrompt, setImportPrompt] = useState(false)

  const showCaptureRootResult = async (result: ChooseCaptureRootResult): Promise<void> => {
    if (result.ok) {
      // 元が既に無くて飛ばしたぶんは、黙って減らさず件数を出す
      // （アプリの外で消されたファイルがあった、という手掛かりになる）。
      setCaptureRootStatus({
        text: t('settings.captureRootChanged', { count: String(result.moved) })
          + (result.missing > 0 ? t('settings.captureRootMissingSuffix', { count: String(result.missing) }) : ''),
      })
      p.onStorageChanged(await window.api.getStorageInfo())
      return
    }
    if (result.reason === 'needs-confirm') {
      setMovePrompt({ path: result.path, count: result.count, bytes: result.bytes })
      return
    }
    // 選ばなかった・移動をやめたときは何も出さない。何も起きていないので。
    if (result.reason === 'canceled' || result.reason === 'move-canceled') return
    setCaptureRootStatus({
      text: result.reason === 'move-conflict'
        ? t('settings.captureMoveConflict', { path: result.conflictPath })
        : t(result.reason === 'invalid' ? 'settings.captureRootInvalid'
          : result.reason === 'unwritable' ? 'settings.captureRootUnwritable'
          : 'settings.captureMoveFailed'),
      error: true,
    })
  }

  const runShareImport = async (mode: LibraryImportMode): Promise<void> => {
    setShareImporting(true)
    setShareImportStatus(null)
    try {
      const result = await p.onShareImport(mode)
      if (result.canceled) {
        if (result.count != null) setShareImportStatus({ text: tp('settings.stoppedCount', result.count) })
        // count なし = フォルダ選択自体のキャンセル（無言、従来通り）
      } else {
        const errMsg = result.errors && result.errors.length > 0 ? t('settings.importErrorSuffix', { count: result.errors.length }) : ''
        setShareImportStatus({ text: tp('settings.importedCount', result.count ?? 0) + errMsg })
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
  }

  return (
    <div style={{ display: p.active ? 'contents' : 'none' }}>
      <>
        {/* 撮ったものの置き場所は、これまでアプリのどこにも出ていなかった。拡張のフォルダは
            開けるのに自分の何百枚には辿り着けない状態だったので、パスをそのまま出して開ける
            ようにする。 */}
        <div style={{ ...s.group, ...s.groupFirst }}>
          <div style={s.section}>{t('settings.saving')}</div>
          <div style={s.actionRow}>
            <div style={{ ...s.cardText, flex: 1 }}>
              <span style={s.label}>{t('settings.storage')}</span>
              <div style={{ ...s.pathBox, margin: '4px 0' }}>{storage?.captureDir ?? '—'}</div>
              <span style={s.hint}>{t('settings.storageHint')}</span>
            </div>
            {/* 変更したら使用量も出し直す。**古い場所のぶんは新しい場所の数字に
                入らない**ので、変えた直後に容量が減って見えるのが正しい。 */}
            <button style={s.addBtn} disabled={moveProgress.total > 0} onClick={async () => {
                setCaptureRootStatus(null)
                await showCaptureRootResult(await window.api.chooseCaptureRoot())
              }}>
              {t('settings.changeCapturesFolder')}
            </button>
          </div>
          {moveProgress.total > 0 && (
            <div style={s.plainRow}>
              <div style={s.hint}>
                {t('settings.captureMoving', { current: String(moveProgress.current), total: String(moveProgress.total) })}
              </div>
              <button style={s.addBtn} onClick={() => window.api.cancelCaptureMove()}>{t('action.stop')}</button>
            </div>
          )}
          {captureRootStatus && <div style={{ ...s.statusLine, ...(captureRootStatus.error ? s.statusLineError : s.statusLineOk) }}>{captureRootStatus.text}</div>}
          {/* 撮った静止画をどの解像度まで保存するか。容量の話なので保存場所と同じまとまりに置く
              （4K 環境で C ドライブが埋まる、という声から入れた設定）。名前に「画像」を添えているのは、
              録画には効かないことを説明を読まずに読み取らせるため。 */}
          <div style={s.row}>
            <div style={s.cardText}>
              <span style={s.label}>{t('settings.captureResize')}（{t('settings.captureResizeTarget')}）</span>
              <span style={s.hint}>{t('settings.captureResizeHint')}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: space.x4 }}>
              {([['source', t('settings.captureResize.source')], ['fhd', t('settings.captureResize.fhd')], ['hd', t('settings.captureResize.hd')], ['screen', t('settings.captureResize.screen')]] as const).map(([value, label]) => {
                const active = p.settings.captureResize === value
                return (
                  <button key={value} onClick={() => p.onUpdateSetting('captureResize', value)} data-current={active ? 'true' : undefined}
                    style={{ ...s.sizeBtn, background: active ? 'var(--bg-surface-hover)' : 'transparent', color: active ? 'var(--accent-text)' : 'var(--text-secondary)', borderColor: active ? 'var(--accent)' : 'var(--border-default)' }}>
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
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
                <div key={labelKey} style={s.usageRow}>
                  <span style={s.hint}>{t(labelKey)}</span>
                  <span style={s.usageValue}>{value}</span>
                </div>
              ))}
            </>
          )}
        </div>
        {/* 選んだものを書き出すときの動画の形式。**すぐ下の「エクスポート」はライブラリの共有
            書き出しで、この設定を見ない。** 見出しに「書き出し」を使うと同じ語が隣り合って
            見分けられなくなるため、こちらは「変換」と呼ぶ。 */}
        <div style={s.group}>
          <div style={s.section}>{t('settings.videoExport')}</div>
          <div style={s.row}>
            <div style={s.cardText}>
              <span style={s.label}>{t('settings.videoExportFormat')}</span>
              <span style={s.hint}>{t('settings.videoExportFormatHint')}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: space.x4 }}>
              {([['original', t('settings.videoExportFormat.original')], ['h264', t('settings.videoExportFormat.h264')]] as const).map(([value, label]) => {
                const active = p.settings.videoExportFormat === value
                return (
                  <button key={value} onClick={() => p.onUpdateSetting('videoExportFormat', value)} data-current={active ? 'true' : undefined}
                    style={{ ...s.sizeBtn, background: active ? 'var(--bg-surface-hover)' : 'transparent', color: active ? 'var(--accent-text)' : 'var(--text-secondary)', borderColor: active ? 'var(--accent)' : 'var(--border-default)' }}>
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
        {/* エクスポート・インポート・サムネイルの修復は、どれもライブラリ全体への作業なので 1 つのまとまりにする。 */}
        <div style={s.group}>
          <div style={s.section}>{t('settings.library')}</div>
          <div style={s.actionRow}>
            <div style={s.cardText}>
              <span style={s.label}>{t('action.export')}</span>
              <span style={s.hint}>{t('settings.exportHint')}</span>
            </div>
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
          <div style={s.actionRow}>
            <div style={s.cardText}>
              <span style={s.label}>{t('settings.import')}</span>
              <span style={s.hint}>{t('settings.importHint')}</span>
            </div>
            {shareImportProgress ? (
              <div style={{ ...s.progressWrap, flex: '0 0 220px' }}>
                <div style={s.progressBar}>
                  <div style={{ ...s.progressFill, width: `${shareImportProgress.total > 0 ? Math.round(shareImportProgress.current / shareImportProgress.total * 100) : 0}%` }} />
                </div>
                <span style={s.progressLabel}>{shareImportProgress.current}/{shareImportProgress.total}</span>
                <button style={s.cancelBtn} onClick={() => window.api.shareImportCancel()}>{t('action.stop')}</button>
              </div>
            ) : (
              <button style={s.addBtn} disabled={shareImporting} onClick={() => setImportPrompt(true)}>
                {shareImporting ? t('settings.importing') : t('settings.importLibrary')}
              </button>
            )}
          </div>
          {shareImportStatus && <div style={{ ...s.statusLine, ...(shareImportStatus.error ? s.statusLineError : s.statusLineOk) }}>{shareImportStatus.text}</div>}
          <div style={s.actionRow}>
            <div style={s.cardText}>
              <span style={s.label}>{t('settings.thumbRepair')}</span>
              <span style={s.hint}>{t('settings.thumbRepairHint')}</span>
            </div>
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
      {movePrompt && (
        <ConfirmDialog
          title={t('dialog.moveCaptures.title')}
          message={t('dialog.moveCaptures.message', { count: String(movePrompt.count), size: formatBytes(movePrompt.bytes), dest: movePrompt.path })
            + '\n\n' + t('dialog.moveCaptures.detail')}
          confirmLabel={t('dialog.moveCaptures.proceed')}
          // 閉じてから移す（移動は分単位かかるので、確認画面を開いたまま待たせない。進み具合は設定画面に出る）。
          onConfirm={() => { const path = movePrompt.path; window.setTimeout(() => { void window.api.moveCaptureRoot(path).then(showCaptureRootResult) }, 0) }}
          onClose={() => setMovePrompt(null)}
        />
      )}
      {importPrompt && (
        <ChoiceDialog
          title={t('dialog.importLibrary.title')}
          message={t('dialog.importLibrary.message')}
          choices={[
            { label: t('dialog.importLibrary.restore'), description: t('dialog.importLibrary.restoreHint'), onSelect: () => { void runShareImport('restore') } },
            { label: t('dialog.importLibrary.receive'), description: t('dialog.importLibrary.receiveHint'), onSelect: () => { void runShareImport('receive') } },
          ]}
          onClose={() => setImportPrompt(false)}
        />
      )}
    </div>
  )
}
