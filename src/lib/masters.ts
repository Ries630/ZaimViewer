/**
 * マスタ（カテゴリ・ジャンル・口座）から選択肢を組み立てる。
 *
 * 選択肢は互いに従属する。カテゴリは種別（支出 / 収入）に、ジャンルはカテゴリに
 * 属するので、上位の選択を変えると下位の選択肢が変わる。**そのとき下位の選択を
 * 残したままにすると「画面に出ていない条件」が効き続けて件数が合わなくなる**ので、
 * `reconcile` で必ず落とす。
 */

import type { Masters } from "../api/masters";
import type { FilterState, NameLookup } from "./filter";

/** カテゴリ 1 件。 */
export type Category = Masters["categories"][number];
/** ジャンル 1 件。 */
export type Genre = Masters["genres"][number];
/** 口座 1 件。 */
export type Account = Masters["accounts"][number];

/**
 * 種別に対応するカテゴリだけを返す。
 *
 * 振替はカテゴリを持たないので、振替だけを選ぶとカテゴリは 0 件になる。
 *
 * @param categories 全カテゴリ。
 * @param modes 選択中の種別。
 * @returns 該当するカテゴリ。API の並び順を保つ。
 */
export function categoriesForModes(categories: Category[], modes: string[]): Category[] {
  // mode が空のカテゴリは、どの種別に属するか決められないので常に選択肢に残す
  return categories.filter((category) => category.mode === null || modes.includes(category.mode));
}

/**
 * カテゴリに属するジャンルだけを返す。
 *
 * カテゴリが未選択なら絞り込まない（「指定なし = 制限なし」を選択肢の側でも守る）。
 *
 * @param genres 全ジャンル。
 * @param categoryIds 選択中のカテゴリ ID。
 * @returns 該当するジャンル。API の並び順を保つ。
 */
export function genresForCategories(genres: Genre[], categoryIds: number[]): Genre[] {
  if (categoryIds.length === 0) return genres;
  return genres.filter(
    (genre) => genre.category_id !== null && categoryIds.includes(genre.category_id),
  );
}

/** カテゴリごとにまとめたジャンル。 */
export interface GenreGroup {
  /** カテゴリ ID。カテゴリに紐付かないジャンルは null。 */
  categoryId: number | null;
  /** カテゴリ名。引けなければ「その他」。 */
  categoryName: string;
  /** そのカテゴリのジャンル。 */
  genres: Genre[];
}

/**
 * ジャンルをカテゴリごとにまとめる。
 *
 * ジャンルは 129 件あり、平坦に並べると選べたものではない。
 *
 * @param genres まとめるジャンル。
 * @param categories カテゴリ名を引くための全カテゴリ。
 * @returns カテゴリごとのまとまり。入力の並び順を保つ。
 */
export function groupGenresByCategory(genres: Genre[], categories: Category[]): GenreGroup[] {
  const nameOf = new Map(categories.map((category) => [category.id, category.name]));
  const groups: GenreGroup[] = [];

  for (const genre of genres) {
    const last = groups.at(-1);
    if (last?.categoryId === genre.category_id) {
      last.genres.push(genre);
    } else {
      groups.push({
        categoryId: genre.category_id,
        categoryName:
          (genre.category_id === null ? undefined : nameOf.get(genre.category_id)) ?? "その他",
        genres: [genre],
      });
    }
  }

  return groups;
}

/**
 * ID から名前を引く索引を作る。
 *
 * @param items 名前を持つマスタ。
 * @returns ID から名前への Map。名前が空なら undefined になる。
 */
function indexNames(items: { id: number; name: string | null }[]): Map<number, string | undefined> {
  return new Map(items.map((item) => [item.id, item.name ?? undefined]));
}

/**
 * マスタ ID から名前を引く関数の組を作る。
 *
 * @param masters マスタ一式。未取得なら undefined。
 * @returns 名前を引く関数。未取得のときは常に undefined を返す。
 */
export function nameLookup(masters: Masters | undefined): NameLookup {
  const categories = indexNames(masters?.categories ?? []);
  const genres = indexNames(masters?.genres ?? []);
  const accounts = indexNames(masters?.accounts ?? []);

  return {
    category: (id) => categories.get(id),
    genre: (id) => genres.get(id),
    account: (id) => accounts.get(id),
  };
}

/**
 * 選択肢から外れた選択を落とす。
 *
 * 種別を外すとそのカテゴリが、カテゴリを外すとそのジャンルが選べなくなる。
 * 口座は他の選択に従属しないが、削除済みで明細からも参照されなくなったものは
 * API が返さなくなるので、同じくここで落とす（ADR-0027）。
 * 除外ジャンルは対象にしない（選択肢の従属関係に無く、外れたまま残っていても
 * 「一致しないので何も除外しない」で済むため）。
 *
 * 変化が無ければ元のオブジェクトをそのまま返す。
 *
 * @param state 絞り込みの状態。
 * @param masters マスタ一式。未取得なら判定できないので何もしない。
 * @returns 整合を取った状態。
 */
export function reconcile(state: FilterState, masters: Masters | undefined): FilterState {
  if (!masters) return state;

  const allowedCategories = new Set(
    categoriesForModes(masters.categories, state.modes).map((category) => category.id),
  );
  const categoryIds = state.categoryIds.filter((id) => allowedCategories.has(id));

  const allowedGenres = new Set(
    genresForCategories(masters.genres, categoryIds).map((genre) => genre.id),
  );
  const genreIds = state.genreIds.filter((id) => allowedGenres.has(id));

  const allowedAccounts = new Set(masters.accounts.map((account) => account.id));
  const accountIds = state.accountIds.filter((id) => allowedAccounts.has(id));

  if (
    categoryIds.length === state.categoryIds.length &&
    genreIds.length === state.genreIds.length &&
    accountIds.length === state.accountIds.length
  ) {
    return state;
  }
  return { ...state, categoryIds, genreIds, accountIds };
}
