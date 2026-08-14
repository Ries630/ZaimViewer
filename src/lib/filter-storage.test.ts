import { describe, expect, it } from "vitest";

import { MAX_AMOUNT } from "../../worker/src/limits";
import { DEFAULT_FILTER } from "./filter";
import { parseStoredFilter } from "./filter-storage";

/**
 * オブジェクトを保存済みの文字列に見立てる。
 *
 * @param value 保存されていたとみなす値。
 * @returns JSON 文字列。
 */
function stored(value: unknown): string {
  return JSON.stringify(value);
}

describe("parseStoredFilter", () => {
  it("未保存なら既定になる", () => {
    expect(parseStoredFilter(null)).toEqual(DEFAULT_FILTER);
  });

  it("JSON として壊れていれば既定になる", () => {
    expect(parseStoredFilter("{ではない")).toEqual(DEFAULT_FILTER);
  });

  it("オブジェクトでなければ既定になる", () => {
    expect(parseStoredFilter(stored([1, 2, 3]))).toEqual(DEFAULT_FILTER);
    expect(parseStoredFilter(stored("文字列"))).toEqual(DEFAULT_FILTER);
    expect(parseStoredFilter(stored(null))).toEqual(DEFAULT_FILTER);
  });

  it("保存した状態がそのまま戻る", () => {
    const saved = {
      ...DEFAULT_FILTER,
      period: "last-month",
      modes: ["payment"],
      categoryIds: [101],
      amountMin: 500,
      q: "スーパー",
      excludePlaces: ["ヨドバシ"],
    };
    expect(parseStoredFilter(stored(saved))).toEqual(saved);
  });

  it("知らない項目が増えていても読める（項目ごとに倒すので丸ごと捨てない）", () => {
    const parsed = parseStoredFilter(stored({ ...DEFAULT_FILTER, amountMin: 500, 未知: true }));
    expect(parsed.amountMin).toBe(500);
    expect(parsed).not.toHaveProperty("未知");
  });

  it("項目が欠けていればその項目だけ既定になる", () => {
    const parsed = parseStoredFilter(stored({ amountMin: 500 }));
    expect(parsed.amountMin).toBe(500);
    expect(parsed.hideFuture).toBe(DEFAULT_FILTER.hideFuture);
    expect(parsed.modes).toEqual(DEFAULT_FILTER.modes);
  });

  it("型の合わない項目は既定に倒す", () => {
    const parsed = parseStoredFilter(
      stored({ hideFuture: "yes", amountMin: "500", q: 42, categoryIds: "101" }),
    );
    expect(parsed.hideFuture).toBe(DEFAULT_FILTER.hideFuture);
    expect(parsed.amountMin).toBeNull();
    expect(parsed.q).toBe("");
    expect(parsed.categoryIds).toEqual([]);
  });

  it("配列の中の異物だけ落とす", () => {
    const parsed = parseStoredFilter(stored({ categoryIds: [101, "102", null, 103.5, 104] }));
    expect(parsed.categoryIds).toEqual([101, 104]);
  });

  it("知らない期間プリセットは既定に倒す", () => {
    expect(parseStoredFilter(stored({ period: "last-week" })).period).toBe(DEFAULT_FILTER.period);
  });

  it("日付は書式が合うものだけ通す", () => {
    const parsed = parseStoredFilter(stored({ dateFrom: "2026-01-01", dateTo: "2026/03/31" }));
    expect(parsed.dateFrom).toBe("2026-01-01");
    expect(parsed.dateTo).toBeNull();
  });

  it("負の金額は受け付けない", () => {
    expect(parseStoredFilter(stored({ amountMin: -1 })).amountMin).toBeNull();
  });

  it("上限を超えた金額は落とす（起動しただけで 400 になるのを防ぐ）", () => {
    expect(parseStoredFilter(stored({ amountMin: MAX_AMOUNT })).amountMin).toBe(MAX_AMOUNT);
    expect(parseStoredFilter(stored({ amountMin: MAX_AMOUNT + 1 })).amountMin).toBeNull();
  });

  it("種別が空になったら既定に戻す（API では指定なし = 全件になるため）", () => {
    expect(parseStoredFilter(stored({ modes: [] })).modes).toEqual(DEFAULT_FILTER.modes);
    expect(parseStoredFilter(stored({ modes: ["unknown"] })).modes).toEqual(DEFAULT_FILTER.modes);
  });

  it("種別は保存された順ではなく表示順に揃える", () => {
    expect(parseStoredFilter(stored({ modes: ["transfer", "payment"] })).modes).toEqual([
      "payment",
      "transfer",
    ]);
  });
});
