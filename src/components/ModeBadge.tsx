/**
 * 種別（支出 / 収入 / 振替）のバッジ。
 */

import { modeLabel } from "../lib/transaction";

/**
 * 種別ごとの色。
 *
 * 支出が 4,370 件中 3,272 件（75%）を占めるので、支出だけは主張させない。
 * 収入を `success` にしてあるのは金額の色（[ADR-0023](../../docs/adr/0023-darken-success-for-income-amount.md)）と
 * 揃えるため。振替に `info` を使わないのは、同じ見出しに並びうる「予定」の
 * バッジがその色を使っているから。
 */
const MODE_BADGES: Record<string, string> = {
  payment: "badge-ghost",
  income: "badge-success",
  transfer: "badge-neutral",
};

interface ModeBadgeProps {
  /** Zaim の `mode`。 */
  mode: string;
}

/**
 * 種別をバッジで出す。
 *
 * 値が支出・収入・振替の 3 つに限られるので、ラベルと値を並べるより
 * バッジ 1 つの方が速く読める。金額を修飾するものなので、金額の隣に置く。
 *
 * @param props 種別。
 * @returns 種別のバッジ。
 */
export function ModeBadge({ mode }: ModeBadgeProps) {
  return (
    <span className={`badge badge-sm ${MODE_BADGES[mode] ?? "badge-ghost"}`}>
      {modeLabel(mode)}
    </span>
  );
}
