import { access } from 'fs/promises'

// ファイルがあるか。読めない・権限が無いときも「無い」として返す。
export function fileExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false)
}
