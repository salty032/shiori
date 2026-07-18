# コードレビュー 2026-07-07 — 動画関連機能（録画クリップ・トリミング・再生）

対象: main ブランチ（60b102c 時点）の動画関連コード一式。

- main: `app/src/main/video/`（recording / recorder-ipc / recorder-window / clip-hotkey / ipc-video / ffmpeg）、`video-thumb-provider.ts`、`bootstrap.ts` の capfile プロトコル
- renderer: `app/src/renderer/recorder.ts`（レコーダーウィンドウ）、`app/src/renderer/src/video/`（VideoTrimmer ほか）、`components/VideoPlayer.tsx`、Viewer / DetailPanel の動画表示

修正は本書に基づき別担当（別モデル）が行う前提で、各項目に「現状 → 問題 → 修正方針」を記載する。

優先度の目安:
- **P1** … 状態固着・データ消失につながる。最優先で対応
- **P2** … 実際に踏み得る不具合・明確な未完成部分
- **P3** … 品質・保守性・UX の改善。ついで対応で良い

---

## A. 録画（開始・停止・保存）

### V-1 (P1) 録画開始直後に停止すると録画状態が永久に固着する

- **対象**: [recorder.ts:72-75](app/src/renderer/recorder.ts#L72-L75), [recorder.ts:84-88](app/src/renderer/recorder.ts#L84-L88), [recorder.ts:119-123](app/src/renderer/recorder.ts#L119-L123), [recorder.ts:240-248](app/src/renderer/recorder.ts#L240-L248), [recording.ts:100-156](app/src/main/video/recording.ts#L100-L156)
- **現状**: main は `recorder:start` 送信時点で `isRecording = true` にし、`pre-capture`（プレーヤー UI 非表示）も送る。レコーダー renderer 側は `getUserMedia` → `getCrop` → `video.play()` を await しながら進み、途中で `recorder:stop` が来ると `recordingToken` をインクリメントして各 await 後の token チェックで**黙って** return する。`onStop` 側も `recorder` が未生成（`null` / `inactive`）なら cleanup するだけで main に何も送らない。
- **問題**: `MediaRecorder.start()` に到達する前（数百 ms〜1 秒の窓）に停止が届くと、`recorder:done` も `recorder:error` も main に届かない。main の `finishRecordingState()` を呼ぶ経路が存在しないため:
  - `isRecording` が true のまま固着（トレイは録画中表示のまま）
  - `post-capture` が送られず、**ブラウザのプレーヤー UI が非表示のまま**になる
  - `addPreCaptureGuard` によりスクリーンショットも以後すべて中止される
  - 以降ホットキーを押しても `stopRecording()`（renderer 側で no-op）にしかならず、レコーダーのクラッシュか再起動まで復帰不能
  ホットキー連打（Alt+R 2度押し）で普通に再現し得る。
- **修正方針**: 二段構えを推奨。
  1. renderer 側: token 不一致で中断する全経路と、`onStop` で `recorder` が未生成だった経路で `reportError('aborted')`（または専用の `recorder:aborted`）を送る。main の `recorder:error` ハンドラは `aborted` を「通知なしで `finishRecordingState()` だけ行う」扱いにする。
  2. main 側の保険: `recorder:start` 送信後にウォッチドッグ（例: `maxSeconds + 30s`）を張り、`done`/`error` がどちらも来なければ `finishRecordingState()` + エラー通知。これは renderer が**ハング**した場合（`render-process-gone` では拾えない）もカバーする。現状クラッシュ検知（[recorder-window.ts:61-64](app/src/main/video/recorder-window.ts#L61-L64)）しかない。

### V-2 (P2) `recorder:done` で `ensureCaptureSubDir` が try の外にあり、失敗すると通知なしでクリップ消失

- **対象**: [recorder-ipc.ts:67-70](app/src/main/video/recorder-ipc.ts#L67-L70)
- **現状**: `const dir = await ensureCaptureSubDir(capturedAt)` が try/catch ブロック（71行目以降）の外にある。
- **問題**: ディレクトリ作成が失敗（ディスクフル・権限等）すると async ハンドラ内の未捕捉例外になり、エラートーストも出ず、受け取った webm バッファはそのまま破棄される。直後の try 内の `writeCaptureFile` 失敗とは扱いが非対称。
- **修正方針**: `ensureCaptureSubDir` を try の中へ移動する（`finishRecordingState()` は既に呼ばれているので状態面の追加処置は不要）。

### V-3 (P2) レコーダー renderer の `cleanup()` がモジュール変数を触るため、旧セッションの onstop が新セッションのタイマー・描画ループを殺す

- **対象**: [recorder.ts:29-41](app/src/renderer/recorder.ts#L29-L41), [recorder.ts:193-199](app/src/renderer/recorder.ts#L193-L199)
- **現状**: 「エラー後に次の録画が滑り込むレース」はコメント（175-177行）で意識されており、chunks・stream・開始時刻はクロージャ束縛になっている。しかし `cleanup()` は引数の stream 停止に加えて**モジュール変数**の `frameTimer` / `stopTimer` / `rVfcRunning` をクリアする。
- **問題**: 旧セッションが `onerror` → `rec.stop()` し、`onstop` が非同期で発火するまでの間に新セッションが開始していると、旧 `onstop` の `cleanup()` が新セッションの `stopTimer`（maxSeconds 自動停止）と `rVfcRunning`（canvas への描画ループ）を無効化する。結果、新しい録画は**フレームが更新されないまま自動停止もしない**状態になり得る。守ったつもりのレースが半分残っている。
- **修正方針**: `frameTimer` / `stopTimer` / `rVfcRunning` もセッションローカル（クロージャ or セッションオブジェクト）に移し、`cleanup()` は自セッションの資源だけを解放する。モジュール変数として残すのは「現在のセッション」参照（`recorder` 等）のみにする。

### V-4 (P2) 拡張が応答しないとき、古いターゲット・古いメタデータのまま録画が始まる

- **対象**: [recording.ts:105-115](app/src/main/video/recording.ts#L105-L115), [recording.ts:131-136](app/src/main/video/recording.ts#L131-L136)
- **現状**: `requestRecordingTarget()` が 700ms でタイムアウトして null を返しても、以前のタイムコード受信で `videoRect` / `browserWindow` が残っていれば `canCaptureVideo()` を通過し、`recordingMeta` も `getLastTimecode()`（無期限に古い値）から取る。
- **問題**: 拡張が切断済み・タブを閉じた後などに、（a）録画自体は昔のウィンドウ位置の矩形で始まり無関係な画面領域が撮れる、（b）保存されるクリップに**別のエピソードのタイトル・タイムコード・URL** が付く。スクリーンショット側はメタデータに 1500ms の鮮度チェック（[bootstrap.ts:72](app/src/main/bootstrap.ts#L72)）があるのに、録画側には一切ない。
- **修正方針**: `target === null`（タイムアウト）の場合は、`setLastTimecode` の最終更新時刻を見て一定時間（スクショと同じ 1.5s 程度、少なくとも数秒）より古ければ録画を中止して「動画を検出できませんでした」通知に倒す。メタデータのみ古い場合は `recordingMeta` を null にして保存だけ続ける選択肢もあるが、rect も同じ鮮度なので中止のほうが安全。

### V-5 (P2) 音声キャプチャ失敗で録画全体が失敗する（音声なしフォールバックがない）

- **対象**: [recorder.ts:53-71](app/src/renderer/recorder.ts#L53-L71)
- **現状**: `getUserMedia` を audio（desktop ループバック）+ video 同時に要求し、失敗したら `getUserMedia_failed` で終了する。
- **問題**: Windows のループバック音声はオーディオデバイス構成によって失敗することがあり、その場合**映像すら録れない**。また現状のエラーメッセージ分岐（[recorder-ipc.ts:38-39](app/src/main/video/recorder-ipc.ts#L38-L39)）は `NotAllowedError` のみ特別扱いで、音声起因かどうかは判別できない。
- **修正方針**: audio+video で失敗したら video のみで一度リトライし、成功したら「音声なしで録画しています」を warning 通知する。それでも失敗した場合のみエラーで終了。

### V-6 (P2) `clipMaxSeconds`（最長録画時間）に設定 UI がない

- **対象**: [settings.ts:81](app/src/main/settings.ts#L81), [ClipHotkeySettings.tsx](app/src/renderer/src/video/ClipHotkeySettings.tsx)
- **現状**: main 側は 5〜300 秒で検証・デフォルト 60 秒だが、設定モーダルにはホットキーと完了通知トグルしかなく、変更手段は settings.json の手編集のみ。
- **問題**: 機能としては存在するのに UI から到達できない、典型的な未完成部分。60 秒で勝手に録画が止まる理由がユーザーから見えない。
- **修正方針**: `ClipHotkeySettings`（または「キャプチャ」タブの録画セクション）に最長録画秒数の入力（プリセット 30/60/120/300 + 数値入力、5〜300 で clamp）を追加。あわせて自動停止時の通知に「最長時間に達したため停止」の文言を出すと親切。

### V-7 (P3) 録画開始処理中（0〜700ms+）のホットキー押下が黙って無視される

- **対象**: [recording.ts:100-101](app/src/main/video/recording.ts#L100-L101), [recording.ts:169-172](app/src/main/video/recording.ts#L169-L172)
- **現状**: `isRecordingStarting` 中の押下は `startRecording()` の先頭ガードで no-op（`isRecording` はまだ false なので `stopRecording` にもならない）。
- **問題**: 「押したのに始まらない/止まらない」に見える。V-1 と組み合わさると連打を誘発する。
- **修正方針**: `isRecordingStarting` 中に押されたら「開始完了後に即停止する」フラグを立てる（stop-pending）か、最低でも開始処理中である旨を無視せず扱う。V-1 対応後であれば実害は UX のみなので優先度は低い。

### V-8 (P3) クリップ全体をメモリ上で組み立てて 1 回の IPC で送っている

- **対象**: [recorder.ts:209-215](app/src/renderer/recorder.ts#L209-L215), [recorder-ipc.ts:17](app/src/main/video/recorder-ipc.ts#L17)
- **現状**: chunks を Blob に結合 → `fixWebmDuration` → `arrayBuffer()` → IPC 送信。上限 1GB。
- **問題**: 300 秒 @8Mbps+音声で 300MB 超になり、Blob/ArrayBuffer/IPC 構造化クローンで一時的に数倍のメモリピークが出る。動くが重い。
- **修正方針**: 当面は許容範囲。将来的には `ondataavailable` ごとに main へストリーム送信（または renderer から一時ファイルへ書けないので main 側で fd を開いて chunk 転送）し、duration 修正は main 側で ffmpeg remux（`-c copy`）に置き換えるとメモリ・`fix-webm-duration` 依存の両方が消える。

### V-9 (P3) レコーダーウィンドウが常時 1×1 の可視 always-on-top で、マウスイベント透過を設定していない

- **対象**: [recorder-window.ts:29-48](app/src/main/video/recorder-window.ts#L29-L48)
- **現状**: rVFC スロットリング回避のため意図的に可視 1×1（コメントあり）。`focusable: false` だが `setIgnoreMouseEvents` は未設定。
- **問題**: 画面 (0,0) の 1px が常に最前面にあり、クリックを吸い得る。実害はほぼないが行儀の問題。
- **修正方針**: `recorderWindow.setIgnoreMouseEvents(true)` を追加。

---

## B. トリミング（IPC・ffmpeg）

### V-10 (P2) トリムのエラーコードが生のままユーザーに表示される

- **対象**: [ipc-video.ts:46-58](app/src/main/video/ipc-video.ts#L46-L58), [VideoTrimmer.tsx:487-493](app/src/renderer/src/video/VideoTrimmer.tsx#L487-L493)
- **現状**: main は `'invalid_in'` / `'already_trimming'` / `'path_error'` などの英語コード、失敗時は `err.message` の先頭 200 文字（ffmpeg の stderr 断片を含み得る）を返し、UI は `エラー: ${result.error}` とそのまま表示する。
- **問題**: 「エラー: already_trimming」のような表示になる。アプリの他の通知はすべて日本語文になっており不統一。
- **修正方針**: renderer 側にコード→日本語メッセージのマップを置く（`already_trimming` →「このクリップは処理中です」等）。未知のコード/ffmpeg メッセージは「トリミングに失敗しました」+ 詳細折りたたみ or console 行き。

### V-11 (P2) トリミングは中断不可・進捗表示なし（最長 5 分ブロック）

- **対象**: [ipc-video.ts:76-79](app/src/main/video/ipc-video.ts#L76-L79), [ffmpeg.ts:15](app/src/main/video/ffmpeg.ts#L15), [VideoTrimmer.tsx:350-352](app/src/renderer/src/video/VideoTrimmer.tsx#L350-L352)
- **現状**: `trimWebm` は再エンコードで、タイムアウトは 5 分。実行中は Esc・キャンセル・✕がすべて無効化され、ボタンは「トリミング中...」固定。
- **問題**: 長尺（インポートした動画も対象になり得る）では分単位で UI が閉じられない。ffmpeg プロセスを止める手段もない。
- **修正方針**: (1) `video:trimCancel` IPC を追加し、`runFfmpeg` が返す child process を imageId で保持して kill できるようにする。(2) ffmpeg の `-progress pipe:1` か stderr の `time=` を拾って進捗（%）をモーダルへ送る。最低限 (1) だけでも入れる価値がある。

### V-12 (P2) トリム保存はサムネ生成失敗が致命扱い（録画保存と非対称）

- **対象**: [ipc-video.ts:77-78](app/src/main/video/ipc-video.ts#L77-L78) ↔ [recorder-ipc.ts:73-79](app/src/main/video/recorder-ipc.ts#L73-L79)
- **現状**: 録画保存（recorder:done）は `extractThumb` 失敗時に warning ログだけ出してサムネなしで登録を続行する。トリム側は `extractThumb` が throw すると catch に落ち、**トリム済み webm ごと削除**してエラー返却する。
- **問題**: トリム本体（ffmpeg 変換）は成功しているのに、サムネだけの失敗で成果物を捨てる。挙動も 2 つの保存経路で不統一。
- **修正方針**: 録画側と同じく best-effort にする: `extractThumb` を個別 try/catch で包み、失敗時は `thumb_path: null`・`autoTag: null` で登録を続行する。

### V-13 (P3) フレーム PTS 解析が毎回全デコードでキャッシュもない

- **対象**: [ffmpeg.ts:54-73](app/src/main/video/ffmpeg.ts#L54-L73), [VideoTrimmer.tsx:107-127](app/src/renderer/src/video/VideoTrimmer.tsx#L107-L127)
- **現状**: トリマーを開くたびに `showinfo` フィルタで全フレームをデコードして PTS を取る。60 秒でタイムアウトすると throw → UI は「フレーム解析失敗（フレーム精度低下）」で秒ベースにフォールバック。
- **問題**: 同じクリップを開き直すたびに再解析。録画クリップ（〜300 秒・30fps）は許容範囲だが、インポートされた長尺動画では毎回数十秒〜タイムアウト常連になる。
- **修正方針**: imageId → pts[] の main 側 LRU キャッシュ（ファイル mtime で無効化）を挟むだけで開き直しは解消する。長尺対策としては解析対象を「クリップ想定尺以内のみ」に制限し、超える場合は最初から秒モードで開く判断も可。

### V-14 (P3) 登録する `duration` が要求値で、実出力とズレ得る

- **対象**: [ipc-video.ts:95](app/src/main/video/ipc-video.ts#L95)
- **現状**: トリム結果の duration に `outSec - inSec`（要求値）を保存。実際の出力はエンコーダ・フレーム境界の都合で数十 ms 単位でずれる。
- **問題**: サムネの長さバッジ・トリマー再オープン時の初期 OUT にわずかな不整合が出る。実害は小さい。
- **修正方針**: 保存後に `getVideoDuration(webmOut)` を一度呼び、取れたらそちらを採用（null なら要求値のまま）。

### V-15 (P3) 動画の width/height が常に null で登録される

- **対象**: [recorder-ipc.ts:88-89](app/src/main/video/recorder-ipc.ts#L88-L89), [ipc-video.ts:90-91](app/src/main/video/ipc-video.ts#L90-L91)
- **現状**: 録画クリップもトリム結果も `width: null, height: null`。
- **問題**: 現状の UI は 16:9 固定セルなので表示上の実害はないが、画像側と情報量が非対称で、将来サイズフィルタや実寸表示を入れると動画だけ欠落する。
- **修正方針**: 録画側はクロップ確定時の `crop.w/h`、トリム側は元画像の値（または ffmpeg 出力のパース）を入れる。優先度低。

---

## C. トリミング UI（VideoTrimmer.tsx）

### V-16 (P3) オーバーレイクリックの挙動が ✕ / Esc と不整合

- **対象**: [VideoTrimmer.tsx:505-507](app/src/renderer/src/video/VideoTrimmer.tsx#L505-L507)
- **現状**: IN/OUT 変更済みのとき、✕ と Esc は確認ダイアログを出すが、オーバーレイクリックは**何も起きない**（`boundaryChanged` なら単に無視）。
- **問題**: 「背景クリックで閉じたい」ユーザーには反応がなく壊れているように見える。
- **修正方針**: オーバーレイクリックも `requestClose()` に統一する（変更済みなら確認ダイアログが出る）。

### V-17 (P3) トリマーを開いても背後の DetailPanel の動画が再生され続ける

- **対象**: [DetailPanel.tsx:268-274](app/src/renderer/src/components/DetailPanel.tsx#L268-L274), [trimStore.ts](app/src/renderer/src/video/trimStore.ts)
- **現状**: `VideoPlayer` の `pauseWhen` は `viewerOpen` のみ。トリムモーダルは考慮されない。
- **問題**: DetailPanel から「トリミング」を開くと、同じ動画が背後で再生されたまま（音声二重・リソース二重デコード）。
- **修正方針**: `pauseWhen={viewerOpen || trimOpen}` にする。コアの DetailPanel が video 機能の store を直接 import しない設計を守るなら、`useTrimStore` 側は registry 経由で「モーダル開閉状態」を公開する形（例: registry に `useIsFeatureModalOpen` を足す）にする。

### V-18 (P3) タイムラインストリップ取得に前回リクエストのキャンセルがない

- **対象**: [VideoTrimmer.tsx:129-133](app/src/renderer/src/video/VideoTrimmer.tsx#L129-L133)
- **現状**: `image.id` 変更で再取得するが、前の Promise の結果を破棄しない（`mountedRef` はアンマウント時のみ）。
- **問題**: モーダル単位でマウントされる現在の使い方ではほぼ顕在化しないが、id を差し替えて再利用されると古いストリップが後着で勝つ。
- **修正方針**: 他の effect と同様に `cancelled` フラグを持つ（3 行の修正）。

### V-19 (P3) IN/OUT ドラッグ・音量ドラッグ中にアンマウントすると window リスナーが残る

- **対象**: [VideoTrimmer.tsx:432-480](app/src/renderer/src/video/VideoTrimmer.tsx#L432-L480), [VideoTrimmer.tsx:149-168](app/src/renderer/src/video/VideoTrimmer.tsx#L149-L168), [VideoPlayer.tsx:93-131](app/src/renderer/src/components/VideoPlayer.tsx#L93-L131)
- **現状**: `mousedown`/`pointerdown` 時に `window` へ move/up リスナーを張り、up で解除する。アンマウント時の解除はない。
- **問題**: ドラッグ中に（トリム完了などで）アンマウントされた場合、up が来るまでリスナーが残り、`document.body.style.userSelect` も戻らないことがある。一度きりのリークで蓄積はしないが、userSelect が残ると選択不能になる。
- **修正方針**: `useEffect` のクリーンアップで「アクティブなドラッグの後始末関数」を呼べるよう ref に保持する。最低限 `userSelect` の復元だけでも保証する。

---

## D. 再生・表示（VideoPlayer / Viewer）

### V-20 (P2) VideoPlayer と VideoTrimmer でコントロールバー・音量ポップアップが約 100 行重複

- **対象**: [VideoPlayer.tsx:112-227](app/src/renderer/src/components/VideoPlayer.tsx#L112-L227) ↔ [VideoTrimmer.tsx:149-168](app/src/renderer/src/video/VideoTrimmer.tsx#L149-L168), [VideoTrimmer.tsx:537-566](app/src/renderer/src/video/VideoTrimmer.tsx#L537-L566), [VideoTrimmer.tsx:667-673](app/src/renderer/src/video/VideoTrimmer.tsx#L667-L673)
- **現状**: 再生/一時停止ボタン・ミュートアイコン SVG・音量ポップアップ（トラック/フィル/サム/開閉アニメ）・`#shiori-vc-styles` の style 注入・`handleVolPointerDown` が両者にほぼ同一実装で存在する。
- **問題**: 片方だけ直す事故が起きやすい（既に VideoTrimmer 側だけ音量状態を `lastVolume` に共有しない差分が生まれている）。keyframes の style 要素 id が同一なのは dedupe 前提で成立しているが暗黙的。
- **修正方針**: `VolumePopupButton`（アイコン+ポップアップ+ドラッグ）と `PlayPauseButton` を components 配下へ切り出して両方から使う。フレーバー分離の方向（video/ → コア方向の依存は可）に反しない。あわせてトリマー側も `lastVolume`/`lastMuted` を共有して音量を引き継ぐ。

### V-21 (P3) Viewer の動画にコマ送りがない（拡張・トリマーと不統一）

- **対象**: [Viewer.tsx:63-67](app/src/renderer/src/components/Viewer.tsx#L63-L67)
- **現状**: Viewer では Space の再生/停止のみ。`Shift+←/→` のコマ送りは拡張（視聴ページ）とトリマーには存在する。
- **問題**: README が「コマ送り: プレーヤー上で Shift+←/→」を売りにしている一方、アプリ内ビューアの動画では効かない。←/→ は画像送りに割当済みなので、Shift 付きだけでも対応する余地がある。
- **修正方針**: Viewer の keydown で `media_type === 'video'` かつ Shift+←/→ のとき `settings.frameFps` ベースで `currentTime ± 1/fps`（VideoPlayer に `stepFrame(dir)` を生やす）。フレーム PTS までは不要、トリマーの秒モード相当で十分。

### V-22 (P3) VideoPlayer の `onEnded` で先頭へ巻き戻すためリピート視聴以外では違和感

- **対象**: [VideoPlayer.tsx:153](app/src/renderer/src/components/VideoPlayer.tsx#L153)
- **現状**: 再生終了で `currentTime = 0` に戻し、シークバーも 0 表示。
- **問題**: 「最後のフレームを見ながら止まっていてほしい」（キャプチャ用途だと最終フレーム確認は普通にある）場合に不便。好みの問題なので低優先。
- **修正方針**: 巻き戻さず終端で止め、再生ボタン押下時に終端なら 0 から再生する方式を検討。

---

## E. テスト

### V-23 (P2) 録画ステートマシンと recorder IPC 検証にテストがない

- **現状**: 動画関連のテストは [ffmpeg.test.ts](app/src/main/video/ffmpeg.test.ts)（trimWebm の尺回帰 2 件）のみ。`recording.ts` の開始/停止/固着復帰、`recorder-ipc.ts` の入力検証（サイズ・duration 境界・sender 検証）、`VideoTrimmer` の `findFrameIdx`（二分探索）や IN/OUT クランプはすべて未検証。
- **問題**: V-1/V-3 のようなレース由来の状態バグがまさにテスト空白地帯で起きている。
- **修正方針**: 優先順に:
  1. `recording.ts`: electron モックで「start → done 前に stop → error/aborted で必ず `finishRecordingState` される」「二重 start が no-op」「ウォッチドッグ発火」のユニットテスト（V-1 の修正とセットで）
  2. `recorder-ipc.ts`: `recorder:done` の payload 検証境界（0 byte / 1GB 超 / duration 0・3601）
  3. `VideoTrimmer` のロジック関数（`findFrameIdx` / `snapToPts` / `exportOutSec` 算出）を純関数として切り出してユニットテスト

---

## 良かった点（維持してほしい設計）

- **フレーバー分離の徹底**: `video/` ディレクトリ単位の隔離、`VideoApi` を宣言マージにしない判断（[api.video.ts](app/src/shared/api.video.ts) のコメント）、`video-thumb-provider` による差し替え境界はいずれも明快。
- **IPC の防御**: `isTrustedRecorderSender` の sender+URL 検証、`recorder:done` のサイズ/尺上限、`ipc-video` の id/範囲検証と `trimmingIds` による多重実行防止は妥当。
- **capfile プロトコルの Range 対応**（[bootstrap.ts:131-166](app/src/main/bootstrap.ts#L131-L166)）: サフィックス Range・416 まで正しく、動画シークの要件を押さえている。
- **ffmpeg まわり**: タイムアウトと `timedOut` の扱い（途中結果を正常値として返さない）、preSeek 付きトリムに回帰テストがあるのは良い。
- コメントが「なぜ」を書いており、レース対策の意図が追える（V-3 はその意図が実装に半分しか反映されていないケース）。

---

## 対応順の提案

1. **V-1**（固着。renderer の aborted 通知 + main ウォッチドッグ）→ V-23-1 のテストをセットで
2. **V-2 / V-3 / V-4 / V-5**（保存・録画経路の信頼性）
3. **V-6 / V-10 / V-11 / V-12**（未完成部分の完成: 設定 UI・エラー文言・キャンセル・サムネ非致命化）
4. P3 群は上記のついでに（V-20 の共通化は V-17 と同時にやると触るファイルが重なって効率が良い）
