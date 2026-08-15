/**
 * 明細一覧。
 */

import type { Transaction } from "../api/transactions";
import { formatDateHeading } from "../lib/format";
import { groupByDate } from "../lib/transaction";
import { Sentinel } from "./Sentinel";
import { TransactionRow } from "./TransactionRow";

/** 読み込み中に見せる骨組みの行数。1 画面ぶんの目安。 */
const SKELETON_ROWS = 8;

interface TransactionListProps {
  /** 取得済みの明細を全ページ連結したもの。日付の降順。 */
  items: Transaction[];
  /** JST の今日（`YYYY-MM-DD`）。 */
  today: string;
  /** 最初のページを取得中か。 */
  isPending: boolean;
  /** オフラインで取得が止まっているか。 */
  isPaused: boolean;
  /** 取得に失敗したときのエラー。 */
  error: Error | null;
  /** 続きがあるか。 */
  hasNextPage: boolean;
  /** 続きを取得中か。 */
  isFetchingNextPage: boolean;
  /** 続きの取得を促す。 */
  onLoadMore: () => void;
}

/**
 * 明細を日付ごとにまとめて並べ、末尾に近づいたら続きを読む。
 *
 * @param props 明細と取得状態。
 * @returns 明細一覧。
 */
export function TransactionList({
  items,
  today,
  isPending,
  isPaused,
  error,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: TransactionListProps) {
  if (error) {
    return <p className="py-8 text-center text-error">読み込めなかった: {error.message}</p>;
  }

  // オフラインではクエリが発行されずに止まる（`networkMode` の既定）。このとき
  // error は null、isPending は true のままなので、素直に書くと骨組みが出続ける。
  // 骨組みは動きがあるぶん「処理が進んでいる」と読めてしまうため、
  // 止まっていることの方を出す
  if (isPending && isPaused) {
    return (
      <p className="py-8 text-center text-base-content/60">
        オフライン。接続が戻ると自動で読み込む
      </p>
    );
  }

  if (isPending) {
    return (
      // skeleton は自前で背景色とアニメーションを持つので animate-pulse は要らない
      <div aria-busy="true" aria-label="読み込み中">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <div key={index} className="flex justify-between gap-3 border-b border-base-200 py-4">
            <div className="skeleton h-4 w-2/5" />
            <div className="skeleton h-4 w-20" />
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return <p className="py-8 text-center text-base-content/60">該当する明細が無い</p>;
  }

  return (
    <>
      {groupByDate(items).map((group) => (
        <section key={group.date}>
          <h2 className="pt-4 pb-1 text-xs font-medium text-base-content/60">
            {formatDateHeading(group.date)}
          </h2>
          <ol className="divide-y divide-base-200">
            {group.items.map((transaction) => (
              <li key={transaction.id}>
                <TransactionRow transaction={transaction} today={today} />
              </li>
            ))}
          </ol>
        </section>
      ))}

      {hasNextPage && <Sentinel onVisible={onLoadMore} />}

      <p className="py-6 text-center text-sm text-base-content/60">
        {isFetchingNextPage ? "読み込み中…" : hasNextPage ? "" : "ここまで"}
      </p>
    </>
  );
}
