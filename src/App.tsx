import { useCallback, useMemo } from "react";

import { useMeta } from "./api/meta";
import { type TransactionFilter, useTransactions } from "./api/transactions";
import { SummaryBar } from "./components/SummaryBar";
import { SyncFreshness } from "./components/SyncFreshness";
import { TransactionList } from "./components/TransactionList";
import { todayInTokyo } from "./lib/format";

/**
 * 絞り込み無し。
 *
 * API は「指定なし = 制限なし」に徹しており（ADR-0008）、既定値は PWA 側が
 * 持つ。その既定値を組み立てるのは #15 のフィルタパネルなので、#14 では
 * 全件を出す。振替も未来日付の明細も混ざったままになる。
 */
const NO_FILTER: TransactionFilter = {};

/**
 * 明細一覧の画面。
 *
 * @returns 画面全体。
 */
export function App() {
  const meta = useMeta();
  const transactions = useTransactions(NO_FILTER);

  // 相対表記の基準。取得し直したときだけ進めれば足りる
  // （ミラーは 1 日 1 回しか更新されないので、秒単位で追う意味が無い）
  const now = useMemo(() => new Date(), [meta.dataUpdatedAt]);
  const today = todayInTokyo(now);

  const items = useMemo(
    () => transactions.data?.pages.flatMap((page) => page.items) ?? [],
    [transactions.data],
  );

  // 件数と合計はページごとに同じ値が返るので、先頭のページから読めばよい
  const totals = transactions.data?.pages[0];

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = transactions;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div className="mx-auto max-w-2xl">
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white px-4 pt-safe-top">
        <div className="flex items-baseline justify-between gap-2 pt-3">
          <h1 className="text-lg font-bold">ZaimViewer</h1>
          <SyncFreshness syncedAt={meta.data?.synced_at ?? null} now={now} />
        </div>
        <SummaryBar total={totals?.total} totalAmount={totals?.total_amount} />
      </header>

      <main className="px-4 pb-safe-bottom">
        <TransactionList
          items={items}
          today={today}
          isPending={transactions.isPending}
          error={transactions.error}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={loadMore}
        />
      </main>
    </div>
  );
}
