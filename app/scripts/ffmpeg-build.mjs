// 同梱する ffmpeg のビルド名。**ここが唯一の原本。**
//
// バイナリを取る側（fetch-ffmpeg.mjs）と、対応ソースを取る側
// （fetch-ffmpeg-source.mjs）で別々に書き写すと、片方だけ更新したときに
// 「バイナリと無関係のソースを添付した Release」ができる。LGPL の要求は
// **配ったバイナリに対応するソース**なので、ズレると表記だけが正しく見える。
//
// 名前にコミットが埋まっている（-g78690eba61 の部分）ので、ソース側は
// ここから読み取る。NOTICE.md の記載もこのビルド名と揃えること。
export const BUILD = 'ffmpeg-n6.1.2-192-g78690eba61-win64-lgpl-6.1'

/** ビルド名に埋まっている FFmpeg のコミット（例: 78690eba61） */
export function commitFromBuild(build = BUILD) {
  const m = /-g([0-9a-f]{7,40})-/.exec(build)
  if (!m) throw new Error(`ビルド名からコミットを読み取れません: ${build}`)
  return m[1]
}
