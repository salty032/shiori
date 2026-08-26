// DB の作り（スキーマ・移行）と起動処理。**ここだけが接続を開き、列を足す。**
// クエリは db.ts（画像）・db-tags.ts（タグ）・db-video-frames.ts（フレーム表）にある。
import Database from 'better-sqlite3'
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { buildSearchText, SEARCH_NORMALIZE_VERSION } from '../shared/normalize'
import {
  DatabaseCorruptError, DatabaseMigrationBackupError, SCHEMA_VERSION, assertSchemaCompatible,
  backupDatabase, backupIsDue, integrityProblem, pruneBackups, readSchemaVersion,
  writeSchemaVersion, type SqlRunner
} from './system/db-maintenance'
import { prepare, setDatabase } from './db-core'

let db: Database.Database

// 列を足すときはここを通す。**足したら db-maintenance.ts の SCHEMA_VERSION も上げること。**
// 上げないと、作りを変える前の退避（backups/）が取られないまま ALTER が走る。
function addColumnIfMissing(sql: string): void {
  try {
    db.exec(sql)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 列が既に存在する（＝このマイグレーションは実行済み）以外のエラーは、ディスクフル・
    // 破損等で ALTER が本当に失敗したことを意味する。ここを warn で握りつぶすと、
    // 一部の列が欠けた半端なスキーマのまま起動が続行し、後続クエリが不可解に壊れる。
    // throw して initDb 呼び出し元（bootstrap.ts）の起動失敗ダイアログに乗せる（N-2）。
    if (!/duplicate column/i.test(message)) throw err
  }
}

// FTS5 の索引と content テーブル（images）が食い違ったときに出るエラーか。
//
// メッセージは "database disk image is malformed" で、DB ファイルそのものの破損と区別が
// 付かない（実際には DB は健全で `integrity_check` も通る）。見分けが付くのはエラーコードだけ
// で、仮想テーブル由来なら SQLITE_CORRUPT_VTAB になる。索引を作り直せば直る種類の故障なので、
// ファイル破損として諦めるのではなく復旧を試みるために判別する。
function isCorruptVtabError(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    (err as { code?: unknown }).code === 'SQLITE_CORRUPT_VTAB'
}

/** userData 直下の DB 本体。退避・復元の宛先を決めるのに bootstrap 側からも使う */
export function databasePath(): string {
  return join(app.getPath('userData'), 'Shiori.db')
}

// 退避処理が失敗したことをウィンドウ準備後に伝えるための持ち越し。設定ファイルの破損
// （settings.ts の consumeCorruptSettingsNotice）と同じ持ち方。退避が取れなかったこと自体は
// 起動を止める理由にならないが、黙っていると「取れているつもり」で使い続けることになる。
let _backupFailed = false

export function consumeDbBackupFailure(): boolean {
  const v = _backupFailed
  _backupFailed = false
  return v
}

function sqlRunner(): SqlRunner {
  return {
    pragma: (sql) => db.pragma(sql, { simple: true }) as string | number | null,
    exec: (sql) => { db.exec(sql) }
  }
}

export function initDb(): void {
  const dbPath = databasePath()
  // 新規インストールかどうかは開く前にしか分からない（new Database が空のファイルを作る）。
  // 中身の無い DB を退避しても意味が無いので、ここで見ておく。
  const isNewDatabase = !existsSync(dbPath)
  db = new Database(dbPath)
  // ステートメントのキャッシュは接続に紐づくため、張り直したらここで捨てる（setDatabase の中）。
  setDatabase(db)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // WAL 併用時は NORMAL で十分な耐久性があり、書き込みが速くなる（キャプチャ連打時に効く）
  db.pragma('synchronous = NORMAL')
  // 読み取りキャッシュを 16MB に拡大（負値は KB 指定）。一覧スクロール・フィルタ集計が軽くなる
  db.pragma('cache_size = -16000')
  // 一時テーブル・ソートをメモリ上で処理（ORDER BY / GROUP BY が速くなる）
  db.pragma('temp_store = MEMORY')

  const runner = sqlRunner()
  // 開けたことと壊れていないことは別。ここを通さないと、壊れたファイルへ以降の移行と
  // 書き込みを重ねてしまい、気づいたときには退避も上書き済みになる。壊れていたら
  // 呼び出し元（bootstrap.ts）が復元を提案するので、ここでは閉じて投げるだけにする。
  const problem = integrityProblem(runner)
  if (problem) {
    db.close()
    throw new DatabaseCorruptError(problem)
  }

  // 退避を取る理由は 2 つある。
  //   1. **作りを変える前**。以降の CREATE / ALTER が途中で落ちても戻せるように。
  //   2. **日々の使用中**。1 の条件だけだと、スキーマが安定している間は何か月も退避が
  //      取られない。タグ・メモ・タイムシートは手で積んだもので撮り直しが効かないのに、
  //      戻せる先が「最後にスキーマを変えた日」になってしまう。1 日 1 世代取る。
  //
  // どちらも上の integrityProblem を通った後にしか来ない。**この順序が肝心**で、
  // 壊れた中身を世代へ流し込むと数日で健全な世代が押し出され、退避が全滅する。
  const storedVersion = readSchemaVersion(runner)
  try {
    assertSchemaCompatible(storedVersion, SCHEMA_VERSION)
  } catch (err) {
    // 旧版で新しいDBを開いたままにしない。以降には毎起動の索引再構築もあるため、
    // 「移行しなければ安全」ではなく、ここを読み書き処理すべてのゲートにする。
    db.close()
    throw err
  }
  const schemaWillChange = storedVersion < SCHEMA_VERSION
  if (!isNewDatabase && schemaWillChange) {
    try {
      backupDatabase(runner, dbPath, new Date())
      pruneBackups(dbPath)
    } catch (err) {
      // 構造変更の前だけは退避が必須。ここで続行すると、まさに戻したい移行失敗時に
      // 戻り先が無い。DBにはまだ何も変更していないので、閉じてそのまま残す。
      db.close()
      throw new DatabaseMigrationBackupError(dbPath, { cause: err })
    }
  } else if (!isNewDatabase && backupIsDue(dbPath, new Date())) {
    try {
      backupDatabase(runner, dbPath, new Date())
      pruneBackups(dbPath)
    } catch (err) {
      // 日次退避の失敗はデータ構造を変えないため、使用は続けて画面で注意する。
      console.warn('[db] daily backup failed', err)
      _backupFailed = true
    }
  }

  // CREATE / ALTER / FTS再構築 / backfill / user_version の確定を1単位にする。
  // 電源断や例外で途中までしか適用されても、次回起動が半端なスキーマを使い続けない。
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      filepath     TEXT    NOT NULL UNIQUE,
      captured_at  INTEGER NOT NULL,
      title        TEXT,
      current_time REAL,
      url          TEXT,
      width        INTEGER,
      height       INTEGER,
      colors       TEXT,
      memo         TEXT,
      thumb_path   TEXT,
      media_type   TEXT,
      duration     REAL
    );
    CREATE TABLE IF NOT EXISTS tags (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS image_tags (
      image_id INTEGER NOT NULL,
      tag_id   INTEGER NOT NULL,
      source   TEXT NOT NULL DEFAULT 'manual',
      PRIMARY KEY (image_id, tag_id),
      FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id)   REFERENCES tags(id)   ON DELETE CASCADE
    );
    -- 録画クリップのフレーム表。素材の1コマごとに「素材上の時刻」と「ファイル内の
    -- 何枚目に写っているか」を持つ。コマ送りを素材の実コマへ揃えるための土台。
    --
    -- images に持たせず別テーブルにするのは、1クリップで数百〜千数百要素の JSON になり、
    -- グリッド一覧のような images を舐めるクエリを不必要に重くするため。
    -- image_id を主キーにすることで 1 クリップ 1 行を保証する。
    CREATE TABLE IF NOT EXISTS video_frames (
      image_id INTEGER PRIMARY KEY,
      data     TEXT NOT NULL,
      FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
    );
    -- 手で打ったタイムシート（セル替わりのコマとメモ）。video_frames と同じ理由で別テーブル
    -- （1 クリップで数百組になりうる JSON なので images を舐めるクエリに載せない）。
    --
    -- **video_frames とは別に持つ。** 表は解析でいつでも作り直せるが、こちらは人が 1 コマずつ
    -- 見て打った手作業で、作り直しが利かない。表を使わないと決めた（markVideoFramesUnusable）ときも道連れにしない。
    CREATE TABLE IF NOT EXISTS timesheets (
      image_id INTEGER PRIMARY KEY,
      data     TEXT NOT NULL,
      FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
    );
    -- ライブラリの中身ではなく「この DB に何をどう適用済みか」を持つ小さな表。
    -- 列の有無やテーブルの有無を見れば分かるもの（＝この DB の既存の「見て直す」idiom で
    -- 済むもの）はここに書かない。書くのは、見ただけでは分からない適用状態だけ
    -- （現在は search_text をどの正規化ルールで作ったか）。
    CREATE TABLE IF NOT EXISTS app_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_images_captured_at ON images(captured_at);
    CREATE INDEX IF NOT EXISTS idx_image_tags_image   ON image_tags(image_id);
    CREATE INDEX IF NOT EXISTS idx_image_tags_tag     ON image_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_image_tags_source  ON image_tags(source);
  `)
  addColumnIfMissing('ALTER TABLE images ADD COLUMN url TEXT')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN colors TEXT')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN memo TEXT')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN thumb_path TEXT')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN media_type TEXT')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN duration REAL')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN fps REAL')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN host TEXT')
  addColumnIfMissing("ALTER TABLE images ADD COLUMN source TEXT NOT NULL DEFAULT 'capture'")
  // 素材のコマのうち、自分の表示区間内に絵を撮れなかった枚数。
  // 画面キャプチャの供給が素材の2倍に届かないと発生し、絵の変わり目に当たると
  // コマ打ちの数を誤る。研究用途では黙って間違えるのが最悪なので数として保持し、
  // 詳細パネルに出す。NULL はコマ精度の情報が無いクリップ（従来のもの・非対応サイト）。
  addColumnIfMissing('ALTER TABLE images ADD COLUMN uncaptured_frames INTEGER')
  // 検索用の正規化済みテキスト（"normalize(title)\nnormalize(memo)"）。SQLite に NFKC も
  // Unicode プロパティ判定も無いため、正規化は書き込み側（insertImage/updateImageTitle/
  // updateImageMemo）の JS で行い、結果をここへ書く（docs/SPEC.md 5章）。
  addColumnIfMissing('ALTER TABLE images ADD COLUMN search_text TEXT')
  // 上記のうち「前後で絵が変わっており、どのコマで変わったか特定できない」枚数。
  // 撮り逃したコマの大半は同じ絵が続く区間に当たっており実害が無い。それを区別せず
  // 全部を「未取得」と出すと、本当に数え直しが要る数コマが埋もれる。
  // NULL は「まだ検証していない」（保存直後・検証に失敗したクリップ・従来の行）。
  addColumnIfMissing('ALTER TABLE images ADD COLUMN ambiguous_frames INTEGER')
  // 素材のコマ総数（フレーム表の行数）。上の 2 つが「多いのか少ないのか」を言うには母数が要る。
  // fps × duration で見積もれはするが、duration は録画停止までのラグを含むうえ fps の無い行では
  // 母数そのものが出せず、判定が黙って効かなくなる。**実測が使えるならそれを使う**。
  // NULL は表を持たないクリップ（従来の行・非対応サイト）で、そのときだけ見積もりへ落ちる。
  addColumnIfMissing('ALTER TABLE images ADD COLUMN source_frames INTEGER')
  // 素材にあったはずなのに、配信ページから通知が来なかったコマ数（frame-feed の reportDrops）。
  // **撮り逃し（uncaptured_frames）より悪い**——表に入っていないので上の割合の分母にも
  // 入らない。実測（60fps 素材）では captured 89.3% の裏で素材の 2 割が表に無かった。
  // 画面とログで同じ数字を出すために、見積もりではなく測った値をここへ持つ。
  addColumnIfMissing('ALTER TABLE images ADD COLUMN unreported_frames INTEGER')
  addColumnIfMissing('ALTER TABLE images ADD COLUMN misaligned_frames INTEGER')
  // 取り込んだ素材の、送り主が記録していた取得時間。captured_at は取り込んだ時刻に
  // そろえてしまう（他人の素材が自分のキャプチャと日付順で混ざるのを避けるため）ので、
  // 元の時刻を捨てないためにここへ退避する。NULL は自分で撮った素材。
  addColumnIfMissing('ALTER TABLE images ADD COLUMN original_captured_at INTEGER')
  db.exec('CREATE INDEX IF NOT EXISTS idx_images_host ON images(host)')
  // カーソルページング・ホスト絞り込み・エクスポートで使う複合インデックス
  db.exec('CREATE INDEX IF NOT EXISTS idx_images_cat       ON images(captured_at, id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_images_host_cat  ON images(host, captured_at, id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_images_src_cat   ON images(source, captured_at)')
  // タグ絞り込みで source + tag_id を同時に参照するケース向け
  db.exec('CREATE INDEX IF NOT EXISTS idx_image_tags_src_tag ON image_tags(source, tag_id)')

  // search_text 検索用の FTS5 仮想テーブル（外部コンテンツ = images）。ライブラリが数万件規模に
  // なっても LIKE '%...%' のような毎回フルスキャンにならないよう、検索専用のインデックスを持つ。
  // トークナイザは trigram を使う：unicode61 だと分かち書きされない日本語がまるごと1トークンに
  // なり部分一致検索が壊れるため、文字3-gram単位でインデックスする trigram の方が、日本語混じりの
  // タイトル/メモに対しても従来の LIKE 部分一致に近い挙動を保てる。
  //
  // 索引する列は title/memo ではなく search_text（正規化済み・詳細は docs/SPEC.md 5章）。
  // 旧スキーマ（title/memo を直接索引していた版、テーブル名 images_fts）は列構成が違うので使わない。
  //
  // 新スキーマを images_fts_v2 という別名にしてあるのは、**旧トリガーと新テーブルの食い違いを
  // 構造的に起こさないため**。同じ名前で作り替えると、DROP TABLE では消えない旧トリガー
  // （title/memo を INSERT する版）が一瞬でも新しい1列テーブルに向く窓ができ、その間の書き込みが
  // 落ちる。名前を分ければ、旧トリガーが残っていても向き先は消えた旧テーブルのままで、
  // 新旧が混ざらない。トリガー自体も下で3系統とも作り直している。
  //
  // 注：ここには当初「同名で再 CREATE すると FTS5 のシャドウテーブルが壊れ、以降の書き込みが
  // SQLITE_CORRUPT_VTAB で失敗する」と書いてあったが、**その現象は隔離環境で再現しなかった**
  // （旧構成で作った FTS5 を DROP → 同名・別カラム構成で CREATE → 書き込み・検索・トリガー更新・
  // integrity_check まで、この版の better-sqlite3 で全て正常）。壊れたように見えたのは上の
  // トリガー食い違いの方だと考えられる。別名にする判断自体は据え置く（実害が無く、旧版へ
  // 戻したときも旧 images_fts が独立に作り直されるため）。
  db.exec('DROP TABLE IF EXISTS images_fts')
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS images_fts_v2 USING fts5(
      search_text, content='images', content_rowid='id', tokenize='trigram'
    );
  `)
  // 列構成やトリガー条件の変更を確実に反映するため、3系統とも毎回 DROP してから作り直す。
  // 冪等なので何度実行しても害はない。
  db.exec(`
    DROP TRIGGER IF EXISTS images_fts_ai;
    CREATE TRIGGER images_fts_ai AFTER INSERT ON images BEGIN
      INSERT INTO images_fts_v2(rowid, search_text) VALUES (new.id, new.search_text);
    END;
    DROP TRIGGER IF EXISTS images_fts_ad;
    CREATE TRIGGER images_fts_ad AFTER DELETE ON images BEGIN
      INSERT INTO images_fts_v2(images_fts_v2, rowid, search_text) VALUES('delete', old.id, old.search_text);
    END;
    DROP TRIGGER IF EXISTS images_fts_au;
    CREATE TRIGGER images_fts_au AFTER UPDATE OF search_text ON images BEGIN
      INSERT INTO images_fts_v2(images_fts_v2, rowid, search_text) VALUES('delete', old.id, old.search_text);
      INSERT INTO images_fts_v2(rowid, search_text) VALUES (new.id, new.search_text);
    END;
  `)
  // search_text 未計算の行（列を足した直後の既存ユーザー・旧FTSからの移行・書き込み経路の
  // 漏れ）を起動のたびに埋める。上の au トリガー経由で images_fts_v2 にも自動で反映されるため、
  // images_fts_v2 への一括流し込みを別に行う必要はない。
  //
  // 加えて、正規化ルール（normalizeSearchText）を変えたときは**未計算の行だけでは足りない**。
  // 既存の行は古いルールで作った文字列を持ったまま残るのに、検索語は新ルールで正規化される
  // ため、同じ語が「古い行には当たらないが新しい行には当たる」状態になる。当たり外れが行ごと
  // に変わるのは、この機能が潰そうとしている「説明の付かない検索結果」そのもの。ルールの版が
  // 上がっていたら全行作り直す（SEARCH_NORMALIZE_VERSION の値だけが判断材料）。
  const appliedNormalizeVersion = (
    prepare("SELECT value FROM app_meta WHERE key = 'search_normalize_version'").get() as
      { value: string } | undefined
  )?.value
  const rebuildAllSearchText = appliedNormalizeVersion !== String(SEARCH_NORMALIZE_VERSION)

  // FTS5 の索引を content テーブル（images）から丸ごと作り直す。
  //
  // 外部コンテンツの FTS5 は索引を自分で持ち、content 側とはトリガーでしか同期しない。
  // 何らかの理由で両者が食い違うと、`_au` / `_ad` トリガーの 'delete'（old.search_text の
  // トークンを索引から消す操作）が「索引に無いものを消す」ことになり、**SQLITE_CORRUPT_VTAB
  // ＝ database disk image is malformed で書き込みが全て失敗する**。DB 自体は健全で
  // `integrity_check` も通るため、この状態は外からは壊れて見えない。
  //
  // 実際に踏んだ（2026-08-10）：images.search_text は全行 NULL なのに索引には中身が残っており、
  // 起動時の search_text 書き直しが毎回この例外で落ちて、アプリが起動できなくなっていた。
  // 版の記録（app_meta）は書き直しの後に置くコミットマーカーなので、一度こうなると
  // 毎起動で同じ失敗を繰り返して自力では抜けられない。
  const rebuildFtsIndex = (): void => {
    try {
      db.exec("INSERT INTO images_fts_v2(images_fts_v2) VALUES('rebuild')")
    } catch (err) {
      // 索引の作り直しすら通らないなら、仮想テーブルごと作り直す（中身は content から
      // 復元されるので失われるものは無い）。
      console.warn('[db] FTS rebuild failed, recreating the table', err)
      db.exec('DROP TABLE IF EXISTS images_fts_v2')
      db.exec(`
        CREATE VIRTUAL TABLE images_fts_v2 USING fts5(
          search_text, content='images', content_rowid='id', tokenize='trigram'
        );
      `)
      db.exec("INSERT INTO images_fts_v2(images_fts_v2) VALUES('rebuild')")
    }
  }

  // 正規化ルールの版が上がったなら、索引の中身は結局すべて作り直しになる。書き直しの前に
  // ここで作り直しておけば、食い違いが残っていても以降の UPDATE が安全に通る。
  if (rebuildAllSearchText) rebuildFtsIndex()

  const pendingSearch = prepare(
    rebuildAllSearchText
      ? 'SELECT id, title, memo FROM images'
      : 'SELECT id, title, memo FROM images WHERE search_text IS NULL'
  ).all() as { id: number; title: string | null; memo: string | null }[]
  if (pendingSearch.length > 0) {
    const setSearchText = prepare('UPDATE images SET search_text = ? WHERE id = ?')
    const writeAll = db.transaction(() => {
      for (const { id, title, memo } of pendingSearch) {
        setSearchText.run(buildSearchText(title, memo), id)
      }
    })
    try {
      writeAll()
    } catch (err) {
      // 版が据え置きのまま食い違いが生じた場合（上の rebuild を通っていない経路）の保険。
      // 索引を作り直してから一度だけやり直す。ここで諦めると起動できないまま詰むため、
      // 「壊れた索引を直して進む」方を選ぶ。
      if (!isCorruptVtabError(err)) throw err
      console.warn('[db] search_text write hit a corrupt FTS index; rebuilding the index and retrying', err)
      rebuildFtsIndex()
      writeAll()
    }
  }
  // 版の記録は作り直しが終わってから。途中で落ちた場合は記録が残らず、次回起動でやり直す
  // （拡張の同期で manifest.json を最後に置くのと同じ、コミットマーカーの置き方）。
  if (rebuildAllSearchText) {
    prepare(
      `INSERT INTO app_meta (key, value) VALUES ('search_normalize_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(String(SEARCH_NORMALIZE_VERSION))
  }

  // 既存レコードの host を backfill（初回のみ実行される）
  const rows = prepare("SELECT id, url FROM images WHERE host IS NULL AND url IS NOT NULL").all() as { id: number; url: string }[]
  const setHost = prepare('UPDATE images SET host = ? WHERE id = ?')
  const backfill = db.transaction(() => {
    for (const { id, url } of rows) {
      // URL 不正時は host='' で「処理済み・ホストなし」を記録し、毎起動の再スキャンを防ぐ
      try { setHost.run(new URL(url).hostname.replace(/^www\./, ''), id) } catch { setHost.run('', id) }
    }
  })
  backfill()

  // 版の記録は移行が全部通ってから。途中で落ちれば記録は残らず、次回起動で退避から
  // やり直す（search_normalize_version と同じコミットマーカーの置き方）。
    if (schemaWillChange) writeSchemaVersion(runner, SCHEMA_VERSION)
    db.exec('COMMIT')
  } catch (err) {
    if (db.inTransaction) {
      try { db.exec('ROLLBACK') } catch (rollbackErr) {
        console.error('[db] schema migration rollback failed', rollbackErr)
      }
    }
    db.close()
    throw err
  }
}
