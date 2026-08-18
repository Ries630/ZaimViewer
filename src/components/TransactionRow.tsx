/**
 * 明細 1 件の表示。
 */

import type { Transaction } from "../api/transactions";
import { isFutureDate } from "../lib/format";
import { rowText } from "../lib/transaction";
import { Amount } from "./Amount";

interface TransactionRowProps {
  /** 表示する明細。 */
  transaction: Transaction;
  /** JST の今日（`YYYY-MM-DD`）。未来の明細に印を付けるのに使う。 */
  today: string;
  /** 詳細を開く。 */
  onSelect: (transaction: Transaction) => void;
}

/**
 * 明細 1 件を出す。
 *
 * 左に内容、右に金額。内容は主表示・文脈・補足の 3 段で、
 * 埋まっていない段は出さない（実データは空の項目が多い）。
 *
 * 行そのものがボタンで、押すと詳細シートが開く。主表示は 1 行に切り詰めて
 * あるので、切れた先はそこで読む（#19）。
 *
 * @param props 明細・今日の日付・詳細を開く関数。
 * @returns 明細 1 行。
 */
export function TransactionRow({ transaction, today, onSelect }: TransactionRowProps) {
  const { primary, context, note } = rowText(transaction);

  return (
    <button
      type="button"
      onClick={() => onSelect(transaction)}
      // 既定で中央寄せ・幅が内容なりになるので、両方とも打ち消す。
      // active: は押している間の手応え（iOS には hover が無い）
      className="flex w-full items-start justify-between gap-3 py-2.5 text-left transition-colors active:bg-base-200"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          {primary}
          {isFutureDate(transaction.date, today) && (
            // 繰り返し登録の家賃が 2029-12 まで入っており、フィルタの無い
            // #14 では一覧の先頭がそれで埋まる。壊れたデータに見えないよう印を付ける
            <span className="badge badge-info badge-sm ml-1.5">予定</span>
          )}
        </span>
        {context && <span className="block truncate text-xs text-base-content/60">{context}</span>}
        {note && <span className="block truncate text-xs text-base-content/50">{note}</span>}
      </span>
      <Amount transaction={transaction} className="shrink-0" />
    </button>
  );
}
