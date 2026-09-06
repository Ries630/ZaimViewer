/** 編集計画を固定し、一件ずつ保存・照合する HTTP 境界。 */
import { vValidator } from "@hono/valibot-validator";
import { drizzle } from "drizzle-orm/d1";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { editCapabilitiesOf } from "./edit-config";
import {
  EditError,
  MAX_EDIT_ITEMS,
  editChangesSchema,
  editSnapshotSchema,
  snapshotOf,
} from "./edit-contract";
import { createEditPlan, executeEditItem, getEditPlan, reconcileEditItem } from "./edit-service";
import { credentialsOf, type Env } from "./environment";
import { fetchTransactions } from "./queries";
import { editFilterSchema, toDatabaseFilter } from "./transaction-filter";
import { ZaimClient } from "./zaim";

/** 計画の作成元。単体では表示時の値、一括ではページングを含まない検索条件を受け取る。 */
const createPlanSchema = v.variant("source", [
  v.strictObject({
    source: v.literal("single"),
    expected: editSnapshotSchema,
    changes: editChangesSchema,
  }),
  v.strictObject({
    source: v.literal("filter"),
    filter: editFilterSchema,
    changes: editChangesSchema,
  }),
]);
/** 計画に含まれる明細を一件だけ指定する。 */
const itemRequestSchema = v.strictObject({
  transaction_id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});
/** 計画 ID の形式。 */
const planParamSchema = v.object({ id: v.pipe(v.string(), v.uuid()) });

/** 編集 API の入力検証失敗を PWA と共有するエラー形式へ変換する。 */
function editValidationHook(result: { success: boolean }, c: Context): Response | undefined {
  if (!result.success) {
    return c.json({ error: { code: "invalid_input", message: "入力値が不正です" } }, 400);
  }
  return undefined;
}

/**
 * 未設定の認証情報で外部要求を出さない。
 * @param env Worker の環境バインディング。
 * @returns 設定を確認した API クライアント。
 */
function editClient(env: Env): ZaimClient {
  const credentials = credentialsOf(env);
  if (
    !credentials.consumerKey ||
    !credentials.consumerSecret ||
    !credentials.accessToken ||
    !credentials.accessTokenSecret
  ) {
    throw new EditError("credentials_missing", "編集用の認証情報が設定されていません", 503);
  }
  return new ZaimClient(credentials);
}

const app = new Hono<{ Bindings: Env }>();
/** 編集経路の外部応答や家計データを例外本文から露出させない。 */
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
app.use(
  "*",
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) =>
      c.json({ error: { code: "body_too_large", message: "送信内容が大きすぎます" } }, 413),
  }),
);

/** 親アプリのチェーンに結合する編集ルート。 */
export const editRoutes = app
  .post("/edit-plans", vValidator("json", createPlanSchema, editValidationHook), async (c) => {
    const capabilities = editCapabilitiesOf(c.env);
    if (!capabilities.enabled)
      throw new EditError("edit_disabled", "編集はまだ利用できません", 503);
    const input = c.req.valid("json");
    if (input.source === "single") {
      return c.json(
        await createEditPlan(
          c.env.DB,
          [snapshotOf(input.expected)],
          input.changes,
          "single",
          capabilities,
        ),
        200,
      );
    }
    if (input.filter.mode?.length !== 1)
      throw new EditError("mixed_modes", "種別を一つに絞ってください", 400);
    const items = await fetchTransactions(
      drizzle(c.env.DB),
      toDatabaseFilter(input.filter),
      MAX_EDIT_ITEMS + 1,
      0,
    );
    if (items.length > MAX_EDIT_ITEMS)
      throw new EditError("too_many_items", `対象を${MAX_EDIT_ITEMS}件以内に絞ってください`, 400);
    return c.json(
      await createEditPlan(c.env.DB, items.map(snapshotOf), input.changes, "filter", capabilities),
      200,
    );
  })
  .get("/edit-plans/:id", vValidator("param", planParamSchema, editValidationHook), async (c) => {
    return c.json(await getEditPlan(c.env.DB, c.req.valid("param").id), 200);
  })
  .post(
    "/edit-plans/:id/execute",
    vValidator("param", planParamSchema, editValidationHook),
    vValidator("json", itemRequestSchema, editValidationHook),
    async (c) => {
      return c.json(
        await executeEditItem(
          c.env.DB,
          editClient(c.env),
          c.req.valid("param").id,
          c.req.valid("json").transaction_id,
          editCapabilitiesOf(c.env),
        ),
        200,
      );
    },
  )
  .post(
    "/edit-plans/:id/reconcile",
    vValidator("param", planParamSchema, editValidationHook),
    vValidator("json", itemRequestSchema, editValidationHook),
    async (c) => {
      return c.json(
        await reconcileEditItem(
          c.env.DB,
          editClient(c.env),
          c.req.valid("param").id,
          c.req.valid("json").transaction_id,
        ),
        200,
      );
    },
  );
