// 一括タグ操作 IPC（taggerGetTagsBulk/taggerAddTagBulk/taggerRemoveTagBulk）の
// main 側 DoS ガード上限。renderer 側はこの値でチャンク分割して全件を処理する。
export const MAX_BULK_IDS = 1000

// 手動タグ作成時の上限（入力欄 maxLength・normalizeTag(Name) の既定値）。
export const MAX_TAG_LENGTH = 64

// タグの絞り込み・削除（tagsFilter / taggerRemoveTag系）で使う参照専用の上限。
// WD Tagger の AI タグ（looking_at_viewer 等 17字以上、キャラ名タグは30字超）を
// 生成側は切り詰めずに DB へ挿入しているため、参照側がこれより短く切り詰めると
// 絞り込み・削除の照合が一致しなくなる（B-1）。生成側の MAX_TAG_LENGTH より
// 十分大きい値にすること。
export const MAX_TAG_LOOKUP_LENGTH = 100

export const MAX_MEMO_LENGTH = 5000
