# Netflix コマ送り（Shift+←/→）で別PCがエラー画面になる件 — 原因候補メモ

- 症状: 別PCで Netflix 再生中に `Shift+←/→`（コマ送り）を押すと **Netflix自身のエラー画面**（「問題が発生しました」／エラーコード表示）が出る。
- 環境: 別PCのブラウザは **Chrome**。作業PCでは問題なし。
- 前提: このメモは「直す前の原因切り分け」用。**コードは未修正**。

## 処理の流れ（復習）

1. [content.js:994-1004](extension/content.js#L994-L1004) が `Shift+←/→` を捕捉し `preventDefault` / `stopPropagation`。
2. Netflixのときは DOM直叩きではなく `netflixCmd('pause')` / `netflixCmd('seek', ms)` で
   `shiori-nflx-cmd` CustomEvent を発火（[content.js:90-101](extension/content.js#L90-L101)）。
3. **MAIN world** に注入された [netflix-main.js](extension/netflix-main.js) が受信し、Netflix内部プレイヤーAPI
   `player.pause()` / `player.seek(ms)` を呼ぶ（[netflix-main.js:27-42](extension/netflix-main.js#L27-L42)）。
4. さらに [content.js:980-992](extension/content.js#L980-L1004) の `startStepGuard` が **50ms間隔・最大1秒**、
   `pauseVideo`（=内部API `pause()`）を連打して着地後の再生を止める。

「Netflixのエラー画面」が出るということは、**内部API `seek()`/`pause()` は実際に呼ばれていて、
Netflix側の状態機械がそれを不正とみなしている**可能性が高い（＝ブリッジは注入されている前提）。

---

## 原因候補（可能性の高い順）

### 候補A: `getPlayer()` が「今再生中でないセッション」を掴んでいる ★本命
[netflix-main.js:16-21](extension/netflix-main.js#L16-L21) はセッションIDから `'watch'` を含むものを優先し、
無ければ**配列の最後**を使う。

```js
const id = ids.find((x) => typeof x === 'string' && x.includes('watch')) ?? ids[ids.length - 1]
```

- 別PC＝別アカウント/別視聴履歴だと、前作品の残骸セッションや複数 `watch-` セッションが並び、
  **実際に画面に映っているのとは別のセッションを掴んで `seek()`** → Netflixが不整合を検知してエラー画面、という筋。
- 作業PCではたまたまセッションが1つ／正しい順序だったので露見していない可能性。
- **確認方法**: 別PCのDevToolsコンソール（MAIN world）で
  `netflix.appContext.state.playerApp.getAPI().videoPlayer.getAllPlayerSessionIds()` を実行し、
  返る配列を見る。複数あるか、`watch` を含むIDが本当に再生中のものか確認。

### 候補B: DRM / Widevine セキュリティレベルの差でシークが失敗 ★環境差の本命
Netflixのエラー画面はシーク時のライセンス再取得失敗で出やすい。DRM周りは**PCごとに差が大きい**:

- Widevine L1（ハードウェアDRM）/ L3（ソフト）の違い
- GPUドライバ・ハードウェアデコード可否
- 高解像度プロファイルの有無

別PCがこれらで異なると、内部 `seek()` が Netflix のライセンス/バッファ再構築を誘発して失敗 → エラー画面。
`seek()` は非同期で Netflix内部の描画パイプラインを進めるため、**[netflix-main.js:39](extension/netflix-main.js#L39) の
try/catch では捕まえられない**（同期例外しか捕捉できない）点に注意。

- **確認方法**: 別PCで `Shift+←/→` 押下直後にエラーになるか、それとも数フレーム進んでからか。
  再生画質（Ctrl+Shift+Alt+D のNetflixデバッグ表示）で解像度/DRMを作業PCと比較。

### 候補C: `startStepGuard` の pause連打が状態機械を刺激
[content.js:980-992](extension/content.js#L980-L992) が内部API `pause()` を **1秒間で最大20回**連打する。
Netflixの内部プレイヤーは連続 pause/seek に敏感で、環境によっては
「不正な操作シーケンス」と判定してエラーになり得る。作業PCとの差（マシン速度でseek着地の速さが変わり、
連打とseekの噛み合わせが変わる）で顕在化する可能性。

- **確認方法**: 一時的に `startStepGuard` を無効化（またはNetflixでは連打しない）にして再現するか切り分け。

### 候補D: シーク先が範囲外（先頭直前 / 末尾直後 / 広告・イントロ区間）
[content.js:103-122](extension/content.js#L103-L122) の `stepFrame` は `currentTime` 基準で目標時刻を算出。

- 末尾付近で前方ステップ → **尺を超えるms** を `seek()` に渡す → Netflixがエラー。
- 広告つきプラン／イントロ・エピローグの特殊区間でのシークが弾かれる。
- 別PCが広告つきプランだと、この区間差で顕在化しやすい。
- 注: 先頭方向は `seekVideo` 内 `Math.max(0, …)` でクランプ済みだが、**上限クランプは無い**
  （[content.js:97-101](extension/content.js#L97-L101)）。

### 候補E: MAIN world 注入の不発（Chromeが古い場合のみ）
[manifest.json:52-57](extension/manifest.json#L52-L57) の `"world": "MAIN"` は **Chrome 111+** 必須。
別PCのChromeがそれ未満だと netflix-main.js が注入されず、content.js の `preventDefault` だけが効く。

- ただしこの場合、内部APIは呼ばれないので **「Netflixのエラー画面」ではなく「無反応」** になるはず。
  今回の症状（エラー画面）とは合いにくいため**優先度低**。ただし別PCのChromeバージョンは要確認
  （`chrome://version`）。111未満なら別の不具合として除外/対処。

### 候補F: ブリッジ未ロード時に content.js が native を潰す副作用
候補Eの派生。ブリッジが無い状態でも [content.js:994](extension/content.js#L994) は
`preventDefault`/`stopPropagation` するため、Netflix純正操作を阻害する。これ単体では
エラー画面にならないが、他要因と重なると挙動不審の一因になり得る。

---

## 切り分けチェックリスト（別PC側で実施）

- [ ] `chrome://version` でChromeのバージョン（111以上か）
- [ ] 拡張が有効か、Netflixタブで netflix-main.js が MAIN world にロードされているか
- [ ] DevToolsコンソールで `getAllPlayerSessionIds()` の中身（複数/watch有無）
- [ ] エラーが出るのは「押した瞬間」か「数フレーム後」か
- [ ] エラーコード（M7xxx=ブラウザ/DRM系, S7xxx=ストリーミング系 など）を控える
- [ ] 広告つきプランか / 特殊区間（イントロ・OP・ラスト）で起きやすいか
- [ ] 通常再生（コマ送りせず普通のシーク）は正常か → 正常ならコマ送り経路固有

## 現時点の見立て

エラー**画面**が出る＝内部APIは動いている前提なら、**候補A（誤セッション掴み）**か
**候補B（DRM/環境差でのseek失敗）**が最有力。まずは別PCの `getAllPlayerSessionIds()` と
Netflixエラーコードを取得できれば、AとBを一気に切り分けられる。

*（このメモは原因整理のみ。修正方針が固まったら別途対応する。）*
