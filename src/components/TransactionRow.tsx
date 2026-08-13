/**
 * 明細 1 件の表示。
 */

import type { Transaction } from "../api/transactions";
import { formatAmount, isFutureDate } from "../lib/format";
import { rowText } from "../lib/transaction";

/** モードごとの金額の見せ方。 */
const AMOUNT_STYLES: Record<string, { className: string; prefix: string }> = {
  income: { className: "text-success", prefix: "+" },
  transfer: { className: "text-base-content/60", prefix: "" },
};

/** 支出および未知のモードの見せ方。 */
const DEFAULT_AMOUNT_STYLE = { className: "text-base-content", prefix: "" };

interface TransactionRowProps {
  /** 表示する明細。 */
  transaction: Transaction;
  /** JST の今日（`YYYY-MM-DD`）。未来の明細に印を付けるのに使う。 */
  today: string;
}

/**
 * 明細 1 件を出す。
 *
 * 左に内容、右に金額。内容は主表示・文脈・補足の 3 段で、
 * 埋まっていない段は出さない（実データは空の項目が多い）。
 *
 * @param props 明細と今日の日付。
 * @returns 明細 1 行。
 */
export function TransactionRow({ transaction, today }: TransactionRowProps) {
  const { primary, context, note } = rowText(transaction);
  const style = AMOUNT_STYLES[transaction.mode] ?? DEFAULT_AMOUNT_STYLE;

  return (
    <div className="flex items-start justify-between gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate">
          {primary}
          {isFutureDate(transaction.date, today) && (
            // 繰り返し登録の家賃が 2029-12 まで入っており、フィルタの無い
            // #14 では一覧の先頭がそれで埋まる。壊れたデータに見えないよう印を付ける
            <span className="badge badge-info badge-sm ml-1.5">予定</span>
          )}
        </p>
        {context && <p className="truncate text-xs text-base-content/60">{context}</p>}
        {note && <p className="truncate text-xs text-base-content/50">{note}</p>}
      </div>
      <p className={`shrink-0 tabular-nums ${style.className}`}>
        {style.prefix}
        {formatAmount(transaction.amount, transaction.currency_code)}
      </p>
    </div>
  );
}
