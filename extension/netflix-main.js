// Netflix 専用・ページの main world で動くブリッジ。
// Netflix は独自プレイヤーが <video> 要素の状態と再生制御を管理しており、content script
// (isolated world)から currentTime を直書きしたり pause を叩くと再生状態が崩れることがある。
// コマ送り時の pause/seek をページ側の通常の再生制御に寄せるには、Netflix 側のプレイヤー API を
// 通す必要があるが、その API(netflix.appContext...)は main world にしか存在しない。
// そこで content.js からは window の CustomEvent 'shiori-nflx-cmd' でコマンドを送り、
// ここで受けて内部 API の pause()/seek() を呼ぶ。
//
// API 名は Netflix 側の変更で壊れうる（他サービスの DOM 依存箇所と同種の脆さ）。壊れた場合は
// getPlayer() が null を返し、コマ送りが無反応になるだけで例外は投げない。
(() => {
  function getPlayer() {
    try {
      const videoPlayer = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer
      if (!videoPlayer) return null
      const ids = videoPlayer.getAllPlayerSessionIds?.() || []
      if (!ids.length) return null
      // 再生セッションは "watch-…" 形式。複数（前作品の残骸等）ある場合に備え watch を優先し、
      // 無ければ最後のものを使う。
      const id = ids.find((x) => typeof x === 'string' && x.includes('watch')) ?? ids[ids.length - 1]
      return videoPlayer.getVideoPlayerBySessionId(id) || null
    } catch {
      return null
    }
  }

  window.addEventListener('shiori-nflx-cmd', (event) => {
    const detail = event.detail || {}
    const player = getPlayer()
    if (!player) return
    try {
      if (detail.type === 'pause') {
        player.pause()
      } else if (detail.type === 'seek') {
        // seek 前に pause しておかないと着地後に再生が続き、狙ったフレームで止まらない。
        player.pause()
        player.seek(detail.value) // ミリ秒
      }
    } catch {
      // API 形状が変わった等。無反応にとどめる。
    }
  })
})()
