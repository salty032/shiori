import { describe, expect, it } from 'vitest'
import { buildImageFilter } from './db'
import { restoredFrameCounts } from './db-video-frames'

// buildImageFilter は WHERE 句文字列と params 配列を組み立てる純粋関数。listImages/countImages
// が実際に発行する SQL の条件分岐・カーソルページングの tie-break をここで直接固定する。
// better-sqlite3 のネイティブバイナリは Electron 用 ABI でビルドされており（postinstall の
// electron-rebuild）、素の Node で動く vitest からは読み込めないため、DB へ実際に接続する
// listImages 経由の統合テストではなく、buildImageFilter 単体のテストとして書く。

describe('buildImageFilter', () => {
  it('条件なしなら空の WHERE と空の params', () => {
    expect(buildImageFilter({})).toEqual({ where: '', params: [] })
  })

  it('search は3文字以上なら FTS(images_fts_v2) の MATCH で、値はダブルクォートでフレーズ化する', () => {
    const result = buildImageFilter({ search: 'cat' })
    expect(result.where).toBe('WHERE id IN (SELECT rowid FROM images_fts_v2 WHERE images_fts_v2 MATCH ?)')
    expect(result.params).toEqual(['"cat"'])
  })

  it('search は保存側（search_text）と同じ normalizeSearchText を通してから当てる（半角カナ・全角英数等の表記ゆれを吸収。docs/SPEC.md 5章）', () => {
    const result = buildImageFilter({ search: 'ﾄﾞｷﾄﾞｷ' })
    expect(result.params).toEqual(['"どきどき"'])
  })

  it('search が3文字未満なら search_text の LIKE にフォールバックする', () => {
    const result = buildImageFilter({ search: 'ab' })
    expect(result.where).toBe(`WHERE search_text LIKE ? ESCAPE '\\'`)
    expect(result.params).toEqual(['%ab%'])
  })

  it('空白区切りの語は「すべて含む」で絞る（打った語順を要求しない）', () => {
    const result = buildImageFilter({ search: '第3話 指揮官' })
    expect(result.where).toBe('WHERE id IN (SELECT rowid FROM images_fts_v2 WHERE images_fts_v2 MATCH ?)')
    expect(result.params).toEqual(['"第3話" AND "指揮官"'])
  })

  it('短い語は FTS へ混ぜず LIKE を足す（trigram を作れない語を入れると MATCH ごと0件になる）', () => {
    const result = buildImageFilter({ search: 'ab cat' })
    expect(result.where).toBe(
      `WHERE id IN (SELECT rowid FROM images_fts_v2 WHERE images_fts_v2 MATCH ?) AND search_text LIKE ? ESCAPE '\\'`
    )
    expect(result.params).toEqual(['"cat"', '%ab%'])
  })

  it('長さ判定は語ごとに正規化後の長さで行う（3文字未満の語は LIKE 側へ落ちる）', () => {
    const result = buildImageFilter({ search: 'a b' })
    expect(result.where).toBe(`WHERE search_text LIKE ? ESCAPE '\\' AND search_text LIKE ? ESCAPE '\\'`)
    expect(result.params).toEqual(['%a%', '%b%'])
  })

  it('語数には上限があり、超えたぶんは無視する（壊れた入力で条件が無限に伸びない）', () => {
    const result = buildImageFilter({ search: 'aaa bbb ccc ddd eee fff ggg hhh iii jjj' })
    expect(result.params).toEqual(['"aaa" AND "bbb" AND "ccc" AND "ddd" AND "eee" AND "fff" AND "ggg" AND "hhh"'])
  })

  it('正規化して空文字になる入力（記号だけ等）は絞り込み自体を付けない（0件にするより素直）', () => {
    expect(buildImageFilter({ search: '%_' })).toEqual({ where: '', params: [] })
  })

  it('site は host の完全一致（renderer 側のチップ表示条件と揃える。BUG-6）', () => {
    const result = buildImageFilter({ site: 'example.com' })
    expect(result.where).toBe('WHERE host = ?')
    expect(result.params).toEqual(['example.com'])
  })

  it('after/toDate は captured_at の範囲条件', () => {
    const result = buildImageFilter({ after: 100, toDate: 200 })
    expect(result.where).toBe('WHERE captured_at >= ? AND captured_at < ?')
    expect(result.params).toEqual([100, 200])
  })

  it('tags: tagMode=and は COUNT(DISTINCT) HAVING でタグ数と一致させる', () => {
    const result = buildImageFilter({ tags: ['red', 'blue'], tagMode: 'and' })
    expect(result.where).toBe(
      'WHERE id IN (SELECT image_id FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE t.name IN (?, ?) GROUP BY image_id HAVING COUNT(DISTINCT t.name) = ?)'
    )
    expect(result.params).toEqual(['red', 'blue', 2])
  })

  it('tags: tagMode=or は DISTINCT image_id のいずれか一致', () => {
    const result = buildImageFilter({ tags: ['red', 'blue'], tagMode: 'or' })
    expect(result.where).toBe(
      'WHERE id IN (SELECT DISTINCT image_id FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE t.name IN (?, ?))'
    )
    expect(result.params).toEqual(['red', 'blue'])
  })

  it('tags: 未指定・空配列は条件を追加しない', () => {
    expect(buildImageFilter({ tags: [] }).where).toBe('')
  })

  it('mediaType=video は media_type カラムの完全一致', () => {
    const result = buildImageFilter({ mediaType: 'video' })
    expect(result.where).toBe('WHERE media_type = ?')
    expect(result.params).toEqual(['video'])
  })

  it('mediaType=image は media_type IS NULL も含む（既存の画像行は media_type 未設定のため）', () => {
    const result = buildImageFilter({ mediaType: 'image' })
    expect(result.where).toBe("WHERE (media_type IS NULL OR media_type = 'image')")
    expect(result.params).toEqual([])
  })

  it('複数条件は AND で連結される（宣言順: search, after/before系, toDate, site, tags）', () => {
    const result = buildImageFilter({ search: 'cat', site: 'example.com' })
    expect(result.where).toBe(
      'WHERE id IN (SELECT rowid FROM images_fts_v2 WHERE images_fts_v2 MATCH ?) AND host = ?'
    )
    expect(result.params).toEqual(['"cat"', 'example.com'])
  })

  describe('カーソルページング（before/beforeId）の tie-break', () => {
    it('date_desc + before + beforeId: captured_at 未満、または同値で id 未満', () => {
      const result = buildImageFilter({ sortOrder: 'date_desc', before: 500, beforeId: 42 })
      expect(result.where).toBe('WHERE (captured_at < ? OR (captured_at = ? AND id < ?))')
      expect(result.params).toEqual([500, 500, 42])
    })

    it('date_asc + before + beforeId: captured_at 超過、または同値で id 超過', () => {
      const result = buildImageFilter({ sortOrder: 'date_asc', before: 500, beforeId: 42 })
      expect(result.where).toBe('WHERE (captured_at > ? OR (captured_at = ? AND id > ?))')
      expect(result.params).toEqual([500, 500, 42])
    })

    it('date_desc + before のみ（beforeId 未指定）: captured_at 未満のみ', () => {
      const result = buildImageFilter({ sortOrder: 'date_desc', before: 500 })
      expect(result.where).toBe('WHERE captured_at < ?')
      expect(result.params).toEqual([500])
    })

    it('date_asc + before のみ（beforeId 未指定）: captured_at 超過のみ', () => {
      const result = buildImageFilter({ sortOrder: 'date_asc', before: 500 })
      expect(result.where).toBe('WHERE captured_at > ?')
      expect(result.params).toEqual([500])
    })

    it('sortOrder 未指定（既定 date_desc 相当）でも before/beforeId は tie-break される', () => {
      const result = buildImageFilter({ before: 500, beforeId: 42 })
      expect(result.where).toBe('WHERE (captured_at < ? OR (captured_at = ? AND id < ?))')
    })

    it('sortOrder=random は before/beforeId を無視する（一括サンプリングのため）', () => {
      const result = buildImageFilter({ sortOrder: 'random', before: 500, beforeId: 42 })
      expect(result.where).toBe('')
      expect(result.params).toEqual([])
    })

    it('random でも他条件とは併用できる', () => {
      const result = buildImageFilter({ sortOrder: 'random', before: 500, beforeId: 42, site: 'example.com' })
      expect(result.where).toBe('WHERE host = ?')
      expect(result.params).toEqual(['example.com'])
    })
  })
})

describe('restoredFrameCounts', () => {
  const frames = [
    { mediaTime: 0, frameIndex: 0, captured: true, verified: 'unknown' as const },
    { mediaTime: 1 / 24, frameIndex: 0, captured: false, verified: 'same' as const },
    { mediaTime: 2 / 24, frameIndex: 1, captured: false, verified: 'changed' as const },
  ]

  it('コマ表から母数・撮り逃し・要確認を再構築し、未通知数を保持する', () => {
    expect(restoredFrameCounts(frames, { ambiguous: 1, unreported: 4 })).toEqual({
      uncaptured: 2,
      ambiguous: 1,
      sourceFrames: 3,
      unreported: 4,
    })
  })

  it('未検証(null)は要確認0へ潰さない', () => {
    expect(restoredFrameCounts(frames, { ambiguous: null, unreported: null })).toMatchObject({
      ambiguous: null,
      unreported: null,
    })
  })
})
