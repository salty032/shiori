// アプリから届いた知らせ（保存した・失敗した）を視聴中のページに出す部分。

let noticeTimer = null

// pending: 続きの通知で書き換える予定の通知（録画の「撮り逃しを確認中」）。次の通知が来るまで
// 消さない。短く消すと、結果が出る前に一度消えてまた出る。来なかったときのために上限は置く。
const PENDING_NOTICE_MAX_MS = 15000
let noticePending = false
function showShioriNotice(level, message, pending = false) {
  let host = document.getElementById('shiori-browser-notice')
  // フルスクリーン時、サイトによっては body 直下の要素を display:none で隠す CSS がある
  // (niconico 等)。動画の親要素内なら隠されないので、フルスクリーン時はそちらに追加する。
  const fsVideo = document.fullscreenElement ? document.fullscreenElement.querySelector('video') : null
  const noticeRoot = (fsVideo?.parentElement) || document.fullscreenElement || document.documentElement
  if (!host) {
    host = document.createElement('div')
    host.id = 'shiori-browser-notice'
    // サイト側のプレーヤーCSS（フルスクリーン時の全面レイヤー強制スタイル等）に
    // position/サイズを上書きされないよう !important で固定する
    // (例: Prime Video 全画面時、video-surface の親要素配下に追加すると
    //  画面全体に引き伸ばされて消える)
    const hostStyle = host.style
    hostStyle.setProperty('position', 'fixed', 'important')
    hostStyle.setProperty('left', '50%', 'important')
    hostStyle.setProperty('top', '28px', 'important')
    hostStyle.setProperty('right', 'auto', 'important')
    hostStyle.setProperty('bottom', 'auto', 'important')
    hostStyle.setProperty('width', 'auto', 'important')
    hostStyle.setProperty('height', 'auto', 'important')
    hostStyle.setProperty('transform', 'translateX(-50%)', 'important')
    hostStyle.setProperty('z-index', '2147483647', 'important')
    hostStyle.setProperty('pointer-events', 'none', 'important')
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = `
      .notice {
        max-width: min(560px, calc(100vw - 32px));
        box-sizing: border-box;
        padding: 9px 16px 9px 14px;
        border-radius: 8px;
        font: 600 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #fcfcfa;
        background: rgba(20, 24, 31, .98);
        border: 1px solid rgba(255, 255, 255, .18);
        border-left: 4px solid rgba(255, 255, 255, .4);
        box-shadow: 0 8px 22px rgba(0, 0, 0, .28), 0 0 0 1px rgba(0, 0, 0, .18);
        text-shadow: 0 1px 2px rgba(0, 0, 0, .5);
        word-break: break-word;
        opacity: 1;
        transform: translateY(0);
        transition: opacity .28s ease, transform .34s cubic-bezier(.22, 1, .36, 1);
      }
      .notice.hidden {
        opacity: 0;
        transform: translateY(-14px);
      }
      .success { border-left-color: #22c55e; }
      .warning { border-left-color: #eab308; }
      .error { border-left-color: #ef4444; }
    `
    const box = document.createElement('div')
    box.className = 'notice hidden'
    shadow.append(style, box)
  }
  if (host.parentElement !== noticeRoot) noticeRoot.appendChild(host)

  const box = host.shadowRoot?.querySelector('.notice')
  // 書き換え待ちの通知を書き換えるときは、左端をその場に固定する。文言は末尾だけが違う形に
  // 揃えてあり（「撮り逃し 確認中」→「なし」「3コマ」）、中央寄せのままだと長さが変わるたびに
  // 文字が左右へ動く。それ以外の通知は従来どおり中央に出す。
  const replacing = noticePending && box && !box.classList.contains('hidden')
  if (replacing) {
    host.style.setProperty('left', `${host.getBoundingClientRect().left}px`, 'important')
    host.style.setProperty('transform', 'none', 'important')
  } else {
    host.style.setProperty('left', '50%', 'important')
    host.style.setProperty('transform', 'translateX(-50%)', 'important')
  }
  noticePending = pending
  if (box) {
    box.classList.remove('info', 'success', 'warning', 'error')
    box.classList.add(level)
    box.textContent = message
    // 初期 hidden 状態を 2フレーム後に解除して、ぬるっと出現させる
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.remove('hidden')))
  } else {
    host.textContent = message
  }

  // 成功・情報通知は短めに自動消滅させ、警告・エラーは少し長めに残す
  const dismissAfter = pending ? PENDING_NOTICE_MAX_MS : level === 'success' || level === 'info' ? 1800 : 3600
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    noticeTimer = null
    if (!box) {
      host.remove()
      return
    }
    // フェードアウトさせてから除去。新しい通知が来て再表示された場合は除去しない
    box.classList.add('hidden')
    const remove = () => {
      if (box.classList.contains('hidden')) host.remove()
    }
    box.addEventListener('transitionend', remove, { once: true })
    setTimeout(remove, 450)
  }, dismissAfter)
}

// 表示中の通知を即座に消す（フェードなし）。キャプチャ直前に呼び、
// 通知がスクショに焼き込まれたり次の「保存しました」と重なるのを防ぐ。
function clearShioriNotice() {
  if (noticeTimer) {
    clearTimeout(noticeTimer)
    noticeTimer = null
  }
  document.getElementById('shiori-browser-notice')?.remove()
}
