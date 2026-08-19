/**
 * ZaimViewer の Worker エントリポイント。
 *
 * ミラー DB を読む API を提供する。PWA の静的ファイルも同じ Worker から
 * 配信する予定で、iPhone からの入口は 1 つになる。
 *
 * 同期はここには無い。CPU 時間と D1 の invocation あたりクエリ数の両方に
 * 収まらないため、手元から `scripts/sync.ts` を実行する（ADR-0015）。
 */

import { zValidator } from "@hono/zod-validator";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";

import { type AccessEnv, accessGuard } from "./access";
import { MAX_AMOUNT, MAX_QUERY_BYTES, withinQueryByteLimit } from "./limits";
import { type OAuth1Credentials } from "./oauth1";
import {
  countTransactions,
  fetchMasters,
  fetchTransactions,
  type TransactionFilter,
} from "./queries";
import { syncMeta } from "./schema";
import { syncAll } from "./sync";
import { ZaimClient } from "./zaim";

/** Worker の環境バインディング。 */
interface Env extends AccessEnv {
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
  amount_min: z.coerce.number().int().min(0).max(MAX_AMOUNT).optional(),
  amount_max: z.coerce.number().int().min(0).max(MAX_AMOUNT).optional(),
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
 * Access の JWT 検証。すべてのルートより前に置く。
 *
 * ルートチェーンとは別の文にしてあるが、ミドルウェアは RPC の型に
 * 寄与しないので `AppType` は変わらない。
 */
app.use("*", accessGuard);

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
    return c.json(await fetchMasters(drizzle(c.env.DB)));
  })
  /** ミラーの同期時刻と件数を返す。UI に鮮度を表示するために使う。 */
  .get("/api/meta", async (c) => {
    const db = drizzle(c.env.DB);
    const rows = await db.select().from(syncMeta);
    const meta = new Map(rows.map((row) => [row.key, row.value]));
    // SAFETY: counts は同期が `JSON.stringify` で書いた種別ごとの件数で、
    // 読み書きの両方がこのリポジトリの中にある（`worker/src/sync.ts`）
    return c.json({
      synced_at: meta.get("synced_at") ?? null,
      counts: JSON.parse(meta.get("counts") || "{}") as Record<string, number>,
    });
  })
  /**
   * ローカル開発用の手動同期。ローカル D1 にデータを入れる唯一の手段。
   *
   * 本番では動かない（CPU 時間と D1 のクエリ数の上限を超える）ので閉じてある。
   * 本番の同期は手元から `scripts/sync.ts` を実行する。
   *
   * 破壊的操作なので GET では受けない。
   */
  .post("/api/sync", async (c) => {
    if (c.env.ENVIRONMENT === "production") {
      return c.json({ error: "本番の同期は scripts/sync.ts から実行する" }, 404);
    }
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
} satisfies ExportedHandler<Env>;
