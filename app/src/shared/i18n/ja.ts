// 日本語の文言辞書。**このファイルが唯一の基準**で、キーを足したら en.ts にも足すこと
// （en.ts は Record<MessageKey, string> なので、足し忘れると typecheck が落ちる）。
//
// キー命名は `<領域>.<要素>`。領域は menu / tray / dialog / busy / notice / error /
// toolbar / sidebar / settings / viewer / detail / timeline / tag / video / shortcut。
//
// 英語側の用語は en.ts の冒頭コメントで固定している。訳を足すときは必ずそちらを見ること。
export const ja = {
  // ── トレイ / ネイティブメニュー ────────────────────────────────
  'menu.open': '開く',
  'menu.settings': '設定',
  'menu.quit': '終了',
  'tray.recording': 'Shiori — 録画中',

  // ── ネイティブダイアログ ──────────────────────────────────────
  'dialog.updateBusy.title': '更新の確認',
  'dialog.updateBusy.message': '{tasks}が進行中です',
  'dialog.updateBusy.detail': '更新するとアプリが再起動し、進行中の処理は中断されます。',
  'dialog.updateBusy.proceed': '処理を中止して更新',
  'dialog.updateBusy.cancel': 'キャンセル',
  'dialog.exportFolder': 'エクスポート先フォルダを選択',
  'dialog.importFolder': 'インポートするフォルダを選択',
  // activeTaskLabels() を dialog.updateBusy.message へ差し込むときの区切り文字。
  'list.separator': '・',

  // ── 実行中タスクのラベル（更新確認ダイアログに出る） ──────────
  'busy.import': '取り込み',
  'busy.export': 'エクスポート',
  'busy.retag': 'AIタグ付け',
  'busy.modelDownload': 'AIモデルのダウンロード',
  'busy.thumbRepair': 'サムネイルの修復',

  // ── 起動時の致命的エラー ──────────────────────────────────────
  'error.dbOpen':
    'データベースを開けなかったため起動できませんでした。\n\n' +
    '他のプロセスがファイルをロックしていないか確認するか、PC を再起動してからもう一度お試しください。',
  // 起動処理が途中で止まったとき。console にしか出さないと、使う人からは「ウィンドウが
  // 出ない」「トレイに居るのに何もできない」としか見えず、原因を確かめる手段が無くなる。
  // {detail} には例外の1行目だけを入れる（スタックは console 側に残す）。
  'error.startupFailed':
    '起動の途中で処理が止まったため、Shiori を開けませんでした。\n\n' +
    'PC を再起動してから、もう一度お試しください。\n\n' +
    '原因: {detail}',
  // ウィンドウは出来ているが、その後の準備（ホットキー・ブラウザ連携・トレイ等）で
  // 止まった場合。使える部分が残っているので終了はさせず、何が欠けているかだけ伝える。
  'error.startupPartial':
    '起動の準備を完了できませんでした。\n\n' +
    '画面は開いていますが、キャプチャのホットキーやブラウザとの連携など、一部が動かない\n' +
    '可能性があります。Shiori を再起動してください。\n\n' +
    '原因: {detail}',
  'notice.settingsCorrupt': '設定ファイルが破損していたため、デフォルト設定で起動しました。',
  // 「読めなかった」は破損と違い、設定ファイル自体は無事なことが多い（ウイルス対策などが
  // 一時的に掴んでいた）。ここで設定を変えると無事なファイルを上書きしてしまうので、
  // 初期値で動いていることだけでなく、上書きの危険まで書く。
  'notice.settingsUnreadable':
    '設定ファイルを読み込めなかったため、デフォルト設定で起動しました。\n' +
    '元の設定ファイルは残っていますが、この状態で設定を変更すると新しい内容で上書きされます。',
  // 壊れた DB を退避から戻せるとき／戻せないとき。タグ・メモ・タイムシートの打鍵は
  // この 1 ファイルにしか無いので、何が失われたのかを必ず数えられる形で出す。
  'dialog.dbRestore.title': 'データベースの復元',
  'dialog.dbRestore.message': 'データベースが壊れています',
  'dialog.dbRestore.detail':
    '{date} のバックアップから復元できます。復元後、Shiori を再起動します。\n\n' +
    '{date} より後に付けたタグ・メモ・タイムシートは失われます。壊れたファイルは消さずに\n' +
    'backups フォルダへ残すので、後から中身を取り出すこともできます。\n\n' +
    '画像と動画そのものは別のファイルなので、どちらを選んでも消えません。',
  'dialog.dbRestore.restore': 'バックアップから復元する',
  'dialog.dbRestore.quit': '終了する',
  'error.dbCorruptNoBackup':
    'データベースが壊れており、戻せるバックアップがありませんでした。\n\n' +
    '画像と動画そのものは別のファイルなので消えていません。タグ・メモ・タイムシートは\n' +
    '失われます。次のファイルを別の場所へ移してから、Shiori をもう一度起動してください。\n\n' +
    '{path}',
  'error.dbRestoreFailed':
    'データベースをバックアップから戻せませんでした。\n\n' +
    'ディスクの空きとウイルス対策ソフトを確認してから、もう一度起動してください。\n\n' +
    '{detail}',
  'notice.dbRestored':
    'データベースが壊れていたため、{date} のバックアップから復元しました。それより後に追加したタグ・メモ・タイムシートは含まれていません。',
  'notice.dbBackupFailed':
    'データベースをバックアップできませんでした。次に問題が発生した場合、最後に成功したバックアップ以降の変更を復元できない可能性があります。ディスクの空き容量を確認してください。',
  // 画面上の設定は変わっているがファイルには書けていない状態。黙っていると、次に起動した
  // ときだけ設定が巻き戻って原因が分からなくなる。
  'notice.settingsPersistFailed':
    '設定をファイルに保存できませんでした。この変更は Shiori を終了すると失われます。ウイルス対策ソフトやディスクの空き容量を確認してください。',
  // 候補ポートを全部試して駄目だったときだけ出る。1つ塞がっただけなら黙って隣へ移る。
  'notice.portInUse': 'ブラウザ拡張と接続できません。ポート {ports} は、すべて他のアプリが使用しているか、Windows によって予約されています。PC を再起動すると解消することがあります。',
  'notice.updated': 'Shiori を v{version} に更新しました',
  // アプリの更新に付いてきた拡張は、ブラウザ側で読み込み直すまで古いまま動く。
  // ブラウザ名も URL も出さない（Chrome / Edge / Vivaldi / Brave / Firefox で
  // 開く場所が違い、決め打ちすると存在しない画面を案内することになる）。
  'notice.extensionUpdated':
    'ブラウザ拡張を {from} → {to} に更新しました。ブラウザの拡張機能ページで再読み込みするまで、更新前のバージョンが動作します。',

  // ── キャプチャ ────────────────────────────────────────────────
  'notice.captureTargetNotFound':
    'キャプチャ対象を検出できませんでした。対応サイトの動画ページを開き、ブラウザ拡張が有効になっているか確認してください。',
  'notice.captureBlackScreen':
    '映像が真っ黒に写っています。ブラウザの設定でハードウェアアクセラレーションをオフにしてください。',
  'notice.captureSaveFailed': 'キャプチャの保存に失敗しました',
  'notice.captureSaved': 'キャプチャを保存しました',
  'error.captureFailed': 'キャプチャに失敗しました。もう一度お試しください。',
  'error.hotkeyRegisterFailed':
    'ホットキー {hotkey} を登録できませんでした。他のアプリで使われている可能性があります。',
  'error.clipHotkeyRegisterFailed':
    '録画ホットキー {hotkey} を登録できませんでした。他のアプリで使われている可能性があります。',

  // ── 録画 / クリップ ───────────────────────────────────────────
  'notice.recordingNoAudio': '音声なしで録画しています（音声デバイスの初期化に失敗しました）。',
  'notice.videoRegionNotFound': '動画の表示領域を特定できませんでした。ページを再読み込みして、もう一度お試しください。',
  'notice.recordingEmpty': '録画データが空でした。短すぎる録画は保存されません。',
  'notice.screenCapturePermission':
    '画面録画の権限がありません。ブラウザのハードウェアアクセラレーションをオフにして、もう一度お試しください。',
  'notice.recordingError': '録画エラー: {message}',
  'notice.recordingDataInvalid': '録画データが不正なため保存できませんでした。',
  'notice.clipSaveFailed': 'クリップの保存に失敗しました',
  'notice.clipSaved': 'クリップを保存しました（{duration}）',
  'notice.clipSavedWithMissed': 'クリップを保存しました（{duration}・{count}コマ未取得）',
  'notice.videoNotDetected':
    '動画を検出できませんでした。対応サイトの動画ページを開き、ブラウザ拡張が有効になっているか確認してください。',
  'notice.recorderPrepareFailed': 'レコーダーの準備に失敗しました。もう一度お試しください。',
  'notice.recordingSourceNotFound': '録画する画面が見つかりませんでした',
  'notice.recordingDisplayUncertain':
    '録画対象の画面を特定できませんでした。別のモニターが録画されている可能性があります。',
  'notice.recordingTimeout': '録画処理がタイムアウトしました。もう一度お試しください。',

  // ── データ書き出し / 読み込み ─────────────────────────────────
  'error.metadataTooLarge': 'metadata.jsonl が大きすぎます（上限64MB）',
  'error.metadataMissing': 'metadata.jsonl が見つかりません',
  'error.settingsTooLarge': 'settings.json が大きすぎます（上限1MB）',

  // ── ショートカット一覧（サイドバーのフライアウト） ────
  'shortcuts.heading': 'ショートカット',
  'shortcuts.hint': 'キャプチャホットキーは設定 →「キャプチャ」で変更できます。',
  // 同じフライアウトの下段。**「?」ボタンはこのアプリで唯一のヘルプ面**なので、
  // ショートカット以外の「困ったときに開くもの」もここへ集める。
  'help.whatsNew': '変更点を見る',
  'help.feedback': '不具合・要望を報告',
  // 「アプリからは何も送らない」ことを必ず添える（全ローカル完結が前提のため）。
  'help.feedbackHint': 'ブラウザで報告フォームが開きます。アプリから内容が送信されることはありません。',
  'shortcuts.group.global': '全体',
  'shortcuts.group.selection': '選択・グリッド',
  'shortcuts.group.viewer': 'ビューア',
  'shortcuts.keys.arrows': '矢印キー',
  'shortcuts.keys.doubleClick': 'ダブルクリック',
  'shortcuts.focusSearch': '検索欄にフォーカス',
  'shortcuts.quickTag': 'フォーカス中の画像にクイックタグ',
  'shortcuts.openSettings': '設定を開く',
  'shortcuts.copySelected': '選択中の画像をコピー',
  'shortcuts.pasteFromClipboard': 'クリップボードから画像を取り込み',
  'shortcuts.moveFocus': 'フォーカス移動',
  'shortcuts.selectAll': 'すべて選択',
  'shortcuts.pageThrough': 'ページ送り',
  'shortcuts.openFocused': 'フォーカス中の画像を開く',
  'shortcuts.deleteSelected': '選択中の画像を削除',
  'shortcuts.clearSelection': '選択を解除',
  'shortcuts.undoGrid': '元に戻す（削除の取り消し／選択の取り消し）',
  'shortcuts.redo': 'やり直し',
  'shortcuts.prevNext': '前 / 次の画像へ',
  'shortcuts.viewerFrameStep': 'コマ送り（動画）',
  'shortcuts.closeViewer': 'ビューアを閉じる',
  'shortcuts.viewerSpace': '動画の再生 / 一時停止（画像では何も起きません）',
  'shortcuts.toggleZoom': 'ズームのオン・オフ切り替え（画像のみ）',
  'shortcuts.zoomInOutReset': 'ズームイン / アウト / リセット',
  'shortcuts.toggleDetails': '詳細パネルの表示切り替え',
  'shortcuts.deleteCurrent': '表示中の画像を削除',
  'shortcuts.undoRedo': '元に戻す / やり直し',

  // ── 共通アクション ────────────────
  'action.delete': '削除',
  'action.undo': '元に戻す',

  // ── 確認ダイアログ ───────────────
  'confirm.deleteSmartFolder.title': 'スマートフォルダを削除',
  'confirm.deleteSmartFolder.message': '「{name}」を削除しますか？\n保存した絞り込み条件だけが削除され、画像は削除されません。',
  'confirm.deleteTag.title': 'タグを削除',
  'confirm.deleteTag.message.one': 'タグ「{tag}」を{count}枚の画像すべてから削除しますか？この操作は元に戻せません。',
  'confirm.deleteTag.message.other': 'タグ「{tag}」を{count}枚の画像すべてから削除しますか？この操作は元に戻せません。',
  'confirm.deleteModel.title': 'AIタグ付けモデルを削除',
  'confirm.deleteModel.message': '再度使うには約600MBのモデルをダウンロードする必要があります。これまでに付与されたAIタグ（手動タグは除く）もライブラリ全体から削除されます。この操作は元に戻せません。',

  // ── トースト ───────────────────
  'toast.captureRegisterFailed': 'キャプチャ画像の登録に失敗しました。アプリを再起動してもう一度試してください。',
  'toast.captureAddFailed': 'キャプチャ画像を一覧に追加できませんでした',
  'toast.tagRemovedFromAll.one': 'タグ「{tag}」を{count}枚から削除しました',
  'toast.tagRemovedFromAll.other': 'タグ「{tag}」を{count}枚から削除しました',
  'toast.tagRemoveFailed': 'タグの削除に失敗しました',
  'toast.smartFolderSaveFailed': 'スマートフォルダの保存に失敗しました',
  'toast.smartFolderDeleteFailed': 'スマートフォルダの削除に失敗しました',
  'toast.reorderSaveFailed': '並べ替えの保存に失敗しました',
  'toast.pastedFromClipboard': 'クリップボードから取り込みました',
  'toast.clipboardEmpty': 'クリップボードに画像がありません',
  'toast.pasteFailed': 'クリップボードからの取り込みに失敗しました',
  'toast.videoCopyUnsupported': '動画はクリップボードにコピーできません',
  'toast.copiedToClipboard': 'クリップボードにコピーしました',
  'toast.copyFailed': '画像のコピーに失敗しました',
  'toast.deleting.one': '{count}枚を削除中...',
  'toast.deleting.other': '{count}枚を削除中...',
  'toast.deleted.one': '画像を削除しました（Ctrl+Z でも戻せます）',
  'toast.deleted.other': '{count}枚を削除しました（Ctrl+Z でも戻せます）',
  'toast.deletedPartial': '{deleted}枚を削除しました。{failed}枚は削除できませんでした。',
  'toast.deleteFailed': '画像を削除できませんでした。ファイルの状態を確認してください。',
  'toast.deleteUndone': '削除を取り消しました',
  'toast.selectAllTruncated': '表示上限のため {shown} / {total} 件のみ選択されました',
  'toast.exportBusy': '他のエクスポートが完了してからお試しください',
  'toast.exportStopped.one': '{count}枚でエクスポートを中止しました',
  'toast.exportStopped.other': '{count}枚でエクスポートを中止しました',
  'toast.exported.one': '{count}枚をエクスポートしました',
  'toast.exported.other': '{count}枚をエクスポートしました',
  'toast.exportTruncatedSuffix': '（上限のため一部は対象外です）',
  'toast.exportFailed': 'エクスポートに失敗しました。保存先やファイルの状態を確認してください。',
  'toast.startupToggleFailed': '自動起動の設定に失敗しました',
  'toast.taggingError': 'AIタグ付けでエラーが発生しました: {message}',
  'toast.taggingStopped.one': '{count}枚で中止しました',
  'toast.taggingStopped.other': '{count}枚で中止しました',
  'toast.tagged.one': '{count}枚にAIタグを付与しました',
  'toast.tagged.other': '{count}枚にAIタグを付与しました',
  'toast.aiTagsRemoved.one': 'AIタグ {count}件を削除しました',
  'toast.aiTagsRemoved.other': 'AIタグ {count}件を削除しました',
  'toast.modelDownloadFailed': 'AIモデルのダウンロードに失敗しました',
  'toast.modelDownloadCanceled': 'AIモデルのダウンロードを中止しました',
  'toast.loadImagesFailed': '画像の読み込みに失敗しました',
  'toast.loadTimelineFailed': 'タイムラインの読み込みに失敗しました',
  'toast.settingsSaveFailed': '設定の保存に失敗しました',

  // ── 共通アクション（追加分） ──
  'action.close': '閉じる',
  'action.cancel': 'キャンセル',
  'action.confirm': '確定',
  'action.change': '変更',
  'action.copy': 'コピー',
  'action.export': 'エクスポート',
  'action.clear': '解除',
  'action.stop': '中止',
  'action.showInFolder': 'エクスプローラーで表示',
  'state.working': '処理中...',
  'state.loading': '読み込み中...',

  // ── タグ関連 ──
  'tag.addHint': '追加 (Enter)',
  'tag.normalizePreview': '→ {tag} として追加されます',
  'tag.addTitle': 'タグを追加',
  'tag.namePlaceholder': 'タグ名',
  'tag.quickHint': 'Enter で追加 · Shift+Enter で連続追加 · Esc で閉じる',
  'tag.addFailed': 'タグの追加に失敗しました',
  'tag.sectionTitle': 'タグ',
  'tag.legendManual': '手動',
  'tag.legendAi': 'AI',
  'tag.clickToFilter': 'クリックで絞り込み / 絞り込み中なら解除',
  'tag.rightClickToDelete': '（右クリックで削除）',
  'tag.deleteNamed': 'タグ「{tag}」を削除',
  'tag.addPlaceholder': 'タグを追加...',
  'tag.addChip': '+ タグ',
  'tag.kindAi': 'AIタグ',
  'tag.kindManual': '手動タグ',

  // ── ビューア ──
  'viewer.endHint': 'End は読み込み済みの最後へ移動します',
  'viewer.close': '閉じる（Esc）',
  'viewer.prev': '前へ（←）',
  'viewer.next': '次へ（→）',
  // コマ送りの読み出し（VideoPlayer のコマ表示）。
  // 「絵が変わらない」こと自体が測定結果なので、番号だけでなく、そのコマをどう読んでよいか
  // （専用の絵があるのか・流用なのか）まで出す。docs/ANIME-FRAMES.md 参照。
  'viewer.frameIndex': 'コマ {cur} / {total}',
  'viewer.frameIndexFile': 'フレーム {cur} / {total}',
  'viewer.frameReused': '流用',
  'viewer.frameReusedSame': '流用・変化なし',
  'viewer.frameNeedsReview': '要確認',
  'viewer.frameLoading': 'コマ表を読み込み中',
  'viewer.frameEstimated': 'コマ位置不明（{fps}fps 換算）',
  'viewer.frameSourceHint': '元の動画のコマ単位で進みます。映像が変わらない箇所では、元の動画でも同じ映像が続いています。',
  'viewer.frameReusedHint': 'このコマの映像は個別に取り込めなかったため、直前のコマの映像を表示しています（未検証）。ここで映像が変わらないことを、コマ打ちの根拠にはできません。',
  'viewer.frameReusedSameHint': 'このコマの映像は個別に取り込めませんでしたが、前後の映像が同一であることを確認済みです。コマ打ちの数え方には影響しません。',
  'viewer.frameNeedsReviewHint': 'このコマの映像は個別に取り込めず、前後の映像も異なります。映像がどのコマで変わったかは特定できません。',
  'viewer.frameFileHint': 'ファイルに記録されたフレームを順に表示します。取り込んだ動画では、これが素材のコマそのものです。',
  'viewer.frameFileCaptureHint': '素材のコマ表がないため、ファイルに記録されたフレームを順に表示します。画面キャプチャの取得間隔に基づくため、素材のコマとは一致しません。',
  'viewer.frameLoadingHint': 'コマ表を読み込んでいます。読み込みが終わるまでコマ送りは保留され、まとめて反映されます。',
  'viewer.frameEstimatedHint': 'このクリップのフレーム位置を取得できませんでした。fps から換算した間隔で進むため、素材のコマとは一致しません。',

  // コマ再生（自動でコマを送る）。速さは「1 コマを何秒見せるか」で持つ——画面で体験して
  // いるのがその値なので、コマ/秒 のような換算の要る単位にしない。
  // **「1コマ」まで入れて 1 つの単位にする。** 秒数だけだと、何の時間なのか（コマの表示時間
  // なのか、送る間隔なのか、尺なのか）がボタンからは読めない。
  'viewer.frameHold': '1コマ {sec}秒',
  // ポップアップの行。共通部分（1コマ）は見出し側にあるので、ここは数字だけにする。
  'viewer.frameHoldShort': '{sec}秒',
  'viewer.frameHoldGroup': '1コマの表示時間',
  'viewer.speedNormal': '等速',
  'viewer.speedNormalHint': 'そのままの速さで再生します。',
  'viewer.framePlayHint': '素材を 1 コマずつ、各コマを {sec} 秒間表示して再生します。',

  // ── タイムシート ──
  // 手打ちのタイムシート（docs/TIMESHEET.md）。撮り逃し 0 のクリップでしか出ないので、
  // 「なぜ出ないか」を説明する文言は持たない。
  'timesheet.title': 'タイムシート',
  'timesheet.toggle': 'タイムシートの表示を切り替える',
  'timesheet.count': '{marks} 枚 / {total} コマ',
  'timesheet.copy': 'コピー',
  'timesheet.copied': 'コピーしました',
  'timesheet.copyHint': 'タイムシートソフトに貼り付けられる形式でコピーします（{sec} 秒 {frames} コマ）',
  // 表の見出し。紙のタイムシートの欄名に合わせる。
  'timesheet.colSec': '秒',
  'timesheet.colFrame': 'コマ',
  'timesheet.colCell': 'セル',
  'timesheet.colMemo': 'メモ',
  'shortcuts.viewerTimesheet': 'タイムシート表示中：動画番号を入力 / 確定して次のコマへ',
  'shortcuts.viewerTimesheetSymbols': 'タイムシート表示中：○（中割り）/ ●（逆シート）/ ×（カラ）。テンキーの / - * でも入力できます',

  // ── What's New ──
  'whatsNew.title': 'Shiori v{version} の変更点',

  // ── グリッド / タイムライン ──
  'grid.noMatches': '該当する画像がありません',
  'grid.noMatchesHint': '検索語を短くするか、絞り込み条件を外すと見つかることがあります。',
  'grid.clearFilters': 'フィルタをクリア',
  'grid.empty': 'まだ画像がありません',
  'grid.loadFailed': '一覧を読み込めませんでした',
  'thumb.loadFailed': '画像を読み込めません',
  'grid.loadFailedHint': '画像が消えたわけではありません。もう一度読み込んでください。繰り返す場合は Shiori を再起動してください。',
  'grid.reload': 'もう一度読み込む',
  'grid.untitled': 'タイトルなし',
  'timeline.displaying': '{shown} / {total} 件を表示',
  'timeline.loadOlder': 'さらに古い項目を読み込む',
  'timeline.loadNewer': 'さらに新しい項目を読み込む',
  'timeline.loadMore': 'さらに項目を読み込む',
  'timeline.loadingMore': '読み込み中...',

  // ── 並び替え ──
  'sort.newest': '新しい順',
  'sort.oldest': '古い順',
  'sort.random': 'ランダム',

  // ── 検索 ──
  'search.placeholder': 'タイトルやメモを検索（/ でフォーカス）',
  'search.focusHint': '/ で検索にフォーカス',
  'search.clear': '検索をクリア',
  'search.noSuggestions': '候補がありません',
  'search.recent': '最近の検索',
  'search.removeFromHistory': '履歴から削除',
  'search.dateHint': '日付で絞り込み — 例: 2026-01-01 / 2026-01 / 2026',
  'search.prefix.tag': 'タグで絞り込み',
  'search.prefix.from': '開始日を指定',
  'search.prefix.to': '終了日を指定',
  'search.prefix.site': 'サービスで絞り込み',
  'search.prefix.type': '種類で絞り込み',
  'search.type.image': '画像',
  'search.type.video': '動画',

  // ── サイドバー ──
  'sidebar.saveSmartFolderHint': '現在の絞り込みをスマートフォルダとして保存',
  'sidebar.saveDisabledInFolder': 'スマートフォルダ表示中は新規保存できません',
  'sidebar.saveNeedsFilter': 'タグ・サイト・検索などで絞り込むと保存できます',
  'sidebar.imageCount.one': '{count}枚',
  'sidebar.imageCount.other': '{count}枚',
  'sidebar.smartFolders': 'スマートフォルダ',
  'sidebar.folderNamePlaceholder': 'フォルダ名',
  'sidebar.saveSmartFolder': 'スマートフォルダを保存',
  'sidebar.folderReorderHint': '{name}（長押しで並べ替え）',
  'sidebar.deleteFolder': '{name}を削除',
  // 「保存済みの」まで入れるとサイドバー幅で 2 行に折り返し、空の状態の方が場所を取っていた。
  // ただし**何が無いのかは残す**（見出しが上にあっても、単に「まだありません」では読めない）。
  'sidebar.noSmartFolders': 'フォルダはまだありません',
  'sidebar.clearTagFilters': 'タグフィルターをすべて解除',
  'sidebar.aiTagSuffix': '（AIタグ）',
  'sidebar.tagDeleteHint': '（右クリック / Shift+F10 でタグ自体を削除）',
  'sidebar.collapseTags': '折りたたむ',
  'sidebar.showHiddenTags': '+{count}件（{min}枚未満）を表示',
  'sidebar.deleteTagEverywhere': 'タグ「{tag}」を全画像から削除',
  'sidebar.thumbnailSize': 'サムネイルサイズ',
  'sidebar.sizeSmall': '小',
  'sidebar.sizeMedium': '中',
  'sidebar.sizeLarge': '大',
  'sidebar.viewGrid': 'グリッド',
  'sidebar.viewTimeline': 'タイムライン',
  'sidebar.setupLink': '使い方',
  'sidebar.setupProgress': 'セットアップ {completed}/3',

  // ── ホットキー / クリップ設定 ──
  'hotkey.unsupportedCombo': 'このキーの組み合わせは使用できません',
  'hotkey.pressKeys': 'キーを押してください...',
  'hotkey.conflict': '競合しています',
  'clip.notifyOnFinish': '録画完了時に通知する',
  'clip.hotkeyLabel': '録画ホットキー',
  'clip.hotkeyTroubleshoot': '録画ホットキーが効かない場合、他のアプリ（NVIDIA App などのオーバーレイ／録画ソフト）が同じキーを使っている可能性があります。別のキーに変更してお試しください。',

  // ── 動画（トリミング） ──
  'video.trim': 'トリミング',
  // ブラウザ側 , / . の読み取り表示。拡張は文言を持たないので settings で配る
  'video.stepBlocked': 'これ以上進めません',
  'video.stepDropped': '入力が速すぎたため、{count}回分を省略しました',
  'trim.selection': '選択範囲：{seconds} 秒',
  'trim.seekHint': 'クリックした位置へ移動',
  'trim.setIn': 'ここを開始位置に設定',
  'trim.setOut': 'ここを終了位置に設定',
  'trim.analyzing': 'フレーム解析中...',
  'trim.analyzeFailed': 'フレームを解析できませんでした（コマ位置の精度が下がります）',
  'trim.shortcutHint': ', / . コマ送り · I / O 範囲設定 · Space 再生 / 一時停止',
  'trim.error': 'エラー：{message}',
  'trim.working': 'トリミング中...',
  'trim.save': 'トリミングして保存',
  'trim.discardTitle': 'トリミングを中止',
  'trim.discardMessage': '開始位置と終了位置の変更は保存されません。閉じますか？',

  // ── 詳細パネル ──
  'detail.titleHint': 'クリックで展開 / ダブルクリックまたは F2 で編集',
  'detail.editTitle': 'タイトルを編集',
  'detail.timecode': '動画時刻',
  'detail.duration': '長さ',
  'detail.fps': 'FPS',
  'detail.resolution': '解像度',
  'detail.unreportedFrames': '{count}コマ未通知',
  'detail.unreportedFramesHint':
    '素材にあると見込まれる約{expected}コマのうち、{count}コマは配信ページから情報を受信できませんでした。' +
    'その区間はコマ表にも、取得率の計算にも含まれていません。' +
    'このため、このクリップではコマ送りが素材のコマと一致しない箇所があります。',
  'detail.uncapturedFrames': '{count}コマ未取得',
  'detail.ambiguousFrames': '{count}コマ要確認',
  'detail.ambiguousFramesHint':
    '映像を個別に取り込めなかったコマが{missed}個あり、そのうち{ambiguous}個は前後の映像が異なります。' +
    'その区間では映像がどのコマで変わったかを特定できないため、コマ打ちを数える際は確認してください。',
  'detail.memo': 'メモ',
  'detail.memoUnsaved': '未保存',
  'detail.memoSaving': '保存中...',
  'detail.memoSaved': '保存済み',
  'detail.memoSaveFailed': '保存失敗',
  'detail.memoPlaceholder': 'メモを入力...',
  'detail.site': 'サイト',
  'detail.capturedAt': '取得日時',
  'detail.emptyTitle': '画像を選択',
  'detail.emptyHint1': 'クリックで選択・ダブルクリックで拡大',
  'detail.emptyHint2': 'タグをクリックで絞り込み',
  'detail.emptyHint3': 'T キーで選択中の画像にタグを追加',
  'detail.selectedCount.one': '{count}枚選択中',
  'detail.selectedCount.other': '{count}枚選択中',
  'detail.bulkTags': 'タグ（一括編集）',
  'detail.partialTagHint': '・一部の画像のみ（クリックですべてに追加）',
  'detail.bulkTagPlaceholder': 'タグを追加（選択中すべてに）...',
  'detail.imageCount.one': '{count}枚',
  'detail.imageCount.other': '{count}枚',

  // ── トースト（App） ──
  'toast.importTruncatedSuffix': '（200件の上限を超えたため一部は取り込まれていません）',
  'toast.importFailedSuffix': '（{count}件は取り込めませんでした）',
  'toast.imported.one': '{count}枚を取り込みました',
  'toast.imported.other': '{count}枚を取り込みました',
  'toast.importAllFailed': '取り込めませんでした（{count}件）',
  'toast.dragTruncated': '{requested}枚中{copied}枚のみドラッグしました（上限のため一部は対象外です）',
  'toast.tagAdded.one': 'タグ「{tag}」を追加しました',
  'toast.tagAdded.other': '{count}枚にタグ「{tag}」を追加しました',

  // ── 実行中タスクのバナー（App） ──
  'task.modelDownloading': 'AIモデルをダウンロード中',
  'task.retagging': '既存画像にAIタグ付け中',
  'task.libraryImporting': 'ライブラリを読み込み中',
  'task.libraryExporting': 'ライブラリをエクスポート中',
  'task.exporting': 'エクスポート中',

  // ── ドロップ / 更新バナー / オンボーディング ──
  'drop.overlay': 'ドロップして取り込み',
  'update.ready': 'v{version} の準備ができました',
  'update.restart': '再起動して更新',
  'update.later': '今は更新しない',
  'onboarding.step1': '1. 拡張機能フォルダを Chrome に読み込みます',
  'onboarding.step2': '2. 対応サイトで動画を開きます',
  'onboarding.step3.before': '3. 取りたい場面で ',
  'onboarding.step3.after': ' を押します',
  'onboarding.openExtensionFolder': '拡張機能フォルダを開く',
  'onboarding.dropHint': 'または、フォルダや画像をここにドロップして取り込めます',
  'onboarding.lead': '最初のキャプチャまで、ブラウザの準備を3ステップで案内します。',
  'onboarding.startSetup': 'セットアップを始める',

  // ── セットアップガイド ──
  'setup.title': 'Shiori のセットアップ',
  'setup.progress': '{completed} / {total} 完了',
  'setup.intro': 'ストアからインストールする必要はありません。付属の拡張機能をブラウザに一度読み込めば使えます。',
  'setup.browserTitle': 'ブラウザの映像設定を変更する',
  'setup.browserBody': 'ハードウェアアクセラレーションをオフにして、ブラウザを再起動します。有効なままだと映像部分が黒く保存されます。',
  'setup.browserDetail': 'Chrome: 設定 → システム\nEdge: 設定 → システムとパフォーマンス\n「ハードウェア アクセラレーションが使用可能な場合は使用する」をオフ',
  'setup.browserConfirm': 'オフにしてブラウザを再起動しました',
  'setup.extensionTitle': '付属の拡張機能を読み込む',
  'setup.extensionBody': '下のボタンでフォルダを開き、ブラウザの拡張機能ページで読み込みます。',
  'setup.extensionDetail': '1. Chrome で chrome://extensions を開く（Edge は edge://extensions）\n2. 「デベロッパーモード」をオン\n3. 「パッケージ化されていない拡張機能を読み込む」で、開いたフォルダを選ぶ\n4. 対応サイトの動画ページを開く',
  'setup.receiving': '動画ページから受信中',
  'setup.detectedBefore': '接続確認済み',
  'setup.waiting': '動画ページからの受信待ち',
  'setup.captureTitle': '最初の場面を保存する',
  'setup.captureBody': '対応サイトで動画を再生し、残したい場面でキャプチャします。成功するとここも自動で完了します。',
  'setup.captureDetail': 'キャプチャキー: {hotkey}',
  'setup.captureDone': '最初のキャプチャを保存済み',
  'setup.captureWaiting': 'キャプチャ待ち',
  'setup.allDone': '準備完了です。このガイドはサイドバーからいつでも開けます。',
  'setup.reopenHint': '途中で閉じても、サイドバーの「セットアップ」から再開できます。',
  'setup.finish': '完了',
  'setup.closeForNow': '今は閉じる',
  'tour.start': '実際の画面で使い方を試す',
  'tour.startHint': '既存の画像を使います。内容は変更しません。',
  'tour.needsItem': '最初のキャプチャまたは取り込み後に試せます。',
  'tour.progress': '実操作ガイド {current} / {total}',
  'tour.selectTitle': '画像を1枚クリックしてください',
  'tour.selectBody': 'クリックで選択すると、右側の詳細パネルに作品情報やタグ、メモが表示されます。',
  'tour.openTitle': '選んだ画像をダブルクリックしてください',
  'tour.openBody': 'ビューアが開き、矢印キーで前後の画像へ移動できます。',
  'tour.viewerTitle': 'ビューアを閉じて一覧へ戻ります',
  'tour.viewerBody': '右上の × をクリックしてください。Esc キーでも閉じられます。',
  'tour.viewerWaiting': '× または Esc で続行',
  'tour.memoTitle': '右側のメモ欄をクリックしてください',
  'tour.memoBody': 'ここに調べたことを残せます。今回は入力せず、クリックするだけで次へ進みます。',
  'tour.timelineTitle': 'サイドバー下部のタイムライン表示をクリックしてください',
  'tour.timelineBody': '画像が作品ごとの時系列にまとまり、流れを追いやすくなります。',
  'tour.searchTitle': '画面上部の検索欄をクリックしてください',
  'tour.searchBody': '作品名やメモに加えて、tag:、site:、type:、日付でも絞り込めます。',
  'tour.exit': 'ガイドを終了',
  'tour.skipStep': 'この操作を飛ばす',
  'tour.completed': '実操作ガイドが完了しました',
  'tour.offer': '最初のキャプチャができました。ライブラリの使い方も試しますか？',
  'tour.offerAction': '試してみる',

  // ── 設定モーダル ──
  'settings.tab.general': '基本',
  'settings.tab.capture': 'キャプチャ',
  'settings.tab.tag': 'タグ',
  'settings.tab.data': 'データ',
  'settings.tab.about': '情報',
  'settings.appearance': '外観',
  'settings.theme': 'テーマ',
  'settings.theme.system': 'システム',
  'settings.theme.dark': 'ダーク',
  'settings.theme.light': 'ライト',
  'settings.language': '言語',
  'settings.startup': '起動',
  'settings.startOnLogin': 'ログイン時に自動起動',
  'settings.extension': '拡張機能',
  'settings.extReloadNeeded': '再読み込みが必要',
  'settings.extConnected': '受信中',
  'settings.extDisconnected': '未受信',
  'settings.extReloadHint': 'ブラウザの拡張機能ページで再読み込みすると最新版が反映されます。',
  'settings.extStatusHint': '対応サイトの動画ページから Shiori に情報が届いているかを表示します。',
  'settings.extPort': '接続ポート: {port}',
  'settings.extPortBlocked': 'ポートを確保できません',
  // 拡張の入れ直しでもページの再読み込みでも直らない状態。原因がアプリの外（OS のポート予約）に
  // あることと、実際に効く手（PC の再起動）を先に伝える。
  'settings.extPortBlockedHint': '通信に使えるポートが空いていないため、ブラウザ拡張と接続できません。拡張の再インストールやページの再読み込みでは解消しません。Windows が起動時にポートを予約している場合は、PC を再起動すると解消することがあります。',
  'settings.services': '対応サービス',
  'settings.hotkey': 'ホットキー',
  'settings.captureHotkey': 'キャプチャホットキー',
  'settings.frameStep': 'コマ送り (, / .)',
  'settings.autoDetect': '自動検出',
  'settings.fpsHint': '自動検出オン：動画から計測 / オフ：固定 fps（アニメは約24、実写は約30）',
  'settings.notifications': '通知',
  'settings.notifyOnCapture': 'キャプチャ完了時に通知する',
  'settings.autoTagging': '自動タグ付け (WD Tagger)',
  'settings.autoTaggingHint': 'キャプチャ時にアニメ特化のAIがタグ候補を自動生成します。初回はモデルファイル（約600MB）のダウンロードが必要です。',
  'settings.taggerReady': '準備完了',
  'settings.deleteModel': 'モデルを削除',
  'settings.retagHint': 'AIタグが付いていない既存画像をまとめて処理します。',
  'settings.retagButton': '既存画像にタグ付け...',
  'settings.modelSaveHint': 'モデルをダウンロードすると、以後のキャプチャで自動タグ付けを使えます。',
  'settings.downloadModel': 'モデルをダウンロード',
  'settings.sidebarDisplay': 'サイドバー表示',
  'settings.showAiTags': 'AIタグもサイドバーに表示する',
  'settings.showAiTagsHint': 'オフの間は手動で付けたタグのみを表示します。オンにするとAIタグも表示されますが、手動タグを優先して上位に並べます。',
  'settings.storage': '保存場所',
  'settings.openCapturesFolder': 'フォルダを開く',
  'settings.storageHint': 'キャプチャと録画はすべてこのフォルダに保存されます。保存先は変更できません。',
  'settings.usage': '使用量',
  'settings.usageCalculating': '計算中...',
  'settings.usageFailed': '使用量を取得できませんでした',
  'settings.usageCounts': '画像 {images}枚 ／ 動画 {videos}本',
  'settings.usageCaptures': 'キャプチャ（原本）',
  'settings.usageThumbnails': 'サムネイル（消しても再生成されます）',
  'settings.usageDatabase': 'データベース',
  'settings.usageModel': 'AIモデル',
  'settings.usageModelAbsent': '未取得',
  'settings.exportHint': 'キャプチャ、タグ、メモ、録画のコマ精度情報、スマートフォルダをフォルダへ保存します（ローカルから取り込んだ画像は含まれません）。',
  'settings.stoppedCount.one': '{count}枚で中止しました',
  'settings.stoppedCount.other': '{count}枚で中止しました',
  'settings.exportFailed': 'エクスポートに失敗しました',
  'settings.exporting': 'エクスポート中...',
  'settings.exportLibrary': 'ライブラリをエクスポート...',
  'settings.import': 'インポート',
  'settings.importHint': '画像とメタデータをライブラリに追加します。取り込んだ画像は既存のキャプチャと区別され、取得日時にはインポートした時刻が使われます。同じフォルダを再度インポートすると重複します。',
  'settings.importErrorSuffix': '（エラー{count}件）',
  'settings.importFolderSuffix': '、スマートフォルダ{count}件',
  'settings.importedCount.one': '{count}枚をインポートしました',
  'settings.importedCount.other': '{count}枚をインポートしました',
  'settings.importFailed': 'インポートに失敗しました',
  'settings.importing': 'インポート中...',
  'settings.importLibrary': 'ライブラリをインポート...',
  'settings.thumbRepair': 'サムネイルの修復',
  'settings.thumbRepairHint': '一覧のサムネイルが表示されない画像がある場合に実行します。全画像を検査するため、枚数が多いと時間がかかります。',
  'settings.repairFailSuffix': '（{count}枚は失敗）',
  'settings.repairedCount.one': '{count}枚のサムネイルを再生成しました',
  'settings.repairedCount.other': '{count}枚のサムネイルを再生成しました',
  'settings.repairNoIssues': '問題は見つかりませんでした',
  'settings.repairFailed': '修復に失敗しました',
  'settings.repairing': '検査中...',
  'settings.repairButton': 'サムネイルを修復...',
  'settings.version': 'バージョン',
  'settings.credits': 'クレジット',
  'settings.creditIcons': 'アイコン: ',
  'settings.creditTagger': '自動タグ付け: ',
  'settings.creditVideo': '動画処理: ',
  'settings.creditsHint': '各ライセンスの詳細は配布物に同梱の NOTICE.md を参照してください。',

  // ── Web デモ版（GitHub Pages）専用 ────────────────────────────
  // デスクトップ本体には存在しない画面なので、他の領域からは参照されない。
  'demo.welcome': 'Web デモ版です。表示・検索・タグ編集は実際に動きますが、キャプチャや録画などデスクトップ機能は使えません。編集内容はリロードで消えます。',
  'demo.unavailable': 'デモ版では利用できません（デスクトップアプリの機能です）',
  // 素材を 1 件も置いていないときの第一画面。デスクトップ版の初回案内（拡張機能フォルダを
  // 開く → 対応サイトで動画を開く → ホットキー）はデモでは全部空振りするので差し替える。
  'demo.emptyTitle': 'このデモには、まだ素材が置かれていません',
  'demo.emptyHint': 'Shiori は、配信中のアニメを研究用途で記録するデスクトップアプリです。このデモでは実際の画面をブラウザで操作でき、表示・検索・タグ編集を試せます。配信画面のキャプチャはデモに掲載できないため、現在ライブラリは空です。',
  'demo.emptyRepo': 'GitHub でプロジェクトを見る',
} as const
