const { readdirSync, unlinkSync } = require('fs')
const { join } = require('path')

const KEEP = new Set(['ja.pak', 'en-US.pak'])

exports.default = async ({ appOutDir }) => {
  const localesDir = join(appOutDir, 'locales')
  let removed = 0
  try {
    for (const file of readdirSync(localesDir)) {
      if (!KEEP.has(file)) {
        unlinkSync(join(localesDir, file))
        removed++
      }
    }
  } catch {
    // locales ディレクトリがない場合（dev等）は無視
  }
  if (removed > 0) console.log(`[afterPack] removed ${removed} unused locale files`)
}
