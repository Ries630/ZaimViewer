import { describe, expect, it } from "vitest";

import {
  formatAbsoluteTime,
  formatAmount,
  formatCount,
  formatDateHeading,
  formatRelativeTime,
  isFutureDate,
  isStale,
  todayInTokyo,
} from "./format";

/** 基準時刻。JST では 2026-08-11 15:40。 */
const NOW = new Date("2026-08-11T06:40:00.000Z");

describe("formatAmount", () => {
  it("JPY は小数を出さず、CLDR の通貨記号を使う", () => {
    // ja-JP の JPY は全角の ￥（U+FFE5）。半角の ¥ ではない。
    // Bun の JavaScriptCore は半角を返すが、workerd とブラウザは CLDR に従う
    expect(formatAmount(2375, "JPY")).toBe("￥2,375");
  });

  it("通貨コードが無ければ JPY と見なす", () => {
    expect(formatAmount(2375, null)).toBe("￥2,375");
  });

  it("負の金額を符号付きで出す", () => {
    // 実データに -150 円の payment がある
    expect(formatAmount(-150, "JPY")).toBe("-￥150");
  });

  it("JPY 以外も扱える", () => {
    // 4,370 件中 1 件だけ USD がある
    expect(formatAmount(16026, "USD")).toBe("$16,026.00");
  });
});

describe("formatCount", () => {
  it("桁区切りを入れる", () => {
    expect(formatCount(4370)).toBe("4,370");
  });
});

describe("formatDateHeading", () => {
  it("曜日付きで出す", () => {
    expect(formatDateHeading("2026-08-08")).toBe("2026年8月8日(土)");
  });

  it("UTC で解釈するので日付がずれない", () => {
    // ローカル時刻で解釈すると環境によっては前日になる
    expect(formatDateHeading("2026-01-01")).toBe("2026年1月1日(木)");
  });
});

describe("formatAbsoluteTime", () => {
  it("UTC の ISO 文字列を JST で出す", () => {
    expect(formatAbsoluteTime("2026-08-11T06:40:30.512Z")).toBe("2026年8月11日 15:40");
  });
});

describe("formatRelativeTime", () => {
  it("1 分未満はたった今", () => {
    expect(formatRelativeTime("2026-08-11T06:39:30.000Z", NOW)).toBe("たった今");
  });

  it("1 時間未満は分で出す", () => {
    expect(formatRelativeTime("2026-08-11T06:10:00.000Z", NOW)).toBe("30 分前");
  });

  it("1 日未満は時間で出す", () => {
    expect(formatRelativeTime("2026-08-11T03:40:00.000Z", NOW)).toBe("3 時間前");
  });

  it("前日は昨日と出す", () => {
    expect(formatRelativeTime("2026-08-10T06:40:00.000Z", NOW)).toBe("昨日");
  });

  it("同期が飛んでいれば日数で出る", () => {
    // 「3 日前」と出ること自体が同期の停止を知らせる
    expect(formatRelativeTime("2026-08-08T06:40:00.000Z", NOW)).toBe("3 日前");
  });

  it("30 日を超えたら月で出す", () => {
    expect(formatRelativeTime("2026-06-11T06:40:00.000Z", NOW)).toBe("2 か月前");
  });
});

describe("isStale", () => {
  it("36 時間以内なら古くない", () => {
    expect(isStale("2026-08-10T00:00:00.000Z", NOW)).toBe(false);
  });

  it("36 時間を超えたら古い", () => {
    // 同期は毎日 1 回なので、この時点で 1 回分飛んでいる
    expect(isStale("2026-08-09T18:00:00.000Z", NOW)).toBe(true);
  });
});

describe("todayInTokyo", () => {
  it("JST の暦日を返す", () => {
    expect(todayInTokyo(NOW)).toBe("2026-08-11");
  });

  it("UTC で前日でも JST では翌日になる", () => {
    expect(todayInTokyo(new Date("2026-08-11T15:30:00.000Z"))).toBe("2026-08-12");
  });
});

describe("isFutureDate", () => {
  it("今日は未来ではない", () => {
    expect(isFutureDate("2026-08-11", "2026-08-11")).toBe(false);
  });

  it("繰り返し登録の家賃は未来として拾える", () => {
    expect(isFutureDate("2029-12-01", "2026-08-11")).toBe(true);
  });

  it("過去は未来ではない", () => {
    expect(isFutureDate("2014-02-01", "2026-08-11")).toBe(false);
  });
});
