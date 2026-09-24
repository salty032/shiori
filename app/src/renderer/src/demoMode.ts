// Web デモ版として動いているか。**App 以下が web/ を import しないための橋渡し**で、
// mockApi が window.api を差すときに立てる（デスクトップ本体では誰も呼ばないので false）。
//
// 必要な理由は空ライブラリの画面。デスクトップ版の初回案内は「拡張機能フォルダを開く →
// 対応サイトで動画を開く → ホットキーを押す」だが、デモではボタンを押しても
// 「デモ版では利用できません」と断るだけで、ホットキーも効かない。**案内が全部空振りする
// 画面を第一印象として出すことになる**ため、デモ専用の説明へ差し替える。
let demoMode = false

export function markDemoMode(): void {
  demoMode = true
}

export function isDemoMode(): boolean {
  return demoMode
}
