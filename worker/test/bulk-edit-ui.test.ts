/** 一括編集の no-op 除外を HTTP 境界で確認する。 */

import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";

import worker from "../src/index";
import type { EditPlan } from "../src/edit-contract";
import { initializeOperations } from "../src/edit-store";
import { seedDatabase } from "./fixtures";

beforeEach(async () => {
  await seedDatabase(env.DB);
  await env.DB.prepare("UPDATE transactions SET currency_code = 'JPY'").run();
  await initializeOperations(env.DB);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mutation_gate"),
    env.DB.prepare("DELETE FROM edit_plans"),
  ]);
});

/** 編集を有効化し、外部認証にはダミー値を使う。 */
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

it("一括編集は指定値と同じ明細を計画から除外する", async () => {
  const res = await worker.fetch(
    jsonRequest("/api/edit-plans", {
      source: "filter",
      filter: { mode: ["payment"], q: "セブンイレブン" },
      changes: { comment: "ついで" },
    }),
    enabledEnv(),
  );

  expect(res.status).toBe(200);
  const plan = (await res.json()) as EditPlan;
  expect(plan.items.map((item) => item.before.id)).toEqual([1]);
});

it("一括編集の全件が no-op なら計画を保存しない", async () => {
  const res = await worker.fetch(
    jsonRequest("/api/edit-plans", {
      source: "filter",
      filter: { mode: ["payment"], q: "ついで" },
      changes: { comment: "ついで" },
    }),
    enabledEnv(),
  );

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: "no_op", message: "対象の明細はすべて指定値と同じです" },
  });
  await expect(
    env.DB.prepare("SELECT COUNT(*) AS count FROM edit_plans").first<{ count: number }>(),
  ).resolves.toMatchObject({ count: 0 });
});
