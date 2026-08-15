// コマ送りのキー（, / .）だけを、ページのどのスクリプトよりも先に受け取るための入口。
//
// **なぜ content.js の中ではだめか。** content.js は document_idle 起動なので、サイトが先に
// 登録したキーハンドラより後手になる。document のキャプチャ段階で stopImmediatePropagation
// しても、先に登録された側は既に走っている。
//
// **なぜ window か。** イベントは window → document → … の順に降りる。window のキャプチャ段階に
// 立てば、document 以下に登録されたサイトのハンドラはどの段階のものも走らない。
// document_start はページの最初のスクリプトより前に走るので、サイトが window のキャプチャ段階に
// 登録していても、こちらの登録が先になる。
//
// **なぜ keydown だけでは足りないか。** 押した瞬間を止めても、サイトが keyup や keypress を
// 見ていればその機能は発動する。DMM TV は , / . が再生速度に当たっており、keydown だけを
// 塞いだ版では**コマ送りは正常に効いたまま倍速だけが変わり続けた**（2026-08-15 実機）。
// 倍速が変われば素材の時間軸が打鍵のたびに伸縮するので、研究用途では致命的。
// content.js の suppressCaptureKey が keydown/keyup/keypress の 3 つとも塞いでいるのも同じ理由。
// **奪ったキーは、離すところまで奪い切る。**
//
// **なぜ content.js 本体を document_start にしないか。** 本体はタイトル取得を持っており、
// DOM が出来上がる前に走ると仮のタイトルを掴む。作品名の取り違えは黙って記録に残るので、
// 起動を早めるのはキーの入口だけに限る。
//
// このファイルは判断をしない（動画があるか、いま何コマ目かを知らない）。同じ拡張の
// コンテンツスクリプトは同じ isolated world を共有するので、content.js が置いた
// window.__shioriFrameStepKey を呼び、**受け付けられたときだけ**サイトへの伝播を止める。
// 動画の無いページ（一覧・検索）では止めないので、サイト本来の , / . はそのまま残る。

// keydown を奪ったキー。同じキーの keypress / keyup もまとめて捨てるために覚えておく。
const shioriHeldKeys = new Set()

function shioriIsStepKey(e) {
  if (e.key !== ',' && e.key !== '.') return false
  // 修飾キー付き（Ctrl+. など）はサイト・ブラウザのものなので触らない。
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false
  // , / . は文字入力なので、入力欄に入っている間は通す（検索欄に「、」が入るのを防ぐ）。
  const target = e.target
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return false
  return true
}

window.addEventListener('keydown', (e) => {
  if (!shioriIsStepKey(e)) return
  // content.js がまだ読み込まれていない（ページを開いた直後）間は、サイトに任せる。
  const step = window.__shioriFrameStepKey
  if (typeof step !== 'function') return
  if (!step(e.key === '.' ? 1 : -1)) return
  shioriHeldKeys.add(e.key)
  e.preventDefault()
  e.stopImmediatePropagation()
}, true)

// keydown を奪ったキーの続き（keypress / keyup）。**押しっぱなしの間 keydown は繰り返し届くが
// keyup は 1 回だけ**なので、keyup で覚えを消す。
function shioriSwallowTail(e) {
  if (!shioriHeldKeys.has(e.key)) return
  if (e.type === 'keyup') shioriHeldKeys.delete(e.key)
  e.preventDefault()
  e.stopImmediatePropagation()
}
window.addEventListener('keypress', shioriSwallowTail, true)
window.addEventListener('keyup', shioriSwallowTail, true)

// 押している途中でフォーカスが移ると keyup が届かず、覚えが残ったままになる（次に同じキーを
// 押したとき、コマ送りをしていないのに keyup だけ捨てることになる）。フォーカスが外れた
// 時点で捨てる。
window.addEventListener('blur', () => shioriHeldKeys.clear())
