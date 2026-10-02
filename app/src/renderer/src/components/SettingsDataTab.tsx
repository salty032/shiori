import { useState, useEffect } from 'react'
import type { Settings, StorageInfo } from '../types'
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
  onUpdateVideoExportFormat: (value: Settings['videoExportFormat']) => void
  onUpdateCaptureResize: (value: Settings['captureResize']) => void
  onShareExport: () => Promise<{ canceled: boolean; count?: number; path?: string }>
  onShareImport: () => Promise<{ canceled: boolean; count?: number; errors?: string[]; importedFolders?: number }>
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

  return (
    <div style={{ display: p.active ? 'contents' : 'none' }}>
      <>
        {/* 撮ったものの置き場所は、これまでアプリのどこにも出ていなかった。拡張のフォルダは
            開けるのに自分の何百枚には辿り着けない状態だったので、パスをそのまま出して開ける
            ようにする。保存先の変更は既存ファイルの移動と DB のパス書き換えを伴うため別件。 */}
        <div style={{ ...s.group, ...s.groupFirst }}>
          <div style={s.section}>{t('settings.storage')}</div>
          <div style={s.actionRow}>
            <div style={s.pathBox}>{storage?.captureDir ?? '—'}</div>
            {/* 変更したら使用量も出し直す。**古い場所のぶんは新しい場所の数字に
                入らない**ので、変えた直後に容量が減って見えるのが正しい。 */}
            <button style={s.addBtn} disabled={moveProgress.total > 0} onClick={async () => {
                setCaptureRootStatus(null)
                const result = await window.api.chooseCaptureRoot()
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
              }}>
              {t('settings.changeCapturesFolder')}
            </button>
          </div>
          <div style={s.hint}>{t('settings.storageHint')}</div>
          {moveProgress.total > 0 && (
            <div style={s.actionRow}>
              <div style={s.hint}>
                {t('settings.captureMoving', { current: String(moveProgress.current), total: String(moveProgress.total) })}
              </div>
              <button style={s.addBtn} onClick={() => window.api.cancelCaptureMove()}>{t('action.stop')}</button>
            </div>
          )}
          {captureRootStatus && <div style={{ ...s.statusLine, ...(captureRootStatus.error ? s.statusLineError : s.statusLineOk) }}>{captureRootStatus.text}</div>}
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
            いるかを見た直後に目に入る位置でないと結び付かない）。行の名前を「画像」に
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
    </div>
  )
}
