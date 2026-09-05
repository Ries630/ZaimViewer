/**
 * ZaimViewer の Worker エントリポイント。
 *
 * ミラー DB を読む API を提供する。PWA の静的ファイルも同じ Worker から
 * 配信する予定で、iPhone からの入口は 1 つになる。
 *
 * 同期はここには無い。CPU 時間と D1 の invocation あたりクエリ数の両方に
 * 収まらないため、手元から `scripts/sync.ts` を実行する（ADR-0015）。
 */

import { vValidator } from "@hono/valibot-validator";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { accessGuard } from "./access";
import { editCapabilitiesOf } from "./edit-config";
import { EditError } from "./edit-contract";
import { transactionQuery, toDatabaseFilter } from "./transaction-filter";
import { credentialsOf, type Env } from "./environment";
import { editRoutes } from "./edit-routes";
import { countTransactions, fetchMasters, fetchTransactions } from "./queries";
import { syncMeta } from "./schema";
import { syncAll } from "./sync";
import { ZaimClient } from "./zaim";

const app = new Hono<{ Bindings: Env }>();

/**
 * Access の JWT 検証。すべてのルートより前に置く。
 *
 * ルートチェーンとは別の文にしてあるが、ミドルウェアは RPC の型に
 * 寄与しないので `AppType` は変わらない。
 */
app.use("*", accessGuard);

/** 編集要求は Access の Cookie に加えて同一オリジンを確認する。 */
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/edit-plans") && c.req.method !== "GET") {
    if (c.req.header("Origin") !== new URL(c.req.url).origin) {
      return c.json(
        { error: { code: "origin_mismatch", message: "同じアプリから操作してください" } },
        403,
      );
    }
    if (c.req.header("Content-Type")?.split(";")[0]?.trim() !== "application/json") {
      return c.json(
        { error: { code: "invalid_content_type", message: "JSON で送信してください" } },
        400,
      );
    }
  }
  return await next();
});

/** 外部応答や家計データを例外本文から露出させない。 */
app.onError((error, c) => {
  if (error instanceof EditError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status);
  }
  if (error instanceof HTTPException && error.status === 400) {
    return c.json({ error: { code: "invalid_input", message: "送信内容を確認してください" } }, 400);
  }
  return c.json(
    {
      error: {
        code: "internal_error",
        message: "処理結果を取得できませんでした。再送せず状態を確認してください",
      },
    },
    500,
  );
});

/**
 * ルート定義。
 *
 * `app.get(...)` を文として並べず 1 本のチェーンにしているのは、
 * RPC の型がメソッドの戻り値に積み上がる仕組みだから。
 * 戻り値を捨てると `typeof app` は空のままになり、
 * PWA 側の `hc<AppType>` がどのルートも認識できなくなる。
 */
const routes = app
  /** 実機で確認して公開した編集能力を返す。 */
  .get("/api/edit-capabilities", (c) => c.json(editCapabilitiesOf(c.env)))
  .route("/api", editRoutes)
  /**
   * 明細を日付の新しい順に返す。
   *
   * 件数と金額合計も併せて返す。件数はページャに、合計は
   * 「この条件で総額いくらか」の確認に使う。
   */
  .get("/api/transactions", vValidator("query", transactionQuery), async (c) => {
    const params = c.req.valid("query");
    const filter = toDatabaseFilter(params);

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
