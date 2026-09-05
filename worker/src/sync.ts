/**
 * Zaim → ミラー DB の全件同期。
 *
 * D1 にはファイル差し替えに相当する操作がないため、
 * 「別テーブルに全件構築 → DROP + RENAME を単一バッチで実行」する。
 * batch() は単一トランザクションとして実行されるため、途中で失敗しても
 * 旧テーブルがそのまま残る（失敗時にロールバックされることは検証済み）。
 */

import type { Database, PreparedStatement } from "./db";
import { acquireMutation, hasUnresolvedEditPlans, releaseMutation } from "./edit-store";
import { TRANSACTION_COLUMNS, transactionValues } from "./mirror-write";
import { ZaimClient, type ZaimMaster, type ZaimMoney } from "./zaim";

/** 1 回の batch() に載せるステートメント数。D1 の 1 バッチ上限に対する安全側の値。 */
const BATCH_SIZE = 100;

/** マスタ 3 種の列定義。raw 以外の列名は API レスポンスのキーと一致させる。 */
const MASTER_COLUMNS = {
  categories: ["id", "mode", "name", "sort", "active"],
  genres: ["id", "category_id", "name", "sort", "active"],
  accounts: ["id", "name", "sort", "active"],
} as const;

/** 同期の所要時間内訳（ミリ秒）。CPU 時間の見積もりに使う。 */
export interface SyncTimings {
  /** Zaim API の取得（ネットワーク待ちを含む。CPU 時間には計上されない）。 */
  fetchMs: number;
  /** JSON からバインド値への変換。ほぼ純粋な CPU 時間。 */
  transformMs: number;
  /** DB への書き込み。 */
  writeMs: number;
  /** テーブル差し替え。 */
  swapMs: number;
  /** 全体。 */
  totalMs: number;
}

/** 同期結果の件数と所要時間。 */
export interface SyncResult {
  counts: Record<string, number>;
  syncedAt: string;
  timings: SyncTimings;
}

/**
 * 作業用テーブルの DDL を組み立てる。
 *
 * @returns 実行順に並んだ DDL 文のリスト。
 */
export function workTableDdl(): string[] {
  return [
    "DROP TABLE IF EXISTS transactions_new",
    "DROP TABLE IF EXISTS categories_new",
    "DROP TABLE IF EXISTS genres_new",
    "DROP TABLE IF EXISTS accounts_new",
    "DROP TABLE IF EXISTS sync_meta_new",
    `CREATE TABLE transactions_new (
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
    )`,
    `CREATE TABLE categories_new (
      id     INTEGER PRIMARY KEY,
      mode   TEXT,
      name   TEXT,
      sort   INTEGER,
      active INTEGER,
      raw    TEXT NOT NULL
    )`,
    `CREATE TABLE genres_new (
      id          INTEGER PRIMARY KEY,
      category_id INTEGER,
      name        TEXT,
      sort        INTEGER,
      active      INTEGER,
      raw         TEXT NOT NULL
    )`,
    `CREATE TABLE accounts_new (
      id     INTEGER PRIMARY KEY,
      name   TEXT,
      sort   INTEGER,
      active INTEGER,
      raw    TEXT NOT NULL
    )`,
    "CREATE TABLE sync_meta_new (key TEXT PRIMARY KEY, value TEXT)",
  ];
}

/**
 * 差し替えバッチの SQL を組み立てる。
 *
 * DROP → RENAME → インデックス再作成までを 1 トランザクションで行う。
 *
 * @returns 実行順に並んだ SQL 文のリスト。
 */
export function swapSql(): string[] {
  const tables = ["transactions", "categories", "genres", "accounts", "sync_meta"];
  return [
    ...tables.map((t) => `DROP TABLE IF EXISTS ${t}`),
    ...tables.map((t) => `ALTER TABLE ${t}_new RENAME TO ${t}`),
    "CREATE INDEX idx_tx_date ON transactions (date)",
    "CREATE INDEX idx_tx_mode_date ON transactions (mode, date)",
    "CREATE INDEX idx_tx_category ON transactions (category_id)",
    "CREATE INDEX idx_tx_from_account ON transactions (from_account_id)",
    "CREATE INDEX idx_tx_to_account ON transactions (to_account_id)",
  ];
}

/**
 * ステートメントを一定数ずつ batch() に流す。
 *
 * @param db ミラー DB。
 * @param statements 実行するステートメント。
 */
async function runInBatches(db: Database, statements: PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await db.batch(statements.slice(i, i + BATCH_SIZE));
  }
}

/**
 * 行を INSERT 文のバインド済みステートメントに変換する。
 *
 * `raw` 列には API レスポンスの原文を入れる。将来 Zaim 側に列が増えても
 * 再同期だけで拾えるようにするため。
 *
 * @param db ミラー DB。
 * @param table 挿入先テーブル名。
 * @param columns raw を除く列名。
 * @param rows API から取得した行。
 * @returns バインド済みステートメントのリスト。
 */
function insertStatements(
  db: Database,
  table: string,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): PreparedStatement[] {
  const placeholders = columns
    .map(() => "?")
    .concat("?")
    .join(", ");
  const stmt = db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}, raw) VALUES (${placeholders})`,
  );
  return rows.map((row) =>
    stmt.bind(...columns.map((col) => row[col] ?? null), JSON.stringify(row)),
  );
}

/** 明細行を同期用 INSERT 文のバインド済みステートメントへ変換する。 */
function insertTransactionStatements(
  db: Database,
  table: string,
  rows: readonly ZaimMoney[],
): PreparedStatement[] {
  const placeholders = TRANSACTION_COLUMNS.map(() => "?")
    .concat("?")
    .join(", ");
  const stmt = db.prepare(
    `INSERT INTO ${table} (${TRANSACTION_COLUMNS.join(", ")}, raw) VALUES (${placeholders})`,
  );
  return rows.map((row) => stmt.bind(...transactionValues(row)));
}

/**
 * Zaim から全件取得してミラー DB を再構築する。
 *
 * @param db ミラー DB。
 * @param client Zaim クライアント。
 * @returns 件数・同期時刻・所要時間の内訳。
 * @throws 明細が 0 件だった場合（API 異常の可能性があるため差し替えを中止する）。
 */
async function runSync(db: Database, client: ZaimClient): Promise<SyncResult> {
  const t0 = Date.now();
  let fetchMs = 0;
  let transformMs = 0;
  let writeMs = 0;

  // 認証確認。失敗時はここで止まり、既存テーブルは無傷のまま残る
  const verifyStart = Date.now();
  await client.verify();
  fetchMs += Date.now() - verifyStart;

  await db.batch(workTableDdl().map((sql) => db.prepare(sql)));

  const counts: Record<string, number> = {};

  // 明細（全期間をページ走査）
  let total = 0;
  const pages = client.iterMoney();
  for (;;) {
    const f = Date.now();
    const { value, done } = await pages.next();
    fetchMs += Date.now() - f;
    if (done) break;

    const t = Date.now();
    const statements = insertTransactionStatements(db, "transactions_new", value);
    transformMs += Date.now() - t;

    const w = Date.now();
    await runInBatches(db, statements);
    writeMs += Date.now() - w;
    total += value.length;
  }
  counts.transactions = total;

  // 0 件チェック（壊れた内容で差し替えないための関門）
  if (total === 0) {
    throw new Error("明細が 0 件。API 異常の可能性があるため差し替えを中止");
  }

  // マスタ 3 種
  const f = Date.now();
  const [categories, genres, accounts] = await Promise.all([
    client.categories(),
    client.genres(),
    client.accounts(),
  ]);
  fetchMs += Date.now() - f;

  const masters: [keyof typeof MASTER_COLUMNS, ZaimMaster[]][] = [
    ["categories", categories],
    ["genres", genres],
    ["accounts", accounts],
  ];
  for (const [table, rows] of masters) {
    const t = Date.now();
    const statements = insertStatements(db, `${table}_new`, MASTER_COLUMNS[table], rows);
    transformMs += Date.now() - t;

    const w = Date.now();
    await runInBatches(db, statements);
    writeMs += Date.now() - w;
    counts[table] = rows.length;
  }

  // 同期メタ情報
  const syncedAt = new Date().toISOString();
  const metaStmt = db.prepare("INSERT INTO sync_meta_new (key, value) VALUES (?, ?)");
  await db.batch([
    metaStmt.bind("synced_at", syncedAt),
    metaStmt.bind("counts", JSON.stringify(counts)),
  ]);

  // 差し替え
  const s = Date.now();
  await db.batch(swapSql().map((sql) => db.prepare(sql)));
  const swapMs = Date.now() - s;

  return {
    counts,
    syncedAt,
    timings: { fetchMs, transformMs, writeMs, swapMs, totalMs: Date.now() - t0 },
  };
}

/**
 * Zaim から全件取得してミラー DB を再構築する。
 *
 * 取得開始からテーブル差し替え完了まで共有ゲートを保持し、未照合の編集計画が
 * 残っている場合は取得を開始せず保留する。外部から強制終了されたゲートは
 * 自動取得しないため、運用手順に従って状態を確認して復旧する。
 *
 * @param db ミラー DB。
 * @param client Zaim クライアント。
 * @returns 件数・同期時刻・所要時間の内訳。
 * @throws 明細が 0 件だった場合、別処理が実行中の場合、未照合編集計画がある場合。
 */
export async function syncAll(db: Database, client: ZaimClient): Promise<SyncResult> {
  const owner = `sync:${crypto.randomUUID()}`;
  if (!(await acquireMutation(db, owner, "sync"))) {
    throw new Error("別の同期または編集が処理中のため同期を保留");
  }

  try {
    if (await hasUnresolvedEditPlans(db)) {
      throw new Error("未照合の編集計画があるため同期を保留");
    }
    return await runSync(db, client);
  } finally {
    await releaseMutation(db, owner);
  }
}
