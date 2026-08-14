/**
 * 期間の指定。
 */

import type { FilterState } from "../../lib/filter";
import { rangeOf } from "../../lib/filter";
import { PERIOD_PRESETS } from "../../lib/period";

interface PeriodFieldProps {
  /** 現在の状態。 */
  filter: FilterState;
  /** JST の今日（`YYYY-MM-DD`）。 */
  today: string;
  /** 状態を差し替える。 */
  onChange: (next: FilterState) => void;
}

/**
 * プリセットと日付の直接指定、「未来を隠す」。
 *
 * 日付欄にはプリセットが計算した期間を出す。何が効いているかを日付で見せるためで、
 * 利用者が日付を触ったらプリセットの選択は `custom` に移る。
 *
 * @param props 状態と更新関数。
 * @returns 期間の入力欄。
 */
export function PeriodField({ filter, today, onChange }: PeriodFieldProps) {
  const range = rangeOf(filter, today);

  /**
   * 日付欄の変更を状態に落とす。
   *
   * @param side 変更された側。
   * @param value 入力された日付。空文字なら未指定。
   */
  const changeDate = (side: "from" | "to", value: string) => {
    const next = value === "" ? null : value;
    onChange({
      ...filter,
      period: "custom",
      // プリセットから移るときは、触っていない側に計算済みの日付を引き継ぐ
      dateFrom: side === "from" ? next : range.from,
      dateTo: side === "to" ? next : range.to,
    });
  };

  return (
    <fieldset className="fieldset">
      <legend className="fieldset-legend">期間</legend>

      {/* 幅を等分させる。5 つ並ぶので、既定の内側余白のままだと 375pt 幅の端末で
          ちょうど収まりきる寸法になり、文言を変えるだけで溢れる */}
      <div className="join w-full">
        {PERIOD_PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            // 選択中の見え方は種別のチェックボックス（daisyUI が checked に当てる
            // primary）に合わせる。同じシートの中で「選ばれている」の表し方が
            // 2 通りあると、どちらかが壊れているように見える
            className={`btn join-item flex-1 px-2 ${
              filter.period === preset.value ? "btn-primary" : ""
            }`}
            aria-pressed={filter.period === preset.value}
            onClick={() =>
              onChange({ ...filter, period: preset.value, dateFrom: null, dateTo: null })
            }
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="date"
          className="input grow"
          aria-label="開始日"
          value={range.from ?? ""}
          onChange={(event) => changeDate("from", event.target.value)}
        />
        <span aria-hidden="true">〜</span>
        <input
          type="date"
          className="input grow"
          aria-label="終了日"
          value={range.to ?? ""}
          onChange={(event) => changeDate("to", event.target.value)}
        />
      </div>

      <label className="label">
        <input
          type="checkbox"
          className="toggle toggle-sm"
          checked={filter.hideFuture}
          onChange={(event) => onChange({ ...filter, hideFuture: event.target.checked })}
        />
        未来の明細を隠す
      </label>
    </fieldset>
  );
}
