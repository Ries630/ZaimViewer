/**
 * ZaimViewer の Worker エントリポイント。
 *
 * ミラー DB を読む API と、Cron Trigger から呼ばれる同期を 1 つの Worker に載せる。
 * PWA の静的ファイルも同じ Worker から配信する予定で、iPhone からの入口は 1 つになる。
 */

import { zValidator } from "@hono/zod-validator";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";

import { type OAuth1Credentials } from "./oauth1";
import { countTransactions, fetchTransactions, type TransactionFilter } from "./queries";
import { accounts, categories, genres, syncMeta } from "./schema";
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
 * キーワードの最大バイト数。
 *
 * D1 は LIKE / GLOB のパターン長を 50 バイトに制限している
 * （標準の SQLite ビルドは 50,000 なので、ローカルのテストでは踏めない）。
 * 実際に渡すパターンは前後に `%` が付くので、キーワード自体は 48 バイトまで。
 * UTF-8 の日本語は 1 文字 3 バイトなので、日本語だけなら 16 文字が上限になる。
 */
const MAX_QUERY_BYTES = 48;

/**
 * 文字列の UTF-8 バイト数が上限以内か判定する。
 *
 * @param value 判定する文字列。
 * @returns 上限以内なら true。
 */
function withinQueryByteLimit(value: string): boolean {
  return new TextEncoder().encode(value).length <= MAX_QUERY_BYTES;
}

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
  q: z
    .string()
    .refine(withinQueryByteLimit, {
      message: `キーワードは UTF-8 で ${MAX_QUERY_BYTES} バイト以内（D1 の LIKE パターン長制限）`,
    })
    .optional(),
  exclude_place: repeatable(z.string()),
  exclude_genre_id: repeatable(z.coerce.number().int()),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

const app = new Hono<{ Bindings: Env }>();

/**
 * ルート定義。
 *
 * `app.get(...)` を文として並べず 1 本のチェーンにしているのは、
 * RPC の型がメソッドの戻り値に積み上がる仕組みだから。
 * 戻り値を捨てると `typeof app` は空のままになり、
 * PWA 側の `hc<AppType>` がどのルートも認識できなくなる。
 */
const routes = app
  /**
   * 明細を日付の新しい順に返す。
   *
   * 件数と金額合計も併せて返す。件数はページャに、合計は
   * 「この条件で総額いくらか」の確認に使う。
   */
  .get("/api/transactions", zValidator("query", transactionQuery), async (c) => {
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

    const db = drizzle(c.env.DB);
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
  })
  /**
   * フィルタ UI の選択肢に使うマスタ一式を返す。
   *
   * 件数が高々 200 程度なので、PWA 側は起動時に一括取得して以降は使い回す。
   */
  .get("/api/masters", async (c) => {
    const db = drizzle(c.env.DB);
    const [categoryRows, genreRows, accountRows] = await Promise.all([
      db
        .select({
          id: categories.id,
          mode: categories.mode,
          name: categories.name,
          sort: categories.sort,
        })
        .from(categories)
        .orderBy(categories.mode, categories.sort, categories.id),
      db
        .select({
          id: genres.id,
          category_id: genres.categoryId,
          name: genres.name,
          sort: genres.sort,
        })
        .from(genres)
        .orderBy(genres.categoryId, genres.sort, genres.id),
      db
        .select({ id: accounts.id, name: accounts.name, sort: accounts.sort })
        .from(accounts)
        .orderBy(accounts.sort, accounts.id),
    ]);
    return c.json({ categories: categoryRows, genres: genreRows, accounts: accountRows });
  })
  /** ミラーの同期時刻と件数を返す。UI に鮮度を表示するために使う。 */
  .get("/api/meta", async (c) => {
    const db = drizzle(c.env.DB);
    const rows = await db.select().from(syncMeta);
    const meta = new Map(rows.map((row) => [row.key, row.value]));
    return c.json({
      synced_at: meta.get("synced_at") ?? null,
      counts: JSON.parse(meta.get("counts") || "{}") as Record<string, number>,
    });
  })
  /**
   * 手動同期。Cron を待たずに更新したいときに使う。
   *
   * 破壊的操作なので GET では受けない。
   */
  .post("/api/sync", async (c) => {
    const client = new ZaimClient(credentialsOf(c.env));
    const result = await syncAll(c.env.DB, client);
    return c.json(result);
  });

/**
 * PWA の `hc<AppType>` が参照する型。
 *
 * これを export しておくことで、フロント側はエンドポイントのパス・
 * クエリパラメータ・レスポンス形状を型として受け取れる。
 */
export type AppType = typeof routes;

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
    const result = await syncAll(env.DB, client);
    console.log(`同期完了: ${JSON.stringify(result.counts)} (${result.timings.totalMs}ms)`);
  },
} satisfies ExportedHandler<Env>;
