/** 編集の HTTP 境界が入力・認証・対象範囲を守ることを確認する。 */
import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { snapshotOf, type EditPlan } from "../src/edit-contract";
import { seedDatabase } from "./fixtures";

beforeEach(async () => {
  await seedDatabase(env.DB);
  await env.DB.prepare("UPDATE transactions SET currency_code = 'JPY'").run();
});

/** 検証に限って編集を有効化し、外部認証にはダミー値を使う。 */
function enabledEnv() {
  return {
    ...env,
    EDIT_ENABLED: "true",
    EDIT_VERIFIED_MODES: "payment,income",
    ZAIM_CONSUMER_KEY: "test",
    ZAIM_CONSUMER_SECRET: "test",
    ZAIM_ACCESS_TOKEN: "test",
    ZAIM_ACCESS_TOKEN_SECRET: "test",
  };
}

/** 同一オリジンからの JSON 要求。 */
function jsonRequest(path: string, body: unknown) {
  return new Request(`http://example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://example.com" },
    body: JSON.stringify(body),
  });
}

it("編集の有効化設定が無ければ能力APIは無効を返す", async () => {
  const res = await worker.fetch(new Request("http://example.com/api/edit-capabilities"), env);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ enabled: false, modes: [] });
});

it("別オリジンからの編集計画作成を拒否する", async () => {
  const res = await worker.fetch(
    new Request("http://example.com/api/edit-plans", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://other.example" },
      body: JSON.stringify({
        source: "filter",
        filter: { mode: ["payment"] },
        changes: { comment: "更新" },
      }),
    }),
    env,
  );
  expect(res.status).toBe(403);
});

it("壊れたJSONも本文を返さず入力エラーにする", async () => {
  const res = await worker.fetch(
    new Request("http://example.com/api/edit-plans", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://example.com" },
      body: "{ private-input",
    }),
    enabledEnv(),
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: "invalid_input", message: "送信内容を確認してください" },
  });
});

it("一括編集は検索条件に一致する明細全体を固定する", async () => {
  const res = await worker.fetch(
    jsonRequest("/api/edit-plans", {
      source: "filter",
      filter: { mode: ["payment"], q: "セブンイレブン" },
      changes: { comment: "確認済み" },
    }),
    enabledEnv(),
  );
  expect(res.status).toBe(200);
  const plan = (await res.json()) as EditPlan;
  expect(plan.items.map((item) => item.before.id)).toEqual([2, 1]);
  expect(plan.items.map((item) => item.status)).toEqual(["pending", "pending"]);
  await env.DB.prepare("UPDATE transactions SET place = '変更後' WHERE id = 1").run();
  const stored = await worker.fetch(
    new Request(`http://example.com/api/edit-plans/${plan.id}`),
    enabledEnv(),
  );
  const storedPlan = (await stored.json()) as EditPlan;
  expect(storedPlan.items.map((item) => item.before.id)).toEqual([2, 1]);
});

it("単体編集は表示時の値を使い未知の変更項目を拒否する", async () => {
  const expected = snapshotOf({
    id: 1,
    mode: "payment",
    date: "2026-08-01",
    amount: 320,
    category_id: 101,
    genre_id: 1001,
    from_account_id: 12,
    name: "おにぎり",
    place: "セブンイレブン",
    currency_code: "JPY",
  });
  const res = await worker.fetch(
    jsonRequest("/api/edit-plans", {
      source: "single",
      expected,
      changes: { comment: "更新", receipt_id: 999 },
    }),
    enabledEnv(),
  );
  expect(res.status).toBe(400);
});

it("一括編集でページング指定や種別混在を受け付けない", async () => {
  for (const filter of [{ mode: ["payment"], limit: "1" }, { mode: ["payment", "income"] }]) {
    const res = await worker.fetch(
      jsonRequest("/api/edit-plans", {
        source: "filter",
        filter,
        changes: { comment: "確認済み" },
      }),
      enabledEnv(),
    );
    expect(res.status).toBe(400);
  }
});

it("編集 API の入力検証エラーを共通のエラー形式で返す", async () => {
  const res = await worker.fetch(
    jsonRequest("/api/edit-plans", {
      source: "filter",
      filter: { mode: ["payment"], amount_min: 1 },
      changes: { comment: "確認済み" },
    }),
    enabledEnv(),
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: "invalid_input", message: "入力値が不正です" },
  });
});

it("編集 API のパス検証エラーも共通のエラー形式で返す", async () => {
  const res = await worker.fetch(
    new Request("http://example.com/api/edit-plans/not-a-uuid"),
    enabledEnv(),
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: "invalid_input", message: "入力値が不正です" },
  });
});

it("一括編集の種別は編集可能な mode だけを受け付ける", async () => {
  const res = await worker.fetch(
    jsonRequest("/api/edit-plans", {
      source: "filter",
      filter: { mode: ["unknown"] },
      changes: { comment: "確認済み" },
    }),
    enabledEnv(),
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: "invalid_input", message: "入力値が不正です" },
  });
});

it("一括編集の D1 bind 数が上限を超える検索条件を拒否する", async () => {
  const res = await worker.fetch(
    jsonRequest("/api/edit-plans", {
      source: "filter",
      filter: {
        mode: ["payment"],
        account_id: Array.from({ length: 38 }, (_, index) => String(index + 1)),
        q: "店",
      },
      changes: { comment: "確認済み" },
    }),
    enabledEnv(),
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: "invalid_input", message: "入力値が不正です" },
  });
});

it("計画作成時に表示後の金額変更を検出する", async () => {
  const expected = snapshotOf({
    id: 1,
    mode: "payment",
    date: "2026-08-01",
    amount: 319,
    category_id: 101,
    genre_id: 1001,
    from_account_id: 12,
    name: "おにぎり",
    place: "セブンイレブン",
    currency_code: "JPY",
  });
  const res = await worker.fetch(
    jsonRequest("/api/edit-plans", {
      source: "single",
      expected,
      changes: { comment: "更新" },
    }),
    enabledEnv(),
  );
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: { code: "stale_snapshot" } });
});

it("計画の作成・保存・照合はOrigin未指定を拒否する", async () => {
  for (const path of [
    "/api/edit-plans",
    "/api/edit-plans/00000000-0000-4000-8000-000000000001/execute",
    "/api/edit-plans/00000000-0000-4000-8000-000000000001/reconcile",
  ]) {
    const res = await worker.fetch(
      new Request(`http://example.com${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      enabledEnv(),
    );
    expect(res.status).toBe(403);
  }
});

it("本番では編集APIもAccess認証が必要になる", async () => {
  const configured = { ...enabledEnv(), ENVIRONMENT: "production" };
  const res = await worker.fetch(
    jsonRequest("/api/edit-plans", {
      source: "filter",
      filter: { mode: ["payment"] },
      changes: { comment: "更新" },
    }),
    configured,
  );
  expect(res.status).toBe(403);
});
