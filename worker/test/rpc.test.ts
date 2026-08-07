/**
 * Hono RPC の型がフロントから使える形で出ていることを確認する。
 *
 * ルート定義をチェーンでなく文として並べると `typeof app` に型が積み上がらず、
 * `hc<AppType>` からはどのエンドポイントも見えなくなる。壊れても実行時には
 * 何も起きず、PWA 側で初めて気付くことになるため、ここで固定しておく。
 */

import { SELF, env } from "cloudflare:test";
import { hc } from "hono/client";
import { beforeAll, expect, expectTypeOf, it } from "vitest";

import type { AppType } from "../src/index";
import { TRANSACTION_COUNT, seedDatabase } from "./fixtures";

const client = hc<AppType>("http://example.com", {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(input, init),
});

beforeAll(async () => {
  await seedDatabase(env.DB);
});

it("明細一覧を RPC クライアントから叩ける", async () => {
  const res = await client.api.transactions.$get({ query: { limit: "3" } });
  expect(res.status).toBe(200);

  // 型としてのレスポンスは「成功」と「バリデーションエラー」の union になる。
  // zValidator が 400 を返しうることが契約に含まれているためで、
  // 呼び出し側は status で絞ってからでないと本体に触れない。
  if (res.status !== 200) throw new Error(`想定外のステータス: ${res.status}`);

  const body = await res.json();
  // any に落ちていれば型検査は素通りしてしまうので、型と値の両方を見る
  expectTypeOf(body.total).toBeNumber();
  expectTypeOf(body.items).toBeArray();
  expect(body.total).toBe(TRANSACTION_COUNT);
  expect(body.items.map((item) => item.id)).toEqual([5, 2, 1]);
});

it("マスタと同期メタも型付きで取れる", async () => {
  const masters = await (await client.api.masters.$get()).json();
  expect(masters.categories).toHaveLength(3);

  const meta = await (await client.api.meta.$get()).json();
  expectTypeOf(meta.counts).toEqualTypeOf<Record<string, number>>();
  expect(meta.counts.transactions).toBe(TRANSACTION_COUNT);
});

it("キーワードが D1 の LIKE 上限を超えると 400 になる", async () => {
  // 日本語 17 文字 = 51 バイト。実 D1 では SQLite がパターン長で弾くため、
  // クエリを組み立てる前に API 側で落とす
  const res = await SELF.fetch(
    `http://example.com/api/transactions?q=${encodeURIComponent("あ".repeat(17))}`,
  );
  expect(res.status).toBe(400);
});

it("上限ちょうどのキーワードは通る", async () => {
  // 日本語 16 文字 = 48 バイト
  const res = await SELF.fetch(
    `http://example.com/api/transactions?q=${encodeURIComponent("あ".repeat(16))}`,
  );
  expect(res.status).toBe(200);
});
