// アプリから拡張へ送るメッセージの形。**送る側（main）はこの型でしか送れない。**
//
// 以前は `broadcastMessage(msg: object)` で、種類の名前や項目名を打ち間違えても型検査は通り、
// 拡張の background.js が黙って捨てていた（画面には何も出ない）。
//
// 拡張は項目を 1 つずつ書き写して作り直す（background.js の normalizeServerMessage と
// content.js の normalizePortMessage）。**ここに項目を足したら、その 2 つにも足す。**
// 足し忘れは extension-parity.test.ts が落とす——この型に載っている項目を全部入れた見本を、
// 拡張の 2 つの関数に実際に通して、1 つも欠けずに出てくるかを見ている。
//
// 拡張から届く側の型は main/browser/ws-server.ts の ExtensionMessage。
export type AppToExtensionMessage =
  /** 接続できた合図（ws-server.ts が接続のたびに送る） */
  | { type: 'connected' }
  /**
   * 撮る直前。プレーヤーの部品を隠させる。
   * holdMs: 隠したままにする上限（録画では録画の長さぶん伸ばす）。省くと拡張の既定。
   * video: 録画のとき true。カーソルを消し、コマ通知を始める。
   */
  | { type: 'pre-capture'; holdMs?: number; video?: boolean }
  /** 撮り終えた。immediate はサービスごとの復帰待ちを踏まずにすぐ戻す（録画だけ。スクショでは付けない） */
  | { type: 'post-capture'; immediate?: boolean }
  /** 録画の「準備中」を出す。文言は ja.ts が原本で、拡張は文言を持たない */
  | { type: 'clip-arming'; label: string }
  /** 「準備中」を消す。消えたのが描かれたら、同じ requestId で clip-armed-painted が返る */
  | { type: 'clip-armed'; requestId: string }
  /** 再生位置を聞く。immediate は描画を待たずに即答させる（録画用） */
  | { type: 'request-timecode'; requestId: string; immediate?: boolean }
  /** 視聴中のページに通知を出す。pending は続きの通知で書き換える予定（次が来るまで消さない） */
  /** id を付けると、ページに出せたときに同じ id で notice-shown が返る（browser-notice.ts の sendWatchingNotice） */
  | { type: 'notice'; level: 'info' | 'success' | 'warning' | 'error'; message: string; pending?: boolean; id?: string }
  /** コマ送りの fps・キャプチャキー・コマ送りの読み取り表示に出す文言 */
  | {
    type: 'settings'
    frameFps: number
    frameFpsAuto: boolean
    captureKey: string
    stepLabels: { blocked: string; dropped: string }
  }
