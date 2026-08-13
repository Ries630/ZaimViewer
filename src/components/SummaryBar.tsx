/**
 * 件数と金額合計。
 */

import { formatAmount, formatCount } from "../lib/format";

interface SummaryBarProps {
  /** 条件に一致した件数。未取得なら undefined。 */
  total: number | undefined;
  /** 一致した明細の金額合計。未取得なら undefined。 */
  totalAmount: number | undefined;
  /** 種別を 1 つに絞っているか。 */
  singleMode: boolean;
}

/**
 * 件数と金額合計を出す。
 *
 * 合計は一致した明細の金額を素朴に足し合わせた値なので、種別が混ざっていると
 * 支出と収入を足した数になり、意味を持たない。種別を 1 つに絞るまでは
 * 誤読されないよう注記を添える。
 *
 * @param props 件数と金額合計。
 * @returns サマリ表示。
 */
export function SummaryBar({ total, totalAmount, singleMode }: SummaryBarProps) {
  if (total === undefined || totalAmount === undefined) {
    // 読み込み中に高さが変わると、下の一覧が跳ねる
    return <div className="h-9" aria-hidden="true" />;
  }

  return (
    <div className="flex h-9 items-baseline justify-between gap-2 text-sm">
      <p>
        <span className="font-medium tabular-nums">{formatCount(total)}</span> 件
      </p>
      <p className="text-base-content/70">
        総額 <span className="tabular-nums">{formatAmount(totalAmount, "JPY")}</span>
        {!singleMode && <span className="ml-1 text-xs text-base-content/50">種別を合算</span>}
      </p>
    </div>
  );
}
