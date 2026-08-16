/**
 * 金額の表示。
 */

import type { Transaction } from "../api/transactions";
import { formatAmount } from "../lib/format";

/** モードごとの金額の見せ方。 */
const AMOUNT_STYLES: Record<string, { className: string; prefix: string }> = {
  income: { className: "text-success", prefix: "+" },
  transfer: { className: "text-base-content/60", prefix: "" },
};

/** 支出および未知のモードの見せ方。 */
const DEFAULT_AMOUNT_STYLE = { className: "text-base-content", prefix: "" };

interface AmountProps {
  /** 金額を出す明細。 */
  transaction: Transaction;
  /** 大きさなど、呼び出し側で足したいクラス。 */
  className?: string;
}

/**
 * 金額を種別に応じた色と符号で出す。
 *
 * 一覧の行と詳細シートの両方から使う。収入だけ色と符号を変える扱い
 * （[ADR-0023](../../docs/adr/0023-darken-success-for-income-amount.md)）が
 * 2 か所に散ると、片方だけ直して食い違う。
 *
 * @param props 明細と追加のクラス。
 * @returns 金額の表示。
 */
export function Amount({ transaction, className = "" }: AmountProps) {
  const style = AMOUNT_STYLES[transaction.mode] ?? DEFAULT_AMOUNT_STYLE;

  return (
    <span className={`tabular-nums ${style.className} ${className}`}>
      {style.prefix}
      {formatAmount(transaction.amount, transaction.currency_code)}
    </span>
  );
}
