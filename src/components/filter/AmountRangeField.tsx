/**
 * 金額の範囲指定。
 */

import type { FilterState } from "../../lib/filter";

interface AmountRangeFieldProps {
  /** 現在の状態。 */
  filter: FilterState;
  /** 状態を差し替える。 */
  onChange: (next: FilterState) => void;
}

/**
 * 入力値を金額に変換する。
 *
 * 空欄は「指定なし」。負数と小数は API が弾くので、ここでも通さない。
 *
 * @param value 入力欄の値。
 * @returns 金額。指定なしなら null。
 */
function toAmount(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * 金額の下限と上限。
 *
 * 既定では下限に 1,000 が入っている（自動連携の細かな履歴を落とすため）。
 * 手数料のような少額を見たいときは、ここを空にする。
 *
 * @param props 状態と更新関数。
 * @returns 金額の入力欄。
 */
export function AmountRangeField({ filter, onChange }: AmountRangeFieldProps) {
  return (
    <fieldset className="fieldset">
      <legend className="fieldset-legend">金額</legend>
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          placeholder="下限"
          className="input input-sm grow tabular-nums"
          aria-label="金額の下限"
          value={filter.amountMin ?? ""}
          onChange={(event) => onChange({ ...filter, amountMin: toAmount(event.target.value) })}
        />
        <span aria-hidden="true">〜</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          placeholder="上限"
          className="input input-sm grow tabular-nums"
          aria-label="金額の上限"
          value={filter.amountMax ?? ""}
          onChange={(event) => onChange({ ...filter, amountMax: toAmount(event.target.value) })}
        />
        <span className="text-sm text-base-content/60">円</span>
      </div>
    </fieldset>
  );
}
