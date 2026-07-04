export const GITHUB_OWNER = 'salty032'
export const GITHUB_REPO = 'shiori'
export const RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`

// 一括タグ操作 IPC（taggerGetTagsBulk/taggerAddTagBulk/taggerRemoveTagBulk）の
// main 側 DoS ガード上限。renderer 側はこの値でチャンク分割して全件を処理する。
export const MAX_BULK_IDS = 1000
