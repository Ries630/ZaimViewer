import { describe, expect, it } from "vitest";

import type { Masters } from "../api/masters";
import { DEFAULT_FILTER, type FilterState } from "./filter";
import {
  categoriesForModes,
  genresForCategories,
  groupGenresByCategory,
  nameLookup,
  reconcile,
} from "./masters";

/** 本物と同じ形の小さなマスタ。API の並び順（mode / category_id ごと）を再現する。 */
const masters: Masters = {
  categories: [
    { id: 101, mode: "payment", name: "食費", sort: 1, active: 1 },
    { id: 102, mode: "payment", name: "日用雑貨", sort: 2, active: 1 },
    { id: 201, mode: "income", name: "給与", sort: 1, active: 1 },
  ],
  genres: [
    { id: 1101, category_id: 101, name: "食料品", sort: 1, active: 1 },
    { id: 1102, category_id: 101, name: "外食", sort: 2, active: 1 },
    { id: 1201, category_id: 102, name: "消耗品", sort: 1, active: 1 },
    { id: 2101, category_id: 201, name: "給与", sort: 1, active: 1 },
  ],
  accounts: [
    { id: 301, name: "楽天カード", sort: 1, active: 1 },
    { id: 302, name: "現金", sort: 2, active: 1 },
  ],
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

describe("categoriesForModes", () => {
  it("種別に対応するカテゴリだけ残す", () => {
    expect(categoriesForModes(masters.categories, ["payment"]).map((c) => c.id)).toEqual([
      101, 102,
    ]);
    expect(categoriesForModes(masters.categories, ["income"]).map((c) => c.id)).toEqual([201]);
  });

  it("振替だけならカテゴリは無くなる（振替はカテゴリを持たない）", () => {
    expect(categoriesForModes(masters.categories, ["transfer"])).toEqual([]);
  });

  it("mode が空のカテゴリは常に残す", () => {
    const withNull = [
      ...masters.categories,
      { id: 999, mode: null, name: "不明", sort: 9, active: 1 },
    ];
    expect(categoriesForModes(withNull, ["transfer"]).map((c) => c.id)).toEqual([999]);
  });
});

describe("genresForCategories", () => {
  it("カテゴリ未選択なら絞り込まない", () => {
    expect(genresForCategories(masters.genres, [])).toEqual(masters.genres);
  });

  it("選んだカテゴリのジャンルだけ残す", () => {
    expect(genresForCategories(masters.genres, [101]).map((g) => g.id)).toEqual([1101, 1102]);
    expect(genresForCategories(masters.genres, [101, 102]).map((g) => g.id)).toEqual([
      1101, 1102, 1201,
    ]);
  });

  it("カテゴリに紐付かないジャンルは絞り込みで落ちる", () => {
    const orphan = [
      ...masters.genres,
      { id: 9999, category_id: null, name: "不明", sort: 9, active: 1 },
    ];
    expect(genresForCategories(orphan, [101]).map((g) => g.id)).toEqual([1101, 1102]);
  });
});

describe("groupGenresByCategory", () => {
  it("カテゴリごとにまとめ、見出しに名前を付ける", () => {
    const groups = groupGenresByCategory(masters.genres, masters.categories);
    expect(groups.map((group) => group.categoryName)).toEqual(["食費", "日用雑貨", "給与"]);
    expect(groups[0]?.genres.map((g) => g.id)).toEqual([1101, 1102]);
  });

  it("名前を引けないカテゴリは「その他」になる", () => {
    const orphan = [{ id: 9999, category_id: null, name: "不明", sort: 9, active: 1 }];
    expect(groupGenresByCategory(orphan, masters.categories)[0]?.categoryName).toBe("その他");
  });

  it("空なら空になる", () => {
    expect(groupGenresByCategory([], masters.categories)).toEqual([]);
  });
});

describe("nameLookup", () => {
  it("ID から名前を引く", () => {
    const names = nameLookup(masters);
    expect(names.category(101)).toBe("食費");
    expect(names.genre(1102)).toBe("外食");
    expect(names.account(301)).toBe("楽天カード");
    expect(names.category(999)).toBeUndefined();
  });

  it("マスタ未取得なら常に undefined を返す", () => {
    const names = nameLookup(undefined);
    expect(names.category(101)).toBeUndefined();
  });
});

describe("reconcile", () => {
  it("マスタ未取得なら何もしない", () => {
    const state = stateWith({ categoryIds: [101] });
    expect(reconcile(state, undefined)).toBe(state);
  });

  it("変化が無ければ同じオブジェクトを返す", () => {
    const state = stateWith({ categoryIds: [101], genreIds: [1101] });
    expect(reconcile(state, masters)).toBe(state);
  });

  it("種別から外れたカテゴリを落とす", () => {
    const state = stateWith({ modes: ["payment"], categoryIds: [101, 201] });
    expect(reconcile(state, masters).categoryIds).toEqual([101]);
  });

  it("カテゴリを落とすと、そのカテゴリのジャンルも落ちる", () => {
    // 収入を外したので、給与カテゴリとその配下のジャンルが消える
    const state = stateWith({
      modes: ["payment"],
      categoryIds: [101, 201],
      genreIds: [1101, 2101],
    });
    const next = reconcile(state, masters);
    expect(next.categoryIds).toEqual([101]);
    expect(next.genreIds).toEqual([1101]);
  });

  it("カテゴリが未選択ならジャンルは絞られない", () => {
    const state = stateWith({ categoryIds: [], genreIds: [1101, 2101] });
    expect(reconcile(state, masters).genreIds).toEqual([1101, 2101]);
  });

  it("除外ジャンルは巻き込まない（選択肢の従属関係に無いため）", () => {
    const state = stateWith({ modes: ["payment"], excludeGenreIds: [2101] });
    expect(reconcile(state, masters).excludeGenreIds).toEqual([2101]);
  });
});
