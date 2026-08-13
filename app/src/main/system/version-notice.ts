import { t } from './i18n'

export type VersionNotice =
  | { kind: 'whatsNew'; version: string; notes: string[] }
  | { kind: 'toast'; message: string }
  | { kind: 'none' }

// 更新後に開いたとき何を知らせるかを判定する純粋関数。
// - previousRunVersion: 前回起動時のバージョン（初回起動は null）
// - currentVersion: 今回のバージョン（app.getVersion()）
// - notes: RELEASE_NOTES[currentVersion]（未定義もありうる）
export function decideVersionNotice(
  previousRunVersion: string | null,
  currentVersion: string,
  notes: string[] | undefined,
): VersionNotice {
  if (previousRunVersion === currentVersion) return { kind: 'none' }
  if (previousRunVersion === null) return { kind: 'none' }
  if (notes && notes.length > 0) return { kind: 'whatsNew', version: currentVersion, notes }
  return { kind: 'toast', message: t('notice.updated', { version: currentVersion }) }
}
