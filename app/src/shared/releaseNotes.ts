import type { Lang } from './types'

// バージョンごとの「変更点お知らせ」文面。リリースのたびに手動で1エントリ追記する。
// キーは package.json の version と一致させること。
// エントリが無い（または空配列の）バージョンでは、お知らせモーダルの代わりに
// 従来通りの「Shiori を vX.X.X に更新しました」トーストにフォールバックする
// （version-notice.ts の decideVersionNotice を参照）。
//
// 日英の両方を必ず書くこと（表示言語で出し分ける）。まだ英語文面が無い項目は
// 英語ユーザーにお知らせモーダルを出さないため、そのバージョンの en を空配列にしておく
// と、英語側だけ従来トーストにフォールバックする。
// 書き方の指針：**利用者から見て何が変わったか**だけを書く。内部の用語（フレーム表・供給
// レート・オフセット等）は出さない。読む人はコードを知らないので、画面のどこがどう変わるかで
// 書けないなら、その項目は載せない方がよい。
// **保証できないことは書かない**のも同じ（「撮り逃しが 0 になった」と言い切らない。素材と
// 状況次第で出る）。
//
// **書く範囲は「前に配った版から何が変わったか」。** 直前の作業で変えた分ではない。
// 1.2.0 では一度これを取り違えて、直前に触っていたコマ送りの話だけを並べていた。実際には
// 1.1.3 に録画もタイムシートも無く、コマ送りのキーまで変わっている。いちばん大きい変更が
// 1 行も無いお知らせになりかけた。**書く前に前回のタグとの差分を見ること。**
export const RELEASE_NOTES: Record<string, Record<Lang, string[]>> = {
  '1.4.0': {
    ja: [
      'キャプチャと録画の保存先を変えられるようになりました。設定 > データ > 保存場所 の「変更...」から、C ドライブ以外のドライブも選べます。これまでに撮ったぶんも一緒に新しい場所へ移ります——移す前に「何件・何 GB を、どこへ」が出て、移している間は進み具合が出て、途中で止められます。止めたときも失敗したときも、何も変わりません（保存先も、これまでのファイルもそのままです）。移動先に同じ名前のファイルがあるときは、上書きせずに中止して、その名前を画面に出します。',
      '4K の画面で 1080p の配信を見ていると、絵が実際より 4 倍の大きさで保存されていました。増えていたぶんはブラウザが引き伸ばした水増しで、細かさは増えていません。設定 > データ > 保存する解像度 が「自動」（既定）になり、配信より大きくは保存しなくなります。細かさは 1 ドットも減らずに、ファイルだけ小さくなります。容量を優先するなら 1080p / 720p、これまでどおりに戻すなら「上限なし」を選べます（効くのは画像だけで、録画は変わりません）。',
      '保存先のドライブがつながっていないときに、撮る前・録り始める前に画面へ出るようになりました。これまでは「キャプチャに失敗しました」とだけ出て原因が読めず、録画では 30 秒撮り終えてからそれが分かりました。',
      'タイムシートは、この版では開けません。数コマの抜けがあるだけで表そのものが出せない状態を直したところで、打ち込んでもらったものが後から使えなくなるのを避けるため、確かめが済むまで止めています。打ち込み済みのタイムシートは消えずに残っています。',
      'この更新ではブラウザ拡張も新しくなります。アプリを起動すると入れ替わり、通知が出ます。ブラウザの拡張機能ページで拡張を再読み込みするまでは、「保存する解像度」の自動は効きません。',
    ],
    en: [
      'You can now change where captures and recordings are stored. Settings > Data > Storage location > “Change...” lets you pick a folder on another drive. What you have already captured moves with it — before anything is copied you are shown how many files, how much space, and where they are going; progress is shown while it runs, and you can stop it. If you stop it, or it fails, nothing changes at all (the location and your existing files stay as they were). If a file of the same name is already in the destination, Shiori stops instead of overwriting it and shows you the name.',
      'On a 4K display, a 1080p stream was being saved four times larger than it really is. The extra pixels were upscaling done by the browser, not extra detail. Settings > Data > Saved resolution is now “Auto” by default, so nothing is saved larger than the stream itself — not a single dot of real detail is lost, only the file gets smaller. Choose 1080p or 720p if you want to save more space, or “No limit” for the old behaviour (this affects images only; recordings are unchanged).',
      'If the drive you save to is not connected, Shiori now tells you before capturing and before recording starts. It used to just say “Capture failed”, with no way to tell why — and with recording you only found out after the full 30 seconds.',
      'Timesheets cannot be opened in this version. Having just fixed the case where a few missing frames hid the sheet entirely, we are holding the feature until that is confirmed, rather than risk you typing in a sheet that later turns out to be unusable. Timesheets you have already typed in are still there.',
      'This update also brings a new browser extension. It is swapped in when the app starts and you get a notification. Until you reload the extension on your browser’s extensions page, “Saved resolution: Auto” has no effect.',
    ],
  },
  '1.3.1': {
    ja: [
      '録画の先頭でのコマ落ちが減りました。これまでは画面の取り込みを立ち上げながら「落ち着くのを待つ」形だったため、待っても立ち上がりの荒れが録画の頭に入っていました。取り込みを先に立ち上げてから待つようにしています（「録画の準備中」の表示はその分だけ長くなります）。また、この表示が出ている間に Alt+D を押すとすぐに取りやめられます。これまでは数秒待たされた上で、止めたはずなのに録画が始まることがありました。',
      '録画で取り込む枚数が、お使いの画面のリフレッシュレートに合わさるようになりました。これまでは 1 秒あたり 60 枚で頭打ちで、120Hz などの画面でもそこが天井になっていました。',
      'トリミングの進み具合がパーセントで表示されるようになりました。書き出しが 100% になったあとも、コマの対応を引き継ぐために数秒かかります。その間は「仕上げています...」と表示されます。',
      'トリミングしても画質が落ちなくなりました。これまでは切り出すときの画質が一律で、録画時より低い値になっていたため、細かく見たい箇所ほど画質が落ちていました。元のクリップが実際に使っている量に合わせます。切り出した動画のコマ送りも軽くなりました（その分、ファイルサイズは大きくなります）。',
      'トリミングに失敗したとき、画面に理由が読める形で出るようになりました（以前は「エラー：invalid_out」のような表示でした）。また、選んだ範囲の外から再生が始まらなくなり、Space・I / O のキーがボタンを一度押したあとでも効くようになりました。',
      'タイムシートが、数コマの撮り逃しがあるクリップでも作れるようになりました。これまでは 1 コマでも撮り逃しがあると表そのものが出ませんでした。表の見出しには「撮り逃し 12 コマ」のように数が出ます。そのコマは直前のコマの絵が出ているだけで、コマ番号はずれていませんが、そこで新しい絵が始まっていても画面からは分かりません。コマ番号そのものがずれる録画（抜けや対応の崩れがあるもの）は、これまでどおり表を出しません。',
      '動画で M キーを押すと音を消せるようになりました。また、トリミング画面を開いている間に、裏で再生されていた映像の音が重なって鳴り続けることがなくなりました。',
      'シークバーを掴んで動かしたときと、コマ送りの反応が軽くなりました。',
    ],
    en: [
      'Fewer frames are lost at the start of a recording. Shiori used to start the screen capture and wait for things to settle at the same time, so the rough patch at start-up ended up in the recording anyway. The capture is now brought up first, and only then does the wait begin (“Getting ready to record” stays up a little longer as a result). You can also press Alt+D while that message is showing to cancel right away — it used to take several seconds, and recording could start even though you had stopped it.',
      'Recording now captures at your display’s refresh rate. It used to be capped at 60 frames per second, which was the ceiling even on a 120Hz display.',
      'Trimming now shows progress as a percentage. After the export reaches 100%, it still takes a few seconds to carry the frame mapping across; “Finishing up...” is shown while that happens.',
      'Trimming no longer costs you picture quality. The bitrate used when cutting was fixed and lower than the one used while recording, so the part you most wanted to look at closely was the part that lost the most quality. It now follows what the original clip actually uses. Frame stepping in trimmed clips is faster too (files are correspondingly larger).',
      'When trimming fails, the screen now says why instead of showing an internal code (it used to read “Error: invalid_out”). Playback also no longer starts from outside the selected range, and Space, I and O keep working after you have clicked a button.',
      'Timesheets can now be built for clips with a few missed frames. A single missed frame used to hide the sheet entirely. The header shows the count, e.g. “12 frames missed”. Those frames show the previous frame’s picture — the frame numbers are still correct, but a new drawing starting on one of them is invisible on screen. Clips whose frame numbers themselves drift (gaps, or broken alignment) still do not offer a sheet.',
      'Press M to mute or unmute a video. Video playing behind the trimming screen no longer keeps sounding over it.',
      'Dragging the seek bar and stepping through frames both respond faster.',
    ],
  },
  '1.3.0': {
    ja: [
      '録画したクリップを mp4 で書き出せるようになりました。設定 > データ > 動画の変換 で「mp4」を選ぶと、書き出すときに H.264 へ変換します（既定はこれまでどおり webm です）。画質はわずかに落ちますが、コマの位置と枚数は変わりません。効くのは選んだクリップの書き出しだけで、ライブラリはそのままです。変換できなかったクリップは元の形式のまま書き出し、その本数を画面に表示します。',
      '録画の先頭でコマが欠けにくくなりました。Alt+D を押したあと、記録は準備が整ってから始まります。待っている間は映像の中央に「録画の準備中」と表示され、この表示が消えた時点が記録の開始です（待つのは最長 2 秒です）。',
      'コマ送りの注記を作り直しました。絵が撮れていないコマは「未取得」、コマ自体が届いていない箇所は「8 コマ抜け」、録画全体としてコマ送りが当てにならないものはコマ番号ごと赤で「要注意」と表示されます。それぞれの意味は、コマ番号を押すと一覧で読めます。',
      '以前のバージョンでコマ単位の送りを諦め、黄色い「フレーム 128 / 719」と表示されていたクリップが、素材のコマ単位に戻ることがあります。起動してしばらくすると自動で見直します。',
      'データの保護を強めました。新しいバージョンで更新したライブラリを古いバージョンで開こうとした場合は、書き換えずに停止します。ライブラリの構造を変える更新の前には必ずバックアップを取り、取れなかったときは何も変更せず中止します。また、設定ファイルを読み込めなかった起動では、設定の変更をファイルへ書き込まなくなりました（これまでは初期設定で上書きされていました）。',
    ],
    en: [
      'Clips can now be exported as mp4. Choose “mp4” under Settings > Data > Video conversion and Shiori converts to H.264 on export (webm stays the default). The picture loses a little quality, but frame positions and the frame count stay the same. Only the export is converted — your library is left as it is. Clips that could not be converted are exported in their original format, and the number is shown on screen.',
      'Fewer frames are lost at the start of a recording. After Alt+D, recording now waits until capture has settled. While it waits, “Preparing to record” appears in the middle of the video, and recording begins the moment it disappears (the wait is at most 2 seconds).',
      'Frame-stepping annotations have been rebuilt. A frame whose picture was not captured is marked “not captured”, a point where the frames themselves never arrived is marked “8 frames missing”, and a clip whose frame stepping cannot be trusted turns the frame number red and reads “unreliable”. Press the frame number to read what each one means.',
      'Clips that earlier versions gave up on — showing a yellow “Frame 128 / 719” instead of source frames — may go back to stepping one source frame at a time. Shiori re-checks them shortly after startup.',
      'Your data is better protected. A library that a newer version of Shiori has updated will not be opened or rewritten by an older one. A backup is now required before any update that changes the library structure — if it cannot be made, the update is cancelled and nothing is changed. And when the settings file cannot be read at startup, changes are no longer written to it (they used to overwrite it with the defaults).',
    ],
  },
  '1.2.0': {
    ja: [
      '動画クリップを録画できるようになりました。動画の再生中に Alt+D を押すと、最長30秒のクリップを録画できます。録画したクリップはアプリ内で再生・トリミングできるほか、手元にある .webm / .mp4 ファイルをドロップして取り込むこともできます。',
      'コマ送りに使うキーを「,」と「.」に変更しました。これまでの Shift+←/→ では操作できません。ブラウザのプレーヤーと、アプリのビューア・トリミング画面で共通のキーを使用できます。',
      'クリップを、元の動画のコマ単位で送れるようになりました。映像の左下には、現在の位置が「コマ 128 / 719」のように表示されます。',
      '個別に取り込めなかったコマは「未取得」、素材のコマとの対応を保証できない録画は「要注意」と表示されます。コマ送りの精度を保証できない場所や録画を、その場で確認できます。',
      'コマ単位の精度を保証できる素材は、24 / 29.97 / 30fps です。60fps の素材も録画できますが、取り込めなかったコマや精度を保証できない録画には「未取得」または「要注意」と表示されます。',
      'タイムシートを作成できるようになりました。コマ送りをしながら数字を入力して表を作成し、その内容をコピーして東映デジタルタイムシートへ直接貼り付けられます。',
      'クリップをビューアで拡大できるようになりました（+ / − / ホイール）。録画した映像の画質を細部まで確認できます。',
      '画面の配色、角の丸み、余白を見直しました。ライトテーマとダークテーマで色のルールを統一し、選択中のサムネイルを判別しやすくしました。全画面表示でサムネイルが小さくなりすぎる問題も修正しています。',
      '半角カナと全角英数字を区別せずに検索できるようになりました。たとえば「ドキドキ」と入力すると、「ﾄﾞｷﾄﾞｷ」を含むタイトルも見つかります。複数のキーワードは、入力する順序にかかわらず絞り込みに使用できます。',
      'Bilibili で、作品名に宣伝文句が混ざる問題、話を切り替えた直後に前の話の名前が入る問題、プレーヤーの操作パネルが映り込む問題を修正しました。また、DMM TV でコマ送りのキーを押すと再生速度が変わる問題も修正しています。',
      '記録したタグ、メモ、タイムシートをより安全に保管できるようになりました。起動時にデータが壊れていないかを確認し、1日1回、過去7日分のバックアップを保存します。設定を保存できなかった場合にも、保存済みと表示されていた問題を修正しました。',
      'ブラウザ拡張とアプリの接続が切れた場合に、対処方法を画面に表示するようになりました。',
      '変更点のお知らせを、あとからいつでも読み返せるようになりました。また、GitHub アカウントがなくても不具合や要望を報告できます。',
      '詳細パネルに、記録した解像度を表示するようになりました。他の人から受け取った素材は、自分でキャプチャした素材と取得日順で混在しないよう、分けて表示されます。',
    ],
    en: [
      'You can now record video clips. Press Alt+D while a player is playing to capture a clip of up to 30 seconds. Clips play and trim inside Shiori, and you can also drop your own .webm / .mp4 files in.',
      'Frame stepping has moved to the “,” and “.” keys. Shift+←/→ no longer works. The same keys are used in the browser player and in Shiori’s viewer and trimmer.',
      'Frame stepping in clips now moves one real source frame at a time. The current position is shown at the bottom left of the video as “Frame 128 / 719”.',
      'Frames that could not be captured are marked “not captured”, and clips whose source-frame alignment cannot be guaranteed are marked “unreliable”. This makes accuracy limitations visible while you step through a clip.',
      'Frame accuracy is guaranteed for 24 / 29.97 / 30fps sources. 60fps sources still record, but missing frames or clips whose accuracy cannot be guaranteed are marked “not captured” or “unreliable”.',
      'You can now build a timesheet. Type numbers while stepping through frames, then copy the sheet and paste it straight into Toei Digital Timesheet.',
      'Clips can now be zoomed in the viewer (+ / − / wheel), so you can check the recorded quality by eye.',
      'Colours, corner rounding and spacing have been rebuilt. Light and dark themes now follow the same rules, the selected thumbnail is easy to pick out, and thumbnails no longer shrink too small to read in full screen.',
      'Search now ignores half-width katakana and full-width alphanumeric differences, so typing “ドキドキ” also finds titles written as “ﾄﾞｷﾄﾞｷ”. Words can also be typed in any order.',
      'Fixed Bilibili picking up promotional text in the title, keeping the previous episode’s title right after you switch episodes, and leaving the player controls in the picture — and DMM TV changing playback speed when you press the frame-step keys.',
      'Your tags, notes and timesheets are better protected. Shiori checks the library for damage at startup and keeps a daily backup (7 days). Settings that failed to save no longer look as though they saved.',
      'When the browser extension loses its connection to Shiori, the screen now tells you what to do.',
      'Release notes can now be reopened at any time, and reporting a bug or request no longer needs a GitHub account.',
      'The detail panel now shows the resolution the clip was recorded at. Material shared from someone else is kept separate from your own captures instead of mixing in by date.',
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
      'Firefox（128 以降）でもブラウザ拡張が使えるようになりました。設定 > 基本 > 拡張機能 の「拡張機能フォルダを開く」で出たフォルダを、Firefox の about:debugging から読み込みます。Firefox では一時的な読み込みになるため、ブラウザを閉じると外れます。',
      'サムネイルを掴んで、エクスプローラーや他のアプリへそのまま渡せるようになりました。複数選んだままでも掴めます。',
      '映像が真っ黒のまま保存され続けることを、その場で知らせるようになりました。ブラウザのハードウェアアクセラレーションが有効だと、撮れているように見えて中身が黒いままになります。これまでは「保存しました」と出るだけで、黒い画像が溜まってから気づくことになっていました。',
      '設定 > 基本 > 拡張機能 に、拡張から情報が届いているか（「受信中」／「未受信」）が出るようになりました。拡張が新しくなったときは「再読み込みが必要」と出ます。',
      '取り込み・書き出し・AI タグ付けの途中でアプリの更新を当てようとすると、確認が出るようになりました。これまでは黙って終了し、作業が中断していました。',
      'ログイン時の自動起動でウィンドウが開いてしまうのを直しました。トレイに常駐して待ちます。設定の側で「オフ」に見えていたのも直っています。',
      'サムネイルが出ない画像を、設定 > データ の「サムネイルを修復...」で作り直せるようになりました。',
    ],
    en: [
      'The browser extension now works in Firefox (128 or later). Open Settings > General > Extension > “Open extension folder”, then load that folder from about:debugging in Firefox. Firefox loads it temporarily, so it is removed when you close the browser.',
      'You can now drag thumbnails straight out of Shiori into Explorer or another app. A multiple selection can be dragged as it is.',
      'Shiori now tells you, on the spot, when what it saved is a black picture. With hardware acceleration left on in the browser, captures look like they worked but come out black. It used to just say “Saved”, so you only found out once a pile of black images had built up.',
      'Settings > General > Extension now shows whether the extension is getting through (“Receiving” / “Not receiving”), and says “Reload required” when the extension has been updated.',
      'If you apply an app update while an import, an export or AI tagging is running, Shiori now asks first. It used to quit silently and cut the work short.',
      'Fixed launching at login opening a window instead of waiting quietly in the tray — and the setting looking as though it were off.',
      'Images with a missing thumbnail can be rebuilt from “Repair thumbnails...” under Settings > Data.',
    ],
  },
  '1.1.0': {
    ja: [
      '画面の配色を、ライト／ダーク／システムに合わせる から選べるようになりました（設定 > 基本）。「システムに合わせる」は OS の設定が変わったその場で切り替わります。',
      '新しいバージョンを裏で受け取り、ボタン一つで再起動して当てられるようになりました。配布ページから手で入れ直す必要がなくなります。',
      'YouTube Shorts を撮れるようになりました。縦長の絵はサムネイルで切れずに全体が出ます。タイトル末尾の「#shorts」も取り除きます。',
      'ブラウザ拡張がつながらないとき、その理由（通信に使う番号が他のアプリと重なっている）が画面に出るようになりました。これまでは黙ってつながらないままでした。',
      '他の人から受け取った素材の取り込みが、中に 1 件おかしなものがあるだけで丸ごと失敗するのを直しました。',
    ],
    en: [
      'You can now choose the colour theme — light, dark, or follow the system (Settings > General). “Follow the system” switches the moment the OS setting changes.',
      'New versions are now downloaded in the background and applied with a single restart, instead of downloading the installer from the releases page by hand.',
      'YouTube Shorts can now be captured. Vertical pictures are shown whole in the thumbnail instead of being cropped, and the trailing “#shorts” is stripped from the title.',
      'When the browser extension cannot connect, the screen now says why (the number Shiori uses to talk to it is taken by another app). It used to just stay disconnected in silence.',
      'Fixed an import of material received from someone else failing entirely because of a single bad entry inside it.',
    ],
  },
  '1.0.3': {
    ja: [
      'サイドバーのタグが勝手に消えなくなりました。これまでは数の多い順に 24 件だけを出していたため、1 枚撮るたびに順位が入れ替わり、さっきまであったタグが押せなくなっていました。5 枚以上に付いているタグを出す形にしたので、撮って増えるぶんでタグが押し出されることはありません。',
    ],
    en: [
      'Tags no longer disappear from the sidebar on their own. It used to show the top 24 by count, so every capture reshuffled the ranking and a tag you had just been using could drop out of reach. It now shows tags that are on at least 5 images, so capturing more can never push a tag out.',
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
    .sort((a, b) => compareVersionDesc(a.version, b.version))
}

function compareVersionDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
