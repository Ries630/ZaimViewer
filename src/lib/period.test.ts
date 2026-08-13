import { describe, expect, it } from "vitest";

import { clampToToday, rangeOfPreset } from "./period";

describe("rangeOfPreset", () => {
  it("all は両端とも制限しない", () => {
    expect(rangeOfPreset("all", "2026-08-13")).toEqual({ from: null, to: null });
  });

  it("custom は利用者の入力を使うので何も決めない", () => {
    expect(rangeOfPreset("custom", "2026-08-13")).toEqual({ from: null, to: null });
  });

  it("今月は月初から月末まで（今日で切らない）", () => {
    expect(rangeOfPreset("this-month", "2026-08-13")).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
  });

  it("今月の月末は月ごとの日数に従う", () => {
    // 閏年の 2 月
    expect(rangeOfPreset("this-month", "2028-02-10").to).toBe("2028-02-29");
    expect(rangeOfPreset("this-month", "2026-02-10").to).toBe("2026-02-28");
  });

  it("先月は前月の月初から月末まで", () => {
    expect(rangeOfPreset("last-month", "2026-08-13")).toEqual({
      from: "2026-07-01",
      to: "2026-07-31",
    });
  });

  it("先月は年をまたいでも前年の 12 月になる", () => {
    expect(rangeOfPreset("last-month", "2026-01-05")).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
  });

  it("先月は月末の日から見ても前月に落ちる", () => {
    // 3/31 の 1 か月前を素朴に計算すると 2/31 → 3/3 に繰り上がって
    // 「先月」のはずが今月になる。day: 1 に寄せてから引いているので起きない
    expect(rangeOfPreset("last-month", "2026-03-31")).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
  });

  it("3 か月は相対期間なので同日から今日まで", () => {
    expect(rangeOfPreset("last-3-months", "2026-08-13")).toEqual({
      from: "2026-05-13",
      to: "2026-08-13",
    });
  });

  it("3 か月前が存在しない日なら月末に丸める", () => {
    // Temporal の既定の constrain。`new Date(2026, 4, 31)` 相当の計算だと
    // 3/3 に繰り上がり、期間が 3 か月より短くなる
    expect(rangeOfPreset("last-3-months", "2026-05-31").from).toBe("2026-02-28");
    expect(rangeOfPreset("last-3-months", "2028-05-31").from).toBe("2028-02-29");
  });

  it("今年は 1/1 から 12/31 まで", () => {
    expect(rangeOfPreset("this-year", "2026-08-13")).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
    });
  });
});

describe("clampToToday", () => {
  it("未指定なら今日になる", () => {
    expect(clampToToday(null, "2026-08-13")).toBe("2026-08-13");
  });

  it("今日より後なら今日に丸める", () => {
    expect(clampToToday("2029-12-31", "2026-08-13")).toBe("2026-08-13");
  });

  it("今日より前ならそのまま", () => {
    expect(clampToToday("2026-07-31", "2026-08-13")).toBe("2026-07-31");
  });

  it("今日と同じならそのまま", () => {
    expect(clampToToday("2026-08-13", "2026-08-13")).toBe("2026-08-13");
  });
});
