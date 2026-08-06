/**
 * ZaimViewer の Worker エントリポイント。
 *
 * ミラー DB を読む API と、Cron Trigger から呼ばれる同期を 1 つの Worker に載せる。
 * PWA の静的ファイルも同じ Worker から配信する予定で、iPhone からの入口は 1 つになる。
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import type { Database } from "./db";
import { type OAuth1Credentials } from "./oauth1";
import { countTransactions, fetchTransactions, type TransactionFilter } from "./queries";
import { syncAll } from "./sync";
import { ZaimClient } from "./zaim";

/** Worker の環境バインディング。 */
interface Env {
  DB: D1Database;
  ZAIM_CONSUMER_KEY: string;
  ZAIM_CONSUMER_SECRET: string;
  ZAIM_ACCESS_TOKEN: string;
  ZAIM_ACCESS_TOKEN_SECRET: string;
}

/** 1 リクエストで返す明細の上限。無限スクロール 1 ページ分を想定。 */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** 日付パラメータの書式。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 環境変数から認証情報を組み立てる。
 *
 * @param env Worker の環境バインディング。
 * @returns OAuth1.0a 認証情報。
 */
function credentialsOf(env: Env): OAuth1Credentials {
  return {
    consumerKey: env.ZAIM_CONSUMER_KEY,
    consumerSecret: env.ZAIM_CONSUMER_SECRET,
    accessToken: env.ZAIM_ACCESS_TOKEN,
    accessTokenSecret: env.ZAIM_ACCESS_TOKEN_SECRET,
  };
}

/**
 * 繰り返し指定されうるクエリパラメータを配列に正規化する。
 *
 * `?mode=payment&mode=income` は配列で届くが、1 個だけなら文字列で届く。
 * 呼び出し側で分岐したくないので、ここで必ず配列に揃える。
 *
 * @param item 各要素のスキーマ。
 * @returns 配列に正規化するスキーマ。
 */
function repeatable<T extends z.ZodType>(item: T) {
  return z.preprocess(
    (value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]),
    z.array(item).optional(),
  );
}

/**
 * 明細一覧のクエリパラメータ。
 *
 * すべてのフィルタは未指定なら条件を課さない。「振替を除外」「今日以前だけ」
 * といった既定は API 側に持たせず、呼び出し側（PWA）が明示する。
 */
const transactionQuery = z.object({
  date_from: z.string().regex(DATE_PATTERN).optional(),
  date_to: z.string().regex(DATE_PATTERN).optional(),
  mode: repeatable(z.string()),
  category_id: repeatable(z.coerce.number().int()),
  genre_id: repeatable(z.coerce.number().int()),
  account_id: repeatable(z.coerce.number().int()),
  amount_min: z.coerce.number().int().min(0).optional(),
  amount_max: z.coerce.number().int().min(0).optional(),
  q: z.string().optional(),
  exclude_place: repeatable(z.string()),
  exclude_genre_id: repeatable(z.coerce.number().int()),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

const app = new Hono<{ Bindings: Env }>();

/**
 * 明細を日付の新しい順に返す。
 *
 * 件数と金額合計も併せて返す。件数はページャに、合計は
 * 「この条件で総額いくらか」の確認に使う。
 */
app.get("/api/transactions", zValidator("query", transactionQuery), async (c) => {
  const params = c.req.valid("query");
  const filter: TransactionFilter = {
    dateFrom: params.date_from,
    dateTo: params.date_to,
    modes: params.mode,
    categoryIds: params.category_id,
    genreIds: params.genre_id,
    accountIds: params.account_id,
    amountMin: params.amount_min,
    amountMax: params.amount_max,
    q: params.q,
    excludePlaces: params.exclude_place,
    excludeGenreIds: params.exclude_genre_id,
  };

  const db = c.env.DB as Database;
  const [{ total, totalAmount }, items] = await Promise.all([
    countTransactions(db, filter),
    fetchTransactions(db, filter, params.limit, params.offset),
  ]);

  return c.json({
    total,
    total_amount: totalAmount,
    limit: params.limit,
    offset: params.offset,
    items,
  });
});

/**
 * フィルタ UI の選択肢に使うマスタ一式を返す。
 *
 * 件数が高々 200 程度なので、PWA 側は起動時に一括取得して以降は使い回す。
 */
app.get("/api/masters", async (c) => {
  const db = c.env.DB as Database;
  const [categories, genres, accounts] = await Promise.all([
    db.prepare("SELECT id, mode, name, sort FROM categories ORDER BY mode, sort, id").all(),
    db
      .prepare("SELECT id, category_id, name, sort FROM genres ORDER BY category_id, sort, id")
      .all(),
    db.prepare("SELECT id, name, sort FROM accounts ORDER BY sort, id").all(),
  ]);
  return c.json({
    categories: categories.results,
    genres: genres.results,
    accounts: accounts.results,
  });
});

/** ミラーの同期時刻と件数を返す。UI に鮮度を表示するために使う。 */
app.get("/api/meta", async (c) => {
  const db = c.env.DB as Database;
  const { results } = await db
    .prepare("SELECT key, value FROM sync_meta")
    .all<{ key: string; value: string | null }>();
  const meta = new Map(results.map((row) => [row.key, row.value]));
  return c.json({
    synced_at: meta.get("synced_at") ?? null,
    counts: JSON.parse(meta.get("counts") || "{}") as Record<string, number>,
  });
});

/**
 * 手動同期。Cron を待たずに更新したいときに使う。
 *
 * 破壊的操作なので GET では受けない。
 */
app.post("/api/sync", async (c) => {
  const client = new ZaimClient(credentialsOf(c.env));
  const result = await syncAll(c.env.DB as Database, client);
  return c.json(result);
});

export default {
  fetch: app.fetch,

  /**
   * Cron Trigger から呼ばれる定期同期。
   *
   * @param _event スケジュール情報（未使用）。
   * @param env Worker の環境バインディング。
   */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const client = new ZaimClient(credentialsOf(env));
    const result = await syncAll(env.DB as Database, client);
    console.log(`同期完了: ${JSON.stringify(result.counts)} (${result.timings.totalMs}ms)`);
  },
} satisfies ExportedHandler<Env>;
