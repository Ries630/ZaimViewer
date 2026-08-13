/**
 * 金額の範囲指定。
 */

import { MAX_AMOUNT } from "../../../worker/src/limits";
import { type FilterState, parseAmount } from "../../lib/filter";

interface AmountRangeFieldProps {
  /** 現在の状態。 */
  filter: FilterState;
  /** 状態を差し替える。 */
  onChange: (next: FilterState) => void;
}

/**
 * 金額の下限と上限。
 *
 * 既定は両方とも未指定。自動連携の細かな履歴を落としたいときは、
 * ここに下限を入れる。
 *
 * **受け付けない入力は状態を更新しない。** 小数や上限超過を `null` に倒すと、
 * 入力途中の値が消えて打ち直しになる。
 *
 * @param props 状態と更新関数。
 * @returns 金額の入力欄。
 */
export function AmountRangeField({ filter, onChange }: AmountRangeFieldProps) {
  /**
   * 入力を状態に落とす。受け付けられない値なら何もしない。
   *
   * @param side 変更された側。
   * @param value 入力欄の値。
   */
  const change = (side: "amountMin" | "amountMax", value: string) => {
    const parsed = parseAmount(value);
    if (parsed === "invalid") return;
    onChange({ ...filter, [side]: parsed });
  };

  return (
    <fieldset className="fieldset">
      <legend className="fieldset-legend">金額</legend>
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_AMOUNT}
          step={1}
          placeholder="下限"
          className="input grow tabular-nums"
          aria-label="金額の下限"
          value={filter.amountMin ?? ""}
          onChange={(event) => change("amountMin", event.target.value)}
        />
        <span aria-hidden="true">〜</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_AMOUNT}
          step={1}
          placeholder="上限"
          className="input grow tabular-nums"
          aria-label="金額の上限"
          value={filter.amountMax ?? ""}
          onChange={(event) => change("amountMax", event.target.value)}
        />
        <span className="text-sm text-base-content/60">円</span>
      </div>
      <p className="label">9 桁まで</p>
    </fieldset>
  );
}
