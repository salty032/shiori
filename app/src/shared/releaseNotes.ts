import type { Lang } from './types'
import { compareVersions } from './version'

// バージョンごとの「変更点お知らせ」文面。リリースのたびに手動で1エントリ追記する。
// キーは package.json の version と一致させること。
// エントリが無い（または空配列の）バージョンでは、お知らせモーダルの代わりに
// 従来通りの「Shiori を vX.X.X に更新しました」トーストにフォールバックする
// （version-notice.ts の decideVersionNotice を参照）。
//
// 日英の両方を必ず書くこと（表示言語で出し分ける）。**日英で項目数が違うと verify が落ちる**
// （releaseNotes.test.ts。片方だけ空配列にして英語側をトーストへ落とす書き方は通らない）。
// 書き方の指針：**利用者から見て何が変わったか**だけを書く。内部の用語（フレーム表・供給
// レート・オフセット等）は出さない。読む人はコードを知らないので、画面のどこがどう変わるかで
// 書けないなら、その項目は載せない方がよい。
// **保証できないことは書かない**のも同じ（「撮り逃しが 0 になった」と言い切らない。素材と
// 状況次第で出る）。
//
// **書く量は 1 版に数件、1 項目は 1〜2 文。** 利用者が気づく変更だけを書き、めったに起きない失敗のときの
// 直しは載せない。1.6.2 より前の版は長く書いていたのを、2026-11-20 にこの書き方へ揃えた。
//
// **書く範囲は「前に配った版から何が変わったか」。** 直前の作業で変えた分ではない。
// 1.2.0 では一度これを取り違えて、直前に触っていたコマ送りの話だけを並べていた。実際には
// 1.1.3 に録画もタイムシートも無く、コマ送りのキーまで変わっている。いちばん大きい変更が
// 1 行も無いお知らせになりかけた。**書く前に前回のタグとの差分を見ること。**
export const RELEASE_NOTES: Record<string, Record<Lang, string[]>> = {
  '1.9.3': {
    ja: [
      'インストール先に入っていたキャプチャや録画が、更新のときに消えてしまう不具合がありました。ご迷惑をおかけし、申し訳ありません。インストール先にキャプチャや録画があるときは、更新の前に止めて、移すよう案内するようにしました。',
    ],
    en: [
      'There was a bug where captures and recordings inside Shiori’s installation folder were deleted during updates. We apologize for the trouble. If captures or recordings are found in the installation folder, Shiori now stops before updating and asks you to move them.',
    ],
  },
  '1.9.2': {
    ja: [
      'キャプチャや録画の保存先を Shiori のインストール先にしていると、更新時にデータが削除されるおそれがあるため、保存先を変更するまで更新を止めるようにしました。',
    ],
    en: [
      'If captures or recordings are stored inside Shiori’s installation folder, updating could delete them. Updates are now stopped until you choose a different storage location.',
    ],
  },
  '1.9.1': {
    ja: [
      '画像を選ばずにエクスポートを始めたときは、保存先を選ぶ前に案内するようにしました。元ファイルを利用できず書き出せない画像がある場合は、その枚数も表示します。',
    ],
    en: [
      'If you start an export without selecting images, Shiori now prompts you before asking for a destination. It also shows how many images could not be exported when their source files are unavailable.',
    ],
  },
  '1.9.0': {
    ja: [
      'ビューアのコマ再生（1 コマ ○秒）で、コマごとの表示時間がそろい、もたつかなくなりました。',
      'ライブラリのエクスポートに、取り込んだ素材と手で打ったタイムシートも入るようになりました。撮った日付もそのまま移ります。',
      '「自動」で配信の大きさに縮めて保存する静止画で、細い線や小さい文字がにじみにくくなりました。',
      '30fps を超える録画には「精度保証外」と出すようにしました。撮り逃しや抜けが多すぎる録画は、ビューアと詳細パネルの両方で「要注意」と出します。',
      'スマートフォルダと、設定の「コマ送り」の fps の項目をなくしました。',
      '設定画面をウィンドウに合わせて広げました。ショートカット一覧には、静止画・録画のホットキーとトリミングのキーを載せました。',
    ],
    en: [
      'Frame playback in the viewer (one frame every N seconds) now shows each frame for the same length of time, without stutter.',
      'Library export now includes imported media and timesheets you entered by hand. The capture dates carry over as they are.',
      'Still images saved at the stream’s size with “Auto” now blur less on thin lines and small text.',
      'Recordings above 30fps are now marked “accuracy not guaranteed”. Recordings with too many missed or dropped frames are marked “unreliable” in both the viewer and the detail panel.',
      'Smart folders and the frame-stepping fps option in Settings have been removed.',
      'The Settings window now grows with the app window. The shortcut list now includes the still and recording hotkeys and the trimming keys.',
    ],
  },
  '1.8.0': {
    ja: [
      'この更新では、ブラウザの拡張機能ページで拡張をもう一度再読み込みしてください。次の更新からは、拡張は Shiori の更新に合わせて自動で入れ替わるので、再読み込みも配信のページの読み直しも要らなくなります。',
      '録画やキャプチャに失敗したときの知らせは、視聴中のブラウザに出し、ブラウザに出せなかったときだけ Shiori の画面に閉じるまで残すようにしました。これまでは両方に出ていました。',
      '同じ知らせが何枚も重なって出ないようにしました。',
    ],
    en: [
      'With this update, please reload the extension once more on your browser’s extensions page. From the next update on, the extension is replaced automatically when Shiori updates, so you will not need to reload it or the streaming page.',
      'When recording or capturing fails, the notice now appears in the browser you are watching in, and only when it cannot be shown there does it stay in the Shiori window until you close it. Previously it appeared in both places.',
      'The same notice no longer stacks up several times.',
    ],
  },
  '1.7.0': {
    ja: [
      '動画を編集する画面（これまでの「トリミング」）で、保存する動画から音声だけを外せるようになりました。タイムラインの左端のスピーカーのボタンを押してから保存してください。元の動画は残ります。',
      '動画を編集する画面で −1f / +1f を押したとき、再生位置の白い線が開始・終了の線と少しずれて止まり、時刻の表示も違う数字になっていました。',
      'ビューアで動画を拡大すると、操作バーの暗い帯が映像の途中に浮いて見えていました。',
      '100 件以上をまとめて削除するときは、確認が出るようになりました。',
      'タイムシートは 24 コマの録画でだけ開くようになりました。30fps の録画では、作画のコマと番号が対応しないためです。',
      'この更新ではブラウザ拡張も入れ替わります。ブラウザの拡張機能ページで拡張を再読み込みしてください。',
    ],
    en: [
      'In the video editing screen (formerly “Trim”), you can now remove just the audio from the video you save. Press the speaker button at the left end of the timeline before saving. The original video is kept.',
      'In the video editing screen, pressing −1f / +1f left the white playhead line slightly off the start and end lines, and the time display showed a different number.',
      'When zooming into a video in the viewer, the dark strip of the control bar appeared to float in the middle of the picture.',
      'Deleting 100 or more items at once now asks for confirmation.',
      'The timesheet now opens only for 24-frame recordings. In 30fps recordings, the numbers do not correspond to the drawn frames.',
      'This update also replaces the browser extension. Please reload it on your browser’s extensions page.',
    ],
  },
  '1.6.3': {
    ja: [
      'Netflix で一時停止したとき、広告や「ご覧になっている作品」が全面に重なって、止めたコマが見えないことがありました。',
      '録画やキャプチャの保存に失敗したとき、視聴中のブラウザにも通知が出るようになりました。',
      'この更新ではブラウザ拡張も入れ替わります。ブラウザの拡張機能ページで拡張を再読み込みしてください。',
    ],
    en: [
      'On Netflix, pausing could cover the whole screen with ads and the “You’re watching” panel, hiding the paused frame.',
      'When saving a recording or capture fails, a notification now also appears in the browser you are watching in.',
      'This update also replaces the browser extension. Please reload it on your browser’s extensions page.',
    ],
  },
  '1.6.2': {
    ja: [
      'Shiori を長く起動したままにしていると、撮れているコマを「撮り逃し」と数え、コマ送りで別の場面の絵が出ることがありました。この版で撮る録画から直ります。',
      '録画の完了通知が、止めた直後に出るようになりました。',
      'タイムシートで、撮り逃したコマは灰色になり、打てなくなりました。',
      'トリミングで −1f / +1f が撮り逃したコマで止まり、先へ動かせないことがありました。',
      'この更新ではブラウザ拡張も入れ替わります。ブラウザの拡張機能ページで拡張を再読み込みしてください。',
    ],
    en: [
      'After Shiori had been running for a long time, captured frames could be counted as “missed”, and frame stepping could show a picture from another moment. Fixed for recordings made with this version.',
      'The notification after recording now appears as soon as you stop.',
      'In the timesheet, missed frames are now gray and cannot be typed into.',
      'When trimming, −1f / +1f could get stuck at a missed frame.',
      'This update also replaces the browser extension. Please reload it on your browser’s extensions page.',
    ],
  },
  '1.6.1': {
    ja: [
      'YouTube などで途中のコマの知らせが抜けた録画でも、抜けた数がはっきりしていればタイムシートを使えるようになりました。',
      '59.94fps の録画で、抜けより後ろのコマ番号がずれていることがありました。',
      'この更新ではブラウザ拡張も入れ替わります。ブラウザの拡張機能ページで拡張を再読み込みしてください。',
    ],
    en: [
      'On YouTube and similar sites, recordings with a missed frame notice can now use the timesheet when the number of missing frames is certain.',
      'In 59.94 fps recordings, frame numbers after a gap could be off.',
      'This update also replaces the browser extension. Please reload it on your browser’s extensions page.',
    ],
  },
  '1.6.0': {
    ja: [
      'タイムシートが使えるようになりました。コマ送りしながら数字を打ち、東映デジタルタイムシートへ貼り付けられます。',
      '録画のコマ送りで、注記なしに隣のコマの絵が出ることがありました。この版で撮る録画から直ります。',
      'Shiori が使うメモリを減らしました。',
      'Prime Video で、作品名が正しく入らないことがありました。',
      'この更新ではブラウザ拡張も入れ替わります。ブラウザの拡張機能ページで拡張を再読み込みしてください。',
    ],
    en: [
      'The timesheet is now available. Type numbers while stepping through frames, then paste the sheet into Toei Digital Timesheet.',
      'Frame stepping in recordings could show the neighbouring frame’s picture without any warning. Fixed for recordings made with this version.',
      'Shiori now uses less memory.',
      'On Prime Video, the title was sometimes not saved correctly.',
      'This update also replaces the browser extension. Please reload it on your browser’s extensions page.',
    ],
  },
  '1.5.1': {
    ja: [
      '録画を止めると、最後のコマが 1〜2 枚消えていることがありました。',
      '録画の冒頭に「録画の準備中」の表示が写ることがありました。',
      '静止画のホットキーを押してから保存されるまでが速くなりました。',
      '動画ビューアで ↑↓ キーを押すと音量を変えられるようになりました。',
      'この更新ではブラウザ拡張も入れ替わります。ブラウザの拡張機能ページで拡張を再読み込みしてください。',
    ],
    en: [
      'Stopping a recording could lose the last one or two frames.',
      'The start of a recording could show “Getting ready to record”.',
      'Saving after the screenshot hotkey is faster.',
      'In the video viewer, the ↑/↓ keys now change the volume.',
      'This update also replaces the browser extension. Please reload it on your browser’s extensions page.',
    ],
  },
  '1.5.0': {
    ja: [
      '録画のコマ送りで、1 つ前に取り込んだ絵が出ることがありました。この版で撮る録画から直ります。',
      '撮り逃した区間があると、それより後ろのコマ番号がその分だけ小さく出ていました。',
      'ビューアでコマ番号を押すと、この録画に撮り逃し・抜け・ずれがあるか、あればどこからかが出るようになりました。',
      'この版に更新すると、打ち込み済みのタイムシートが一度だけ消えます。打った位置が 1 つ隣のコマを指している恐れがあったためです。',
      'この更新ではブラウザ拡張も入れ替わります。ブラウザの拡張機能ページで拡張を再読み込みしてください。',
    ],
    en: [
      'Frame stepping in a recording could show the picture captured one step earlier. Fixed for recordings made with this version.',
      'After a stretch of missed frames, every later frame number was too small by that amount.',
      'Clicking the frame number in the viewer now shows whether this recording has missed frames, gaps or misalignment, and where they start.',
      'Updating to this version clears typed-in timesheets once, because entries may have pointed one frame off.',
      'This update also replaces the browser extension. Please reload it on your browser’s extensions page.',
    ],
  },
  '1.4.0': {
    ja: [
      'キャプチャと録画の保存先を、C ドライブ以外にも変えられるようになりました（設定 > データ）。',
      '4K の画面で撮った画像が、必要以上に大きく保存されていました。細かさはそのままで、ファイルが小さくなります。',
      '保存先のドライブがつながっていないとき、撮る前に知らせるようになりました。',
      'タイムシートは、この版では開けません。打ち込み済みのものは残っています。',
      'この更新ではブラウザ拡張も入れ替わります。ブラウザの拡張機能ページで拡張を再読み込みしてください。',
    ],
    en: [
      'You can now store captures and recordings on a drive other than C (Settings > Data).',
      'Images captured on a 4K display were saved larger than needed. Files are now smaller with no detail lost.',
      'If the drive you save to is not connected, Shiori now tells you before capturing.',
      'Timesheets cannot be opened in this version. Ones you have already typed in are kept.',
      'This update also replaces the browser extension. Please reload it on your browser’s extensions page.',
    ],
  },
  '1.3.1': {
    ja: [
      '録画の先頭でのコマ落ちが減りました。',
      '「録画の準備中」の間に Alt+D を押すと、すぐに取りやめられるようになりました。',
      'トリミングで画質が落ちなくなり、進み具合が表示されるようになりました。',
      '数コマの撮り逃しがあるクリップでも、タイムシートを作れるようになりました。',
      '動画で M キーを押すと音を消せるようになりました。',
    ],
    en: [
      'Fewer frames are lost at the start of a recording.',
      'Pressing Alt+D while “Getting ready to record” is showing now cancels right away.',
      'Trimming no longer lowers picture quality, and it now shows its progress.',
      'Timesheets can now be built for clips with a few missed frames.',
      'Press M to mute or unmute a video.',
    ],
  },
  '1.3.0': {
    ja: [
      '録画したクリップを mp4 で書き出せるようになりました（設定 > データ）。',
      '録画の先頭でコマが欠けにくくなりました。記録は「録画の準備中」の表示が消えた時点で始まります。',
      'コマ送りの注記を作り直しました。絵が撮れていないコマは「未取得」、コマが届いていない所は「◯コマ抜け」、当てにならない録画は赤い「要注意」と出ます。',
      'ライブラリの守りを固くしました。作りを変える更新の前には、必ずバックアップを取ります。',
    ],
    en: [
      'Clips can now be exported as mp4 (Settings > Data).',
      'Fewer frames are lost at the start of a recording. Recording begins the moment “Preparing to record” disappears.',
      'Frame-stepping annotations have been rebuilt: “not captured” for a frame without its own picture, “N frames missing” where frames never arrived, and a red “unreliable” for a clip that cannot be trusted.',
      'Your library is better protected. Shiori always makes a backup before an update that changes its structure.',
    ],
  },
  '1.2.0': {
    ja: [
      '動画クリップを録画できるようになりました。再生中に Alt+D を押すと、最長 30 秒のクリップを録画できます。手元の .webm / .mp4 も取り込めます。',
      'コマ送りのキーを「,」と「.」に変えました。ブラウザとアプリで同じキーを使います。',
      'クリップを元の動画のコマ単位で送れるようになりました。映像の左下に「コマ 128 / 719」のように出ます。',
      'タイムシートを作れるようになりました。東映デジタルタイムシートへ貼り付けられます。',
      'クリップをビューアで拡大できるようになりました。',
      '半角カナと全角英数字を区別せずに検索できるようになりました。',
      '1 日 1 回、過去 7 日分のライブラリのバックアップを取るようになりました。',
    ],
    en: [
      'You can now record video clips. Press Alt+D while a player is playing to capture up to 30 seconds. You can also drop in your own .webm / .mp4 files.',
      'Frame stepping has moved to the “,” and “.” keys, the same in the browser and in Shiori.',
      'Frame stepping in clips now moves one source frame at a time, shown at the bottom left as “Frame 128 / 719”.',
      'You can now build a timesheet and paste it into Toei Digital Timesheet.',
      'Clips can now be zoomed in the viewer.',
      'Search now ignores half-width katakana and full-width alphanumeric differences.',
      'Shiori now keeps a daily backup of your library (7 days).',
    ],
  },
  // 1.1.2 は不具合の原因を突き止めるための記録を仕込んだだけで、画面は何も変わっていない。
  // エントリを置かない＝従来のトーストに落ちる（version-notice.ts）。
  '1.1.3': {
    ja: [
      'アプリが新しくなったことが分かるようになりました。更新後の最初の起動で一度だけお知らせが出ます。今のバージョンは 設定 > データ でも読めます。',
    ],
    en: [
      'You can now tell when the app has been updated. A notice appears once, the first time you start a new version. The version you are on is also shown under Settings > Data.',
    ],
  },
  '1.1.1': {
    ja: [
      'Firefox（128 以降）でもブラウザ拡張が使えるようになりました。',
      'サムネイルを掴んで、エクスプローラーや他のアプリへそのまま渡せるようになりました。',
      '真っ黒な画像が保存され続けているとき、その場で知らせるようになりました。',
      '設定 > 基本 > 拡張機能 に、拡張から情報が届いているかが出るようになりました。',
      'ログイン時の自動起動で、ウィンドウが開いてしまうことがありました。',
    ],
    en: [
      'The browser extension now works in Firefox (128 or later).',
      'You can now drag thumbnails straight out of Shiori into Explorer or another app.',
      'Shiori now tells you on the spot when it keeps saving black pictures.',
      'Settings > General > Extension now shows whether the extension is getting through.',
      'Launching at login could open a window instead of waiting in the tray.',
    ],
  },
  '1.1.0': {
    ja: [
      '画面の配色を、ライト／ダーク／システムに合わせる から選べるようになりました（設定 > 基本）。',
      '新しいバージョンを裏で受け取り、再起動するだけで更新できるようになりました。',
      'ブラウザ拡張がつながらないとき、その理由が画面に出るようになりました。',
    ],
    en: [
      'You can now choose the colour theme: light, dark, or follow the system (Settings > General).',
      'New versions are downloaded in the background and applied with a single restart.',
      'When the browser extension cannot connect, the screen now says why.',
    ],
  },
  '1.0.3': {
    ja: [
      'サイドバーのタグが、撮るたびに入れ替わって消えることがなくなりました。5 枚以上に付いているタグを出します。',
    ],
    en: [
      'Tags no longer drop out of the sidebar every time you capture. Tags on at least 5 images are shown.',
    ],
  },
  '1.0.2': {
    ja: [
      'キャプチャが速くなりました。キーを押してから保存されるまでが、およそ 0.9 秒から 0.3〜0.4 秒になります。撮れる絵はこれまでと同じです。',
      '削除した直後のクリックで、意図していないビューアが開くことがあったのを直しました。',
    ],
    en: [
      'Capturing is faster — about 0.3-0.4 seconds from the key press to the saved shot, down from around 0.9. The picture you get is unchanged.',
      'Fixed a click right after a delete unexpectedly opening the viewer.',
    ],
  },
  '1.0.1': {
    ja: [
      'タスクトレイのアイコンを左クリックすると、ウィンドウが開くようになりました。これまでは右クリックとダブルクリックしか効きませんでした。',
      'タスクトレイのアイコンがぼやけていたのを直しました。',
      'ビューアで拡大した画像が、右の詳細パネルにはみ出していたのを直しました。',
    ],
    en: [
      'Left-clicking the tray icon now opens the window. Only right-click and double-click used to do anything.',
      'Fixed the tray icon looking blurry.',
      'Fixed a zoomed image in the viewer spilling over into the detail panel on the right.',
    ],
  },
}

// 表示言語に対応する変更点配列を返す。未定義バージョン・未翻訳言語は undefined。
export function releaseNotesFor(version: string, lang: Lang): string[] | undefined {
  return RELEASE_NOTES[version]?.[lang]
}

export type ReleaseNoteEntry = { version: string; notes: string[] }

// 収録されている全バージョンを新しい順に返す（設定 > 情報 の「変更点を見る」用）。
// **オブジェクトのキー順に頼らない。** 数字だけのキーではないので挿入順で並ぶが、
// 追記位置を間違えれば黙って並びが崩れる（画面には「古い版が上」としか出ない）。
// 版番号そのもので並べ替える。
// その言語の文面が無い版は飛ばす——空の見出しだけが並ぶと、「変更が無かった版」と
// 「まだ訳していない版」の区別が付かない。
export function allReleaseNotes(lang: Lang): ReleaseNoteEntry[] {
  return Object.entries(RELEASE_NOTES)
    .map(([version, byLang]) => ({ version, notes: byLang[lang] ?? [] }))
    .filter((e) => e.notes.length > 0)
    .sort((a, b) => compareVersions(b.version, a.version))
}

