import { describe, expect, it } from "vitest";

import { MAX_AMOUNT } from "../../worker/src/limits";
import {
  DEFAULT_FILTER,
  type FilterState,
  type NameLookup,
  activeBadges,
  parseAmount,
  toTransactionFilter,
} from "./filter";

/** テストの基準日。ミラーの未来分（2029-12 まで）より十分手前に置く。 */
const TODAY = "2026-08-13";

/** 名前の引き当て。ラベルの組み立てだけに使うので、必要な分しか用意しない。 */
const names: NameLookup = {
  category: (id) => (id === 101 ? "食費" : undefined),
  genre: (id) => (id === 201 ? "食料品" : undefined),
  account: (id) => (id === 301 ? "楽天カード" : undefined),
};

/**
 * 既定を土台に一部だけ差し替えた状態を作る。
 *
 * @param overrides 差し替える項目。
 * @returns フィルタ状態。
 */
function stateWith(overrides: Partial<FilterState>): FilterState {
  return { ...DEFAULT_FILTER, ...overrides };
}

describe("toTransactionFilter", () => {
  it("既定は振替を外して未来を隠すだけ。金額は絞らない", () => {
    const query = toTransactionFilter(DEFAULT_FILTER, TODAY);

    expect(query.mode).toEqual(["payment", "income"]);
    expect(query.date_to).toBe(TODAY);
    // 指定していない条件はキーごと落ちる（hono のクライアントが undefined を
    // クエリ文字列に出さないので、そのまま「指定なし = 制限なし」になる）
    expect(query.amount_min).toBeUndefined();
    expect(query.date_from).toBeUndefined();
    expect(query.category_id).toBeUndefined();
    expect(query.q).toBeUndefined();
  });

  it("種別が 3 つとも選ばれていれば条件を課さない", () => {
    const query = toTransactionFilter(
      stateWith({ modes: ["payment", "income", "transfer"] }),
      TODAY,
    );
    expect(query.mode).toBeUndefined();
  });

  it("未来を隠すと、プリセットの終了日も今日に丸まる", () => {
    // 今月の月末は 2026-08-31 だが、未来分は隠したままにする
    const query = toTransactionFilter(stateWith({ period: "this-month" }), TODAY);
    expect(query.date_from).toBe("2026-08-01");
    expect(query.date_to).toBe(TODAY);
  });

  it("未来を隠さなければプリセットの終了日がそのまま出る", () => {
    const query = toTransactionFilter(
      stateWith({ period: "this-month", hideFuture: false }),
      TODAY,
    );
    expect(query.date_to).toBe("2026-08-31");
  });

  it("未来を隠さず期間も未指定なら終了日を送らない", () => {
    const query = toTransactionFilter(stateWith({ hideFuture: false }), TODAY);
    expect(query.date_to).toBeUndefined();
  });

  it("custom は利用者の入力をそのまま使う", () => {
    const query = toTransactionFilter(
      stateWith({ period: "custom", dateFrom: "2026-01-01", dateTo: "2026-03-31" }),
      TODAY,
    );
    expect(query.date_from).toBe("2026-01-01");
    expect(query.date_to).toBe("2026-03-31");
  });

  it("ID は文字列の配列にする", () => {
    const query = toTransactionFilter(stateWith({ categoryIds: [101, 102] }), TODAY);
    expect(query.category_id).toEqual(["101", "102"]);
  });

  it("キーワードは前後の空白を落として送る", () => {
    expect(toTransactionFilter(stateWith({ q: "  スーパー " }), TODAY).q).toBe("スーパー");
  });

  it("空白だけのキーワードは送らない", () => {
    expect(toTransactionFilter(stateWith({ q: "   " }), TODAY).q).toBeUndefined();
  });

  it("48 バイトを超えるキーワードは送らない（400 を返させない）", () => {
    // 日本語 17 文字 = 51 バイト
    expect(toTransactionFilter(stateWith({ q: "あ".repeat(17) }), TODAY).q).toBeUndefined();
    expect(toTransactionFilter(stateWith({ q: "あ".repeat(16) }), TODAY).q).toBe("あ".repeat(16));
  });

  it("金額の上限だけでも送れる", () => {
    const query = toTransactionFilter(stateWith({ amountMin: null, amountMax: 5000 }), TODAY);
    expect(query.amount_min).toBeUndefined();
    expect(query.amount_max).toBe("5000");
  });

  it("金額 0 を下限に指定したら送る（null との取り違えを防ぐ）", () => {
    expect(toTransactionFilter(stateWith({ amountMin: 0 }), TODAY).amount_min).toBe("0");
  });
});

describe("parseAmount", () => {
  it("空欄は指定なし", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("   ")).toBeNull();
  });

  it("0 以上の整数はそのまま通す", () => {
    expect(parseAmount("0")).toBe(0);
    expect(parseAmount("1000")).toBe(1000);
  });

  it("上限ちょうどは通し、1 超えたら弾く", () => {
    expect(parseAmount("999999999")).toBe(MAX_AMOUNT);
    expect(parseAmount("1000000000")).toBe("invalid");
  });

  it("API が 400 を返す桁数に届かない", () => {
    // 安全な整数（2^53-1）を超えると zod の .int() が too_big で 400 を返す。
    // UI で止めるので、その値が state に入ることはない
    expect(parseAmount("9007199254740993")).toBe("invalid");
  });

  it("負数・小数・数値でないものは弾く（null にせず入力を残す）", () => {
    expect(parseAmount("-1")).toBe("invalid");
    expect(parseAmount("1.5")).toBe("invalid");
    expect(parseAmount("abc")).toBe("invalid");
  });
});

describe("activeBadges", () => {
  it("既定では未来と種別の 2 つが立つ", () => {
    const badges = activeBadges(DEFAULT_FILTER, TODAY, names);
    expect(badges.map((badge) => badge.key)).toEqual(["hideFuture", "modes"]);
    expect(badges.map((badge) => badge.label)).toEqual(["未来を隠す", "支出・収入"]);
  });

  it("何も絞っていなければ空になる", () => {
    const badges = activeBadges(
      stateWith({ hideFuture: false, modes: ["payment", "income", "transfer"] }),
      TODAY,
      names,
    );
    expect(badges).toEqual([]);
  });

  it("バッジは自分を外した状態を持つ", () => {
    const state = stateWith({ amountMin: 1000 });
    const future = activeBadges(state, TODAY, names).find((badge) => badge.key === "hideFuture");
    expect(future?.next.hideFuture).toBe(false);
    // 他の条件は巻き添えにしない
    expect(future?.next.amountMin).toBe(1000);
  });

  it("カテゴリを外すバッジはジャンルの選択も落とす", () => {
    const state = stateWith({ categoryIds: [101], genreIds: [201] });
    const badge = activeBadges(state, TODAY, names).find((item) => item.key === "categories");
    expect(badge?.next.categoryIds).toEqual([]);
    expect(badge?.next.genreIds).toEqual([]);
  });

  it("選択が 1 つなら名前、複数なら件数を出す", () => {
    const one = activeBadges(stateWith({ categoryIds: [101] }), TODAY, names);
    expect(one.find((badge) => badge.key === "categories")?.label).toBe("カテゴリ: 食費");

    const many = activeBadges(stateWith({ categoryIds: [101, 102] }), TODAY, names);
    expect(many.find((badge) => badge.key === "categories")?.label).toBe("カテゴリ 2 件");
  });

  it("名前を引けなければ件数に倒す", () => {
    const badges = activeBadges(stateWith({ accountIds: [999] }), TODAY, names);
    expect(badges.find((badge) => badge.key === "accounts")?.label).toBe("口座 1 件");
  });

  it("期間はプリセット名、custom なら日付を出す", () => {
    const preset = activeBadges(stateWith({ period: "last-month" }), TODAY, names);
    expect(preset.find((badge) => badge.key === "period")?.label).toBe("先月");

    const custom = activeBadges(
      stateWith({ period: "custom", dateFrom: "2026-01-01", dateTo: "2026-03-31" }),
      TODAY,
      names,
    );
    expect(custom.find((badge) => badge.key === "period")?.label).toBe("2026-01-01 〜 2026-03-31");
  });

  it("金額は範囲の指定の仕方でラベルが変わる", () => {
    const labelOf = (min: number | null, max: number | null) =>
      activeBadges(stateWith({ amountMin: min, amountMax: max }), TODAY, names).find(
        (badge) => badge.key === "amount",
      )?.label;

    expect(labelOf(1000, null)).toBe("1,000 円 以上");
    expect(labelOf(null, 5000)).toBe("5,000 円 以下");
    expect(labelOf(1000, 5000)).toBe("1,000 円 〜 5,000 円");
    expect(labelOf(null, null)).toBeUndefined();
  });

  it("除外はラベルで除外だと分かる", () => {
    const places = activeBadges(stateWith({ excludePlaces: ["ヨドバシ"] }), TODAY, names);
    expect(places.find((badge) => badge.key === "excludePlaces")?.label).toBe("ヨドバシ を除外");

    const genres = activeBadges(stateWith({ excludeGenreIds: [201] }), TODAY, names);
    expect(genres.find((badge) => badge.key === "excludeGenres")?.label).toBe(
      "ジャンル: 食料品を除外",
    );
  });
});
