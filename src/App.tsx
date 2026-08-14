import { useCallback, useEffect, useMemo, useRef } from "react";

import { useMasters } from "./api/masters";
import { useMeta } from "./api/meta";
import { useTransactions } from "./api/transactions";
import { FilterBar } from "./components/FilterBar";
import { FilterSheet } from "./components/FilterSheet";
import { SummaryBar } from "./components/SummaryBar";
import { SyncFreshness } from "./components/SyncFreshness";
import { TransactionList } from "./components/TransactionList";
import { useDebounced } from "./hooks/useDebounced";
import { useStoredFilter } from "./hooks/useStoredFilter";
import { DEFAULT_FILTER, type FilterState, activeBadges, toTransactionFilter } from "./lib/filter";
import { todayInTokyo } from "./lib/format";
import { nameLookup, reconcile } from "./lib/masters";

/** 入力が落ち着いたと見なすまでの時間。キーワードを 1 文字打つたびに取りに行かせない。 */
const FILTER_DEBOUNCE_MS = 300;

/**
 * 明細一覧の画面。
 *
 * @returns 画面全体。
 */
export function App() {
  const meta = useMeta();
  const masters = useMasters();
  const [filter, setFilter] = useStoredFilter();
  const sheet = useRef<HTMLDialogElement>(null);

  // 相対表記の基準。取得し直したときだけ進めれば足りる
  // （ミラーは 1 日 1 回しか更新されないので、秒単位で追う意味が無い）
  const now = useMemo(() => new Date(), [meta.dataUpdatedAt]);
  const today = todayInTokyo(now);

  const mastersData = masters.data;

  // 保存しておいた選択が、同期でマスタから消えていることがある。
  // マスタが届いた時点で一度均す（変化が無ければ reconcile は同じオブジェクトを
  // 返すので、更新は起きない）
  useEffect(() => {
    setFilter((current) => reconcile(current, mastersData));
  }, [mastersData, setFilter]);

  // 種別を外せばそのカテゴリが、カテゴリを外せばそのジャンルが選択肢から消える。
  // 画面に出ていない条件が効き続けないよう、更新は必ずここを通す
  const updateFilter = useCallback(
    (next: FilterState) => setFilter(reconcile(next, mastersData)),
    [mastersData, setFilter],
  );

  const debounced = useDebounced(filter, FILTER_DEBOUNCE_MS);
  const query = useMemo(() => toTransactionFilter(debounced, today), [debounced, today]);
  const transactions = useTransactions(query);

  const names = useMemo(() => nameLookup(mastersData), [mastersData]);
  const badges = useMemo(() => activeBadges(filter, today, names), [filter, today, names]);

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
      <header className="sticky top-0 z-10 border-b border-base-300 bg-base-100 px-4 pt-safe-top">
        <div className="flex items-baseline justify-between gap-2 pt-3">
          <h1 className="text-lg font-bold">ZaimViewer</h1>
          <SyncFreshness syncedAt={meta.data?.synced_at ?? null} now={now} />
        </div>
        <FilterBar
          filter={filter}
          badges={badges}
          onChange={updateFilter}
          onOpenSheet={() => sheet.current?.showModal()}
        />
        <SummaryBar
          total={totals?.total}
          totalAmount={totals?.total_amount}
          singleMode={filter.modes.length === 1}
        />
      </header>

      {/* 条件を差し替えているあいだは前の結果を薄く出しておく。
          消してしまうと、条件を詰める操作のたびに画面が空になる */}
      <main
        className={`px-4 pb-safe-bottom transition-opacity ${
          transactions.isPlaceholderData ? "opacity-50" : ""
        }`}
      >
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

      <FilterSheet
        ref={sheet}
        filter={filter}
        masters={mastersData}
        today={today}
        total={totals?.total}
        onChange={updateFilter}
        onReset={() => setFilter(DEFAULT_FILTER)}
      />
    </div>
  );
}
