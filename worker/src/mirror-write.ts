/** Zaim の再取得結果を既存の transactions ミラーへ反映する。 */

import type { Database } from "./db";
import type { ZaimMoney } from "./zaim";

/** 明細テーブルの列（raw を除く）。同期と単体編集で共用する正。 */
export const TRANSACTION_COLUMNS = [
  "id",
  "mode",
  "date",
  "amount",
  "category_id",
  "genre_id",
  "from_account_id",
  "to_account_id",
  "name",
  "place",
  "comment",
  "currency_code",
  "receipt_id",
  "active",
  "created",
] as const;

/** 明細 1 行の列値と raw。同期 INSERT と編集 upsert の値の正を共用する。 */
export function transactionValues(money: ZaimMoney): unknown[] {
  return [...TRANSACTION_COLUMNS.map((column) => money[column] ?? null), JSON.stringify(money)];
}

/**
 * Zaim から再取得した明細をミラーへ upsert する。
 *
 * `synced_at` は同期メタ情報の列であり、ここでは更新しない。通常列と raw は
 * 1 文で同時に更新するため、一覧が新しい列と古い raw を混ぜて読むことがない。
 *
 * @param db ミラー DB。
 * @param money Zaim から再取得して照合済みの明細。
 */
export async function replaceMirrorMoney(db: Database, money: ZaimMoney): Promise<void> {
  const columns = [...TRANSACTION_COLUMNS, "raw"] as const;
  const updates = [...TRANSACTION_COLUMNS, "raw"]
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  await db
    .prepare(
      `INSERT INTO transactions (${columns.join(", ")})
       VALUES (${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updates}`,
    )
    .bind(...transactionValues(money))
    .run();
}
