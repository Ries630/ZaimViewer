/** HTTP レイヤ（パラメータの受け渡しと検証）を確認する。 */

import { SELF, env } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";

import { MAX_AMOUNT } from "../src/limits";
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

it("金額は 9 桁まで受け付け、超えたら 400 で弾く", async () => {
  // 400 の理由が「桁が大きすぎる」だと分かるよう、明示した上限で弾く。
  // 上限が無いと、安全な整数（2^53-1）を超えた値も検証を素通りする
  expect((await SELF.fetch(url(`/api/transactions?amount_min=${MAX_AMOUNT}`))).status).toBe(200);
  expect((await SELF.fetch(url(`/api/transactions?amount_min=${MAX_AMOUNT + 1}`))).status).toBe(
    400,
  );
  expect((await SELF.fetch(url(`/api/transactions?amount_max=${MAX_AMOUNT + 1}`))).status).toBe(
    400,
  );
});

it("負の offset は 400 で弾く", async () => {
  const res = await SELF.fetch(url("/api/transactions?offset=-1"));
  expect(res.status).toBe(400);
});

it("安全な整数を超える指定は 400 で弾く", async () => {
  // valibot の `v.integer()` は `Number.isInteger` そのままで、丸められて
  // 整数になる値も指数表記も通す。`v.safeInteger()` に替えてあることを固定する
  // （上限を持たない offset は、これが唯一の門になる）
  expect((await SELF.fetch(url("/api/transactions?offset=1e30"))).status).toBe(400);
  expect((await SELF.fetch(url("/api/transactions?offset=9007199254740993"))).status).toBe(400);
});

it("マスタは Zaim の並び（支出 → 収入、sort 順）で返る", async () => {
  const res = await SELF.fetch(url("/api/masters"));
  const body = (await res.json()) as {
    categories: { name: string }[];
    genres: { name: string }[];
    accounts: { name: string }[];
  };

  // mode の辞書順なら income が先になるが、Zaim の画面は支出が先。
  // mode の中では sort（Home=1 < Food=2）に従う
  expect(body.categories.map((c) => c.name)).toEqual(["Home", "Food", "Salary"]);

  // 見出しの順序をカテゴリに従わせる。category_id の数値順なら
  // 昼食・カフェ・Rent・給与 になる
  expect(body.genres.map((g) => g.name)).toEqual(["Rent", "昼食", "カフェ", "給与"]);

  // 現金は削除済みで sort=0。素直に並べれば先頭だが末尾へ回す
  expect(body.accounts.map((a) => a.name)).toEqual(["みんなの銀行", "PayPay残高", "現金"]);
});

it("削除済みのマスタは隠すが、明細から参照されているものは残す", async () => {
  const res = await SELF.fetch(url("/api/masters"));
  const body = (await res.json()) as {
    categories: { name: string }[];
    accounts: { name: string; active: number | null }[];
  };

  // 参照が無い削除済みは消える
  expect(body.categories.map((c) => c.name)).not.toContain("廃止した費目");
  expect(body.accounts.map((a) => a.name)).not.toContain("解約した口座");

  // 明細 8 が使っているので、削除済みでも選択肢に残る
  // （隠すと、その明細を口座で絞る手段が無くなる）
  expect(body.accounts.find((a) => a.name === "現金")?.active).toBe(-1);
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
