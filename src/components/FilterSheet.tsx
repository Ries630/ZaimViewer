/**
 * 絞り込みのシート。
 */

import type { RefObject } from "react";

import type { Masters } from "../api/masters";
import { formatCount } from "../lib/format";
import type { FilterState } from "../lib/filter";
import { categoriesForModes, genresForCategories, groupGenresByCategory } from "../lib/masters";
import { AmountRangeField } from "./filter/AmountRangeField";
import { ExcludePlaceField } from "./filter/ExcludePlaceField";
import { MasterMultiSelect, type OptionGroup } from "./filter/MasterMultiSelect";
import { ModeField } from "./filter/ModeField";
import { PeriodField } from "./filter/PeriodField";

interface FilterSheetProps {
  /** シートの開閉を親が握るための参照。 */
  ref: RefObject<HTMLDialogElement | null>;
  /** 現在の状態。 */
  filter: FilterState;
  /** 選択肢のマスタ。未取得なら undefined。 */
  masters: Masters | undefined;
  /** JST の今日（`YYYY-MM-DD`）。 */
  today: string;
  /** 現在の条件に一致する件数。未取得なら undefined。 */
  total: number | undefined;
  /** 状態を差し替える。 */
  onChange: (next: FilterState) => void;
  /** 既定に戻す。 */
  onReset: () => void;
}

/**
 * ジャンルをカテゴリごとの選択肢にまとめる。
 *
 * @param genres 対象のジャンル。
 * @param masters カテゴリ名を引くためのマスタ。
 * @returns 見出し付きの選択肢。
 */
function genreGroups(genres: Masters["genres"], masters: Masters): OptionGroup[] {
  return groupGenresByCategory(genres, masters.categories).map((group) => ({
    key: String(group.categoryId ?? "none"),
    label: group.categoryName,
    options: group.genres,
  }));
}

/**
 * 下から出る絞り込みシート。
 *
 * **変更は即座に反映する。** 条件をいじりながら件数が動くのが「どのノイズを
 * 消したいか」を探る作業そのものなので、「適用」で確定させる形は取らない。
 * 下端のボタンは件数を出して閉じるだけ。
 *
 * @param props 状態・マスタ・更新関数。
 * @returns 絞り込みシート。
 */
export function FilterSheet({
  ref,
  filter,
  masters,
  today,
  total,
  onChange,
  onReset,
}: FilterSheetProps) {
  const categories = masters ? categoriesForModes(masters.categories, filter.modes) : [];
  const genres = masters ? genresForCategories(masters.genres, filter.categoryIds) : [];

  return (
    <dialog ref={ref} className="modal modal-bottom sm:modal-middle" aria-label="絞り込み">
      <div className="modal-box flex max-h-[85vh] flex-col gap-3 p-0">
        <div className="flex items-baseline justify-between border-b border-base-300 px-5 pt-5 pb-3">
          <h2 className="text-base font-bold">絞り込み</h2>
          <button type="button" className="btn btn-ghost btn-xs" onClick={onReset}>
            既定に戻す
          </button>
        </div>

        <div className="flex flex-col gap-2 overflow-y-auto px-5">
          <PeriodField filter={filter} today={today} onChange={onChange} />
          <ModeField filter={filter} onChange={onChange} />

          <MasterMultiSelect
            legend="カテゴリ"
            groups={[{ key: "categories", label: null, options: categories }]}
            selected={filter.categoryIds}
            emptyLabel="選んだ種別にカテゴリが無い（振替はカテゴリを持たない）"
            onChange={(categoryIds) => onChange({ ...filter, categoryIds })}
          />

          <MasterMultiSelect
            legend="ジャンル"
            groups={masters ? genreGroups(genres, masters) : []}
            selected={filter.genreIds}
            emptyLabel="選んだカテゴリにジャンルが無い"
            onChange={(genreIds) => onChange({ ...filter, genreIds })}
          />

          <MasterMultiSelect
            legend="口座"
            groups={[{ key: "accounts", label: null, options: masters?.accounts ?? [] }]}
            selected={filter.accountIds}
            emptyLabel="口座が無い"
            onChange={(accountIds) => onChange({ ...filter, accountIds })}
          />

          <AmountRangeField filter={filter} onChange={onChange} />
          <ExcludePlaceField filter={filter} onChange={onChange} />

          <MasterMultiSelect
            legend="ジャンルを除外"
            // 除外はカテゴリの選択に従属させない。今の選択の外にあるジャンルを
            // 落としておきたい場面があるため
            groups={masters ? genreGroups(masters.genres, masters) : []}
            selected={filter.excludeGenreIds}
            emptyLabel="ジャンルが無い"
            onChange={(excludeGenreIds) => onChange({ ...filter, excludeGenreIds })}
          />
        </div>

        <form method="dialog" className="border-t border-base-300 px-5 pt-3 pb-safe-bottom">
          <button className="btn btn-block btn-primary mb-5">
            {total === undefined ? "閉じる" : `${formatCount(total)} 件を表示`}
          </button>
        </form>
      </div>

      <form method="dialog" className="modal-backdrop">
        <button>閉じる</button>
      </form>
    </dialog>
  );
}
