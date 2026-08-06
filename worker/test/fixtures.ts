/**
 * テスト用ミラー DB の構築。
 *
 * 本番のマスタ構成を小さく模した固定データを投入する。
 * 実データの特徴（未来日付の家賃、コンビニの少額決済、振替、NULL の place、
 * LIKE のワイルドカードを含む店舗名）を意図的に含めてある。
 * フィルタが実運用で効くかをここで検証するため。
 */

import type { Database } from "../src/db";

/** (id, mode, name, sort) */
const CATEGORIES: [number, string, string, number][] = [
  [101, "payment", "Food", 1],
  [102, "payment", "Home", 2],
  [201, "income", "Salary", 1],
];

/** (id, category_id, name, sort) */
const GENRES: [number, number, string, number][] = [
  [1001, 101, "昼食", 1],
  [1002, 101, "カフェ", 2],
  [1003, 102, "Rent", 1],
  [2001, 201, "給与", 1],
];

/** (id, name, sort) */
const ACCOUNTS: [number, string, number][] = [
  [11, "みんなの銀行", 1],
  [12, "PayPay残高", 2],
  [13, "現金", 3],
];

/**
 * (id, mode, date, amount, category_id, genre_id, from_account_id, to_account_id,
 *  name, place, comment)
 */
const TRANSACTIONS: [
  number,
  string,
  string,
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  string | null,
  string | null,
  string | null,
][] = [
  [1, "payment", "2026-08-01", 320, 101, 1001, 12, null, "おにぎり", "セブンイレブン", null],
  [2, "payment", "2026-08-01", 150, 101, 1002, 12, null, null, "セブンイレブン", "ついで"],
  [3, "payment", "2026-07-15", 12800, 101, 1001, 11, null, "会食", "焼肉店", null],
  [4, "payment", "2026-07-01", 35000, 102, 1003, 11, null, null, null, null],
  [5, "payment", "2029-12-01", 35000, 102, 1003, 11, null, null, null, null],
  [6, "income", "2026-07-25", 280000, 201, 2001, null, 11, "給料", null, null],
  [7, "transfer", "2026-07-26", 50000, null, null, 11, 12, null, null, null],
  [8, "payment", "2026-06-10", 980, 101, 1002, 13, null, "100%ジュース", "喫茶 _店_", null],
];

/** 固定の同期時刻。API が値をそのまま返すことの確認に使う。 */
export const SYNCED_AT = "2026-08-06T09:41:22.566560+00:00";

const SCHEMA = [
  `CREATE TABLE transactions (
    id INTEGER PRIMARY KEY, mode TEXT NOT NULL, date TEXT NOT NULL, amount INTEGER NOT NULL,
    category_id INTEGER, genre_id INTEGER, from_account_id INTEGER, to_account_id INTEGER,
    name TEXT, place TEXT, comment TEXT, currency_code TEXT, receipt_id INTEGER,
    active INTEGER, created TEXT, raw TEXT NOT NULL
  )`,
  `CREATE TABLE categories (
    id INTEGER PRIMARY KEY, mode TEXT, name TEXT, sort INTEGER, active INTEGER, raw TEXT NOT NULL
  )`,
  `CREATE TABLE genres (
    id INTEGER PRIMARY KEY, category_id INTEGER, name TEXT, sort INTEGER, active INTEGER, raw TEXT NOT NULL
  )`,
  `CREATE TABLE accounts (
    id INTEGER PRIMARY KEY, name TEXT, sort INTEGER, active INTEGER, raw TEXT NOT NULL
  )`,
  "CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT)",
];

/**
 * テスト用のテーブルを作り、固定データを投入する。
 *
 * @param db 対象のミラー DB。
 */
export async function seedDatabase(db: Database): Promise<void> {
  await db.batch(
    [
      "DROP TABLE IF EXISTS transactions",
      "DROP TABLE IF EXISTS categories",
      "DROP TABLE IF EXISTS genres",
      "DROP TABLE IF EXISTS accounts",
      "DROP TABLE IF EXISTS sync_meta",
      ...SCHEMA,
    ].map((sql) => db.prepare(sql)),
  );

  const txStmt = db.prepare(
    `INSERT INTO transactions
     (id, mode, date, amount, category_id, genre_id, from_account_id, to_account_id,
      name, place, comment, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
  );
  const catStmt = db.prepare(
    "INSERT INTO categories (id, mode, name, sort, raw) VALUES (?, ?, ?, ?, '{}')",
  );
  const genreStmt = db.prepare(
    "INSERT INTO genres (id, category_id, name, sort, raw) VALUES (?, ?, ?, ?, '{}')",
  );
  const accountStmt = db.prepare(
    "INSERT INTO accounts (id, name, sort, raw) VALUES (?, ?, ?, '{}')",
  );
  const metaStmt = db.prepare("INSERT INTO sync_meta (key, value) VALUES (?, ?)");

  await db.batch([
    ...TRANSACTIONS.map((row) => txStmt.bind(...row)),
    ...CATEGORIES.map((row) => catStmt.bind(...row)),
    ...GENRES.map((row) => genreStmt.bind(...row)),
    ...ACCOUNTS.map((row) => accountStmt.bind(...row)),
    metaStmt.bind("synced_at", SYNCED_AT),
    metaStmt.bind("counts", JSON.stringify({ transactions: TRANSACTIONS.length })),
  ]);
}

/** 固定データの明細件数。 */
export const TRANSACTION_COUNT = TRANSACTIONS.length;
