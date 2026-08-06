/**
 * Zaim → D1 の全件同期。
 *
 * Python 版はテンポラリ DB を構築して `os.replace` で差し替えていたが、
 * D1 にはファイル差し替えに相当する操作がない。代わりに
 * 「別テーブルに全件構築 → DROP + RENAME を単一バッチで実行」する。
 * D1 の batch() は単一トランザクションとして実行されるため、
 * 読み手は旧テーブルか新テーブルのどちらか一方だけを見る。
 */

import { ZaimClient, type ZaimMaster, type ZaimMoney } from "./zaim";

/** 1 回の batch() に載せるステートメント数。D1 の 1 バッチ上限に対する安全側の値。 */
const BATCH_SIZE = 100;

/** 同期の所要時間内訳（ミリ秒）。CPU 時間の見積もりに使う。 */
export interface SyncTimings {
  /** Zaim API の取得（ネットワーク待ちを含む）。 */
  fetchMs: number;
  /** JSON からバインド配列への変換。ほぼ純粋な CPU 時間。 */
  transformMs: number;
  /** D1 への書き込み。 */
  writeMs: number;
  /** テーブル差し替え。 */
  swapMs: number;
  /** 全体。 */
  totalMs: number;
}

/** 同期結果の件数と所要時間。 */
export interface SyncResult {
  transactions: number;
  categories: number;
  genres: number;
  accounts: number;
  timings: SyncTimings;
}

/** 明細テーブルの列定義（新規テーブル名を差し込んで使う）。 */
function transactionsDdl(table: string): string {
  return `CREATE TABLE ${table} (
    id              INTEGER PRIMARY KEY,
    mode            TEXT    NOT NULL,
    date            TEXT    NOT NULL,
    amount          INTEGER NOT NULL,
    category_id     INTEGER,
    genre_id        INTEGER,
    from_account_id INTEGER,
    to_account_id   INTEGER,
    name            TEXT,
    place           TEXT,
    comment         TEXT,
    currency_code   TEXT,
    receipt_id      INTEGER,
    active          INTEGER,
    created         TEXT,
    raw             TEXT    NOT NULL
  )`;
}

/** マスタテーブルの列定義。3 マスタで形が同じなので共通化する。 */
function masterDdl(table: string): string {
  return `CREATE TABLE ${table} (
    id     INTEGER PRIMARY KEY,
    raw    TEXT NOT NULL
  )`;
}

/**
 * ステートメントを一定数ずつ batch() に流す。
 *
 * @param db D1 データベース。
 * @param statements 実行するステートメント。
 */
async function runInBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await db.batch(statements.slice(i, i + BATCH_SIZE));
  }
}

/**
 * Zaim から全件取得して D1 を再構築する。
 *
 * @param db D1 データベース。
 * @param client Zaim クライアント。
 * @returns 件数と所要時間の内訳。
 */
export async function syncAll(db: D1Database, client: ZaimClient): Promise<SyncResult> {
  const t0 = Date.now();
  let fetchMs = 0;
  let transformMs = 0;
  let writeMs = 0;

  // 作業用テーブルを作り直す
  await db.batch([
    db.prepare("DROP TABLE IF EXISTS transactions_new"),
    db.prepare("DROP TABLE IF EXISTS categories_new"),
    db.prepare("DROP TABLE IF EXISTS genres_new"),
    db.prepare("DROP TABLE IF EXISTS accounts_new"),
    db.prepare(transactionsDdl("transactions_new")),
    db.prepare(masterDdl("categories_new")),
    db.prepare(masterDdl("genres_new")),
    db.prepare(masterDdl("accounts_new")),
  ]);

  const insertTx = db.prepare(
    `INSERT INTO transactions_new
     (id, mode, date, amount, category_id, genre_id, from_account_id, to_account_id,
      name, place, comment, currency_code, receipt_id, active, created, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let transactions = 0;
  for await (const page of timedPages(client, (ms) => (fetchMs += ms))) {
    const t = Date.now();
    const statements = page.map((row: ZaimMoney) =>
      insertTx.bind(
        row.id,
        row.mode,
        row.date,
        row.amount,
        row.category_id ?? null,
        row.genre_id ?? null,
        row.from_account_id ?? null,
        row.to_account_id ?? null,
        row.name ?? null,
        row.place ?? null,
        row.comment ?? null,
        row.currency_code ?? null,
        row.receipt_id ?? null,
        row.active ?? null,
        row.created ?? null,
        JSON.stringify(row),
      ),
    );
    transformMs += Date.now() - t;

    const w = Date.now();
    await runInBatches(db, statements);
    writeMs += Date.now() - w;
    transactions += page.length;
  }

  // マスタ 3 種
  const f = Date.now();
  const [categories, genres, accounts] = await Promise.all([
    client.categories(),
    client.genres(),
    client.accounts(),
  ]);
  fetchMs += Date.now() - f;

  const masters: [string, ZaimMaster[]][] = [
    ["categories_new", categories],
    ["genres_new", genres],
    ["accounts_new", accounts],
  ];
  for (const [table, rows] of masters) {
    const stmt = db.prepare(`INSERT INTO ${table} (id, raw) VALUES (?, ?)`);
    const t = Date.now();
    const statements = rows.map((row) => stmt.bind(row.id, JSON.stringify(row)));
    transformMs += Date.now() - t;

    const w = Date.now();
    await runInBatches(db, statements);
    writeMs += Date.now() - w;
  }

  // 差し替え。DROP → RENAME → インデックス再作成を単一トランザクションで行う
  const s = Date.now();
  await db.batch([
    db.prepare("DROP TABLE IF EXISTS transactions"),
    db.prepare("DROP TABLE IF EXISTS categories"),
    db.prepare("DROP TABLE IF EXISTS genres"),
    db.prepare("DROP TABLE IF EXISTS accounts"),
    db.prepare("ALTER TABLE transactions_new RENAME TO transactions"),
    db.prepare("ALTER TABLE categories_new RENAME TO categories"),
    db.prepare("ALTER TABLE genres_new RENAME TO genres"),
    db.prepare("ALTER TABLE accounts_new RENAME TO accounts"),
    db.prepare("CREATE INDEX idx_tx_date ON transactions (date)"),
    db.prepare("CREATE INDEX idx_tx_mode_date ON transactions (mode, date)"),
    db.prepare("CREATE INDEX idx_tx_category ON transactions (category_id)"),
    db.prepare("CREATE INDEX idx_tx_from_account ON transactions (from_account_id)"),
    db.prepare("CREATE INDEX idx_tx_to_account ON transactions (to_account_id)"),
  ]);
  const swapMs = Date.now() - s;

  return {
    transactions,
    categories: categories.length,
    genres: genres.length,
    accounts: accounts.length,
    timings: { fetchMs, transformMs, writeMs, swapMs, totalMs: Date.now() - t0 },
  };
}

/**
 * 明細ページを取得しつつ、取得に要した時間だけを切り出して計測する。
 *
 * @param client Zaim クライアント。
 * @param report 1 ページあたりの取得ミリ秒を受け取るコールバック。
 * @yields 明細のリスト（1 ページ分）。
 */
async function* timedPages(
  client: ZaimClient,
  report: (ms: number) => void,
): AsyncGenerator<ZaimMoney[]> {
  const iterator = client.iterMoney();
  for (;;) {
    const t = Date.now();
    const { value, done } = await iterator.next();
    report(Date.now() - t);
    if (done) return;
    yield value;
  }
}
