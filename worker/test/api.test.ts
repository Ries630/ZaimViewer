/** HTTP レイヤ（パラメータの受け渡しと検証）を確認する。 */

import { SELF, env } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";

import { accessEnv, installAccess, issueToken, withToken } from "./access-harness";
import { SYNCED_AT, TRANSACTION_COUNT, seedDatabase } from "./fixtures";

/** テスト用の絶対 URL を組み立てる。 */
function url(path: string): string {
  return `http://example.com${path}`;
}

beforeAll(async () => {
  await seedDatabase(env.DB);
});

it("明細一覧はページ情報付きで返る", async () => {
  const res = await SELF.fetch(url("/api/transactions?limit=3"));
  const body = (await res.json()) as {
    total: number;
    limit: number;
    offset: number;
    items: { id: number }[];
  };
  expect(body.total).toBe(TRANSACTION_COUNT);
  expect(body.limit).toBe(3);
  expect(body.offset).toBe(0);
  expect(body.items.map((item) => item.id)).toEqual([5, 2, 1]);
});

it("複数指定のパラメータが配列として届く", async () => {
  const res = await SELF.fetch(url("/api/transactions?mode=payment&mode=income"));
  const body = (await res.json()) as { items: { mode: string }[] };
  expect(new Set(body.items.map((item) => item.mode))).toEqual(new Set(["payment", "income"]));
});

it("単一指定でも配列として扱われる", async () => {
  // 繰り返しパラメータは 1 個だと文字列で届くため、配列化の取りこぼしが起きやすい
  const res = await SELF.fetch(url("/api/transactions?mode=transfer"));
  const body = (await res.json()) as { total: number; items: { id: number }[] };
  expect(body.total).toBe(1);
  expect(body.items[0]?.id).toBe(7);
});

it("合計金額はフィルタ後の値になる", async () => {
  const res = await SELF.fetch(url("/api/transactions?category_id=102"));
  const body = (await res.json()) as { total_amount: number };
  expect(body.total_amount).toBe(70000);
});

it("不正な日付書式は 400 で弾く", async () => {
  const res = await SELF.fetch(url("/api/transactions?date_from=2026/08/01"));
  expect(res.status).toBe(400);
});

it("上限を超える limit は 400 で弾く", async () => {
  const res = await SELF.fetch(url("/api/transactions?limit=9999"));
  expect(res.status).toBe(400);
});

it("負の offset は 400 で弾く", async () => {
  const res = await SELF.fetch(url("/api/transactions?offset=-1"));
  expect(res.status).toBe(400);
});

it("マスタ一式が取得できる", async () => {
  const res = await SELF.fetch(url("/api/masters"));
  const body = (await res.json()) as {
    categories: unknown[];
    genres: unknown[];
    accounts: { name: string }[];
  };
  expect(body.categories).toHaveLength(3);
  expect(body.genres).toHaveLength(4);
  expect(body.accounts.map((a) => a.name)).toEqual(["みんなの銀行", "PayPay残高", "現金"]);
});

it("同期メタ情報が取得できる", async () => {
  const res = await SELF.fetch(url("/api/meta"));
  const body = (await res.json()) as { synced_at: string; counts: Record<string, number> };
  expect(body.synced_at).toBe(SYNCED_AT);
  expect(body.counts.transactions).toBe(TRANSACTION_COUNT);
});

it("本番では POST /api/sync が閉じている", async () => {
  // 同期は Worker 内では上限に収まらず、手元の scripts/sync.ts が正（ADR-0015）。
  // .dev.vars の有無で既定値が変わるため、ここでは明示的に上書きして固定する。
  // 本番では Access の JWT 検証も効くので、正しい JWT を付けて通り抜けた先を見る。
  // 付けないと 403 で止まり、ルート自身が閉じているかを確かめられない
  const original = accessEnv.ENVIRONMENT;
  await installAccess();
  try {
    const res = await SELF.fetch(
      url("/api/sync"),
      withToken(await issueToken(), { method: "POST" }),
    );
    expect(res.status).toBe(404);
  } finally {
    accessEnv.ENVIRONMENT = original;
    vi.restoreAllMocks();
  }
});
