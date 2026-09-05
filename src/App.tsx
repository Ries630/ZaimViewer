import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useEditCapabilities } from "./api/edits";
import { useMasters } from "./api/masters";
import { useMeta } from "./api/meta";
import { type Transaction, useTransactions } from "./api/transactions";
import { FilterBar } from "./components/FilterBar";
import { FilterSheet } from "./components/FilterSheet";
import { SummaryBar } from "./components/SummaryBar";
import { SyncFreshness } from "./components/SyncFreshness";
import { TransactionList } from "./components/TransactionList";
import { TransactionSheet } from "./components/TransactionSheet";
import { BulkEditSheet } from "./components/edit/BulkEditSheet";
import { EditPlanStatus } from "./components/edit/EditPlanStatus";
import { useDebounced } from "./hooks/useDebounced";
import { useOnline } from "./hooks/useOnline";
import { useStoredFilter } from "./hooks/useStoredFilter";
import { DEFAULT_FILTER, type FilterState, activeBadges, toTransactionFilter } from "./lib/filter";
import { MAX_EDIT_ITEMS } from "./lib/edit";
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
  const editCapabilities = useEditCapabilities();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useStoredFilter();
  const online = useOnline();
  const sheet = useRef<HTMLDialogElement>(null);
  const detail = useRef<HTMLDialogElement>(null);
  const bulk = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<Transaction | null>(null);

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

  // 保存後に一覧が更新されても、開いている詳細は同じ ID の最新行を参照する。
  // 編集開始時の値は編集フォームが保持するため、ここで差し替えても確認内容は変わらない。
  useEffect(() => {
    setSelected((current) => {
      if (!current) return current;
      return items.find((item) => item.id === current.id) ?? current;
    });
  }, [items]);

  // 件数と合計はページごとに同じ値が返るので、先頭のページから読めばよい
  const totals = transactions.data?.pages[0];
  const bulkMode = filter.modes.length === 1 ? (filter.modes[0] ?? null) : null;
  const refreshAfterEdit = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["transactions"] });
    void queryClient.invalidateQueries({ queryKey: ["masters"] });
  }, [queryClient]);
  const closeAfterSingleEdit = useCallback(() => {
    refreshAfterEdit();
    setSelected(null);
    detail.current?.close();
  }, [refreshAfterEdit]);
  const bulkReady =
    bulkMode !== null &&
    filter === debounced &&
    !transactions.isPlaceholderData &&
    !transactions.isFetching;

  // 選択を先に反映してから開く。同じ描画で処理されるので、
  // 開く瞬間に前の明細が見えることはない
  const openDetail = useCallback((transaction: Transaction) => {
    setSelected(transaction);
    detail.current?.showModal();
  }, []);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = transactions;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div className="mx-auto max-w-2xl">
      <header className="sticky top-0 z-10 border-b border-base-300 bg-base-100 px-4 pt-safe-top">
        <div className="flex items-baseline justify-between gap-2 pt-3">
          <h1 className="text-lg font-bold">ZaimViewer</h1>
          <div className="flex items-baseline gap-2">
            {/* 同期の鮮度と並べる。別の軸だが、オフラインの間はミラーを
                更新しようがないので、鮮度の隣に出るのが読み手には自然 */}
            {!online && (
              <span className="shrink-0 rounded bg-warning px-2 py-1 text-sm font-medium text-warning-content">
                オフライン
              </span>
            )}
            <SyncFreshness syncedAt={meta.data?.synced_at ?? null} now={now} />
          </div>
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
        <EditPlanStatus onSettled={refreshAfterEdit} />
        {bulkMode !== null && totals?.total !== undefined && (
          <div className="flex items-center justify-between gap-3 border-t border-base-200 py-2">
            <p className="text-sm text-base-content/70">
              {totals.total > MAX_EDIT_ITEMS
                ? `一括編集は ${MAX_EDIT_ITEMS} 件まで`
                : "表示中の同一種別をまとめて編集"}
            </p>
            <button
              type="button"
              className="btn"
              disabled={
                totals.total === 0 ||
                totals.total > MAX_EDIT_ITEMS ||
                !bulkReady ||
                !editCapabilities.data?.enabled ||
                !editCapabilities.data.modes.includes(bulkMode)
              }
              onClick={() => bulk.current?.showModal()}
            >
              一括編集
            </button>
          </div>
        )}
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
          isPaused={transactions.isPaused}
          error={transactions.error}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={loadMore}
          onSelect={openDetail}
        />
      </main>

      <TransactionSheet
        ref={detail}
        transaction={selected}
        today={today}
        masters={mastersData}
        editCapabilities={editCapabilities.data}
        onUpdated={closeAfterSingleEdit}
      />

      {bulkMode !== null && (
        <BulkEditSheet
          ref={bulk}
          filter={query}
          mode={bulkMode}
          items={items}
          total={totals?.total}
          masters={mastersData}
          capabilities={editCapabilities.data}
          onCancel={() => bulk.current?.close()}
          onUpdated={refreshAfterEdit}
        />
      )}

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
