/**
 * テスト用ミラー DB の構築。
 *
 * テーブルは本番と同じ `sync.ts` の DDL と差し替え処理で作る。
 * スキーマをテスト側に書き写すと、本番の DDL を変えたときに
 * テストだけ古いまま通り続けてしまうため。
 *
 * 固定データは本番のマスタ構成を小さく模したもので、実データの特徴
 * （未来日付の家賃、コンビニの少額決済、振替、NULL の place、
 * LIKE のワイルドカードを含む店舗名）を意図的に含めてある。
 */

import type { Database, PreparedStatement } from "../src/db";
import { swapSql, workTableDdl } from "../src/sync";

/**
 * (id, mode, name, sort, active)
 *
 * 並び順の検証を兼ねる。`sort` を Home < Food にしてあるので、
 * `mode` の辞書順（income が先）ではなく「支出 → 収入」で並ぶことと、
 * mode の中では `sort` に従うことが同時に確かめられる。
 * 103 は Zaim で削除済みかつ明細から参照されていないので、選択肢から消える。
 */
const CATEGORIES: [number, string, string, number, number][] = [
  [101, "payment", "Food", 2, 1],
  [102, "payment", "Home", 1, 1],
  [201, "income", "Salary", 1, 1],
  [103, "payment", "廃止した費目", 0, -1],
];

/**
 * (id, category_id, name, sort, active)
 *
 * 見出しがカテゴリの並びに従うことの検証を兼ねる。`category_id` の数値順なら
 * 昼食・カフェ・Rent・給与だが、カテゴリの並び（Home → Food → Salary）に
 * 従うので Rent が先頭に来る。
 */
const GENRES: [number, number, string, number, number][] = [
  [1001, 101, "昼食", 1, 1],
  [1002, 101, "カフェ", 2, 1],
  [1003, 102, "Rent", 1, 1],
  [2001, 201, "給与", 1, 1],
];

/**
 * (id, name, sort, active)
 *
 * 13 は削除済みだが明細 8 が使っているので残る。`sort` が 0 なので、
 * 素直に並べれば先頭に来るところを末尾へ回すことの検証になる。
 * 14 は削除済みで参照も無いので消える。
 */
const ACCOUNTS: [number, string, number, number][] = [
  [11, "みんなの銀行", 1, 1],
  [12, "PayPay残高", 2, 1],
  [13, "現金", 0, -1],
  [14, "解約した口座", 0, -1],
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

/** 固定データの明細件数。 */
export const TRANSACTION_COUNT = TRANSACTIONS.length;

/**
 * テスト用のテーブルを作り、固定データを投入する。
 *
 * 本番と同じ手順（作業用テーブルに構築 → 差し替え）を踏むので、
 * DDL と差し替えバッチもテストのたびに実行される。
 *
 * @param db 対象のミラー DB。
 */
export async function seedDatabase(db: Database): Promise<void> {
  await db.batch(workTableDdl().map((statement) => db.prepare(statement)));

  const transactionStatement = db.prepare(
    `INSERT INTO transactions_new
     (id, mode, date, amount, category_id, genre_id, from_account_id, to_account_id,
      name, place, comment, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
  );
  const categoryStatement = db.prepare(
    "INSERT INTO categories_new (id, mode, name, sort, active, raw) VALUES (?, ?, ?, ?, ?, '{}')",
  );
  const genreStatement = db.prepare(
    "INSERT INTO genres_new (id, category_id, name, sort, active, raw) VALUES (?, ?, ?, ?, ?, '{}')",
  );
  const accountStatement = db.prepare(
    "INSERT INTO accounts_new (id, name, sort, active, raw) VALUES (?, ?, ?, ?, '{}')",
  );
  const metaStatement = db.prepare("INSERT INTO sync_meta_new (key, value) VALUES (?, ?)");

  const rows: PreparedStatement[] = [
    ...TRANSACTIONS.map((row) => transactionStatement.bind(...row)),
    ...CATEGORIES.map((row) => categoryStatement.bind(...row)),
    ...GENRES.map((row) => genreStatement.bind(...row)),
    ...ACCOUNTS.map((row) => accountStatement.bind(...row)),
    metaStatement.bind("synced_at", SYNCED_AT),
    metaStatement.bind("counts", JSON.stringify({ transactions: TRANSACTION_COUNT })),
  ];
  await db.batch(rows);

  await db.batch(swapSql().map((statement) => db.prepare(statement)));
}
