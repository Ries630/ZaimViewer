/** フィルタの SQL 変換を検証する。 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { drizzle } from "drizzle-orm/d1";

import { countTransactions, fetchTransactions, type TransactionFilter } from "../src/queries";
import { seedDatabase } from "./fixtures";

const db = drizzle(env.DB);

/**
 * フィルタに一致した明細の ID を順序どおりに返す。
 *
 * @param filt 絞り込み条件。
 * @returns 明細 ID のリスト（日付の新しい順）。
 */
async function ids(filt: TransactionFilter): Promise<number[]> {
  const rows = await fetchTransactions(db, filt, 100, 0);
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  await seedDatabase(env.DB);
});

describe("並び順とページング", () => {
  it("フィルタ未指定なら全件が日付降順で返る", async () => {
    // 同日（2026-08-01 の id=1,2）は id の降順。新しい順で一貫させている
    expect(await ids({})).toEqual([5, 2, 1, 7, 6, 3, 4, 8]);
  });

  it.each([
    [0, [5, 2]],
    [2, [1, 7]],
    [6, [4, 8]],
    [8, []],
  ])("ページ送りで重複も欠落もしない (offset=%i)", async (offset, expected) => {
    // 同日 2 件（id=1,2）をまたぐ位置を含めて確認する
    const page = await fetchTransactions(db, {}, 2, offset);
    expect(page.map((row) => row.id)).toEqual(expected);
  });
});

describe("絞り込み", () => {
  it("振替を除外できる", async () => {
    const result = await ids({ modes: ["payment", "income"] });
    expect(result).not.toContain(7);
    expect(result).toHaveLength(7);
  });

  it("期間で絞り込める", async () => {
    // 境界日を含むこと（07-01 と 07-26 の両方が残る）
    expect(await ids({ dateFrom: "2026-07-01", dateTo: "2026-07-26" })).toEqual([7, 6, 3, 4]);
  });

  it("日付上限で未来の明細を隠せる", async () => {
    // 実データでは 2029 年まで繰り返し登録の家賃が入っている
    expect(await ids({ dateTo: "2026-08-06" })).not.toContain(5);
  });

  it("カテゴリとジャンルで絞り込める", async () => {
    expect(await ids({ categoryIds: [102] })).toEqual([5, 4]);
    expect(await ids({ genreIds: [1001, 1002] })).toEqual([2, 1, 3, 8]);
  });

  it("口座は出金元と入金先のどちらの一致でも該当する", async () => {
    // 11 は payment の from（3,4,5）、income の to（6）、transfer の from（7）
    expect(await ids({ accountIds: [11] })).toEqual([5, 7, 6, 3, 4]);
  });

  it("金額の下限で少額ノイズを除ける", async () => {
    // 自動連携の細かい履歴を落とす主力フィルタ。振替（id=7）も金額では残る
    expect(await ids({ amountMin: 1000 })).toEqual([5, 7, 6, 3, 4]);
  });

  it("金額の上下限は境界値を含む", async () => {
    expect(await ids({ amountMin: 320, amountMax: 980 })).toEqual([1, 8]);
  });

  it("条件を重ねると AND で効く", async () => {
    const result = await ids({
      modes: ["payment"],
      dateTo: "2026-08-06",
      amountMin: 500,
      excludePlaces: ["セブンイレブン"],
    });
    expect(result).toEqual([3, 4, 8]);
  });
});

describe("キーワード検索", () => {
  it("品名と店舗とメモを横断する", async () => {
    expect(await ids({ q: "セブン" })).toEqual([2, 1]);
    expect(await ids({ q: "おにぎり" })).toEqual([1]);
    expect(await ids({ q: "ついで" })).toEqual([2]);
  });

  it("アンダースコアはワイルドカードにならない", async () => {
    // "_店_" が任意 1 文字として解釈されると別の行まで拾ってしまう
    expect(await ids({ q: "_店_" })).toEqual([8]);
    expect(await ids({ q: "喫茶 _店_" })).toEqual([8]);
  });

  it("パーセントはワイルドカードにならない", async () => {
    expect(await ids({ q: "100%" })).toEqual([8]);
  });
});

describe("除外条件と NULL", () => {
  it("店舗を除外しても店舗未設定の明細は残る", async () => {
    // place が NULL の行は NOT IN で消えやすい。COALESCE で守っている
    expect(await ids({ excludePlaces: ["セブンイレブン"] })).toEqual([5, 7, 6, 3, 4, 8]);
  });

  it("ジャンルを除外しても未設定の明細は残る", async () => {
    // 振替（id=7）は genre_id が NULL
    expect(await ids({ excludeGenreIds: [1003] })).toEqual([2, 1, 7, 6, 3, 8]);
  });
});

describe("集計", () => {
  it("件数と金額合計はフィルタ後の値になる", async () => {
    expect(await countTransactions(db, { categoryIds: [102] })).toEqual({
      total: 2,
      totalAmount: 70000,
    });
  });

  it("一致 0 件でも合計は 0 を返す", async () => {
    expect(await countTransactions(db, { q: "存在しない" })).toEqual({ total: 0, totalAmount: 0 });
  });
});

describe("レスポンスの列", () => {
  it("明細はマスタ名と ID の両方を持つ", async () => {
    const [row] = await fetchTransactions(db, { q: "おにぎり" }, 1, 0);
    expect(row?.category_id).toBe(101);
    expect(row?.category).toBe("Food");
    expect(row?.genre).toBe("昼食");
    expect(row?.from_account).toBe("PayPay残高");
    expect(row?.to_account).toBeNull();
  });
});
