/**
 * 明細一覧の取得。
 *
 * ページングは `limit` / `offset`。並びは `date DESC, id DESC` で API 側が
 * 固定しており、同日内の順序も id で安定しているのでページ送りで
 * 重複・欠落は起きない。
 */

import { useInfiniteQuery } from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";

import { client, unwrap } from "./client";

/** 明細一覧のエンドポイント。型を 3 箇所から参照するので名前を付ける。 */
const endpoint = client.api.transactions.$get;

/** 1 ページの件数。API の既定と同じ。 */
export const PAGE_SIZE = 100;

/**
 * 明細 1 件。
 *
 * API のレスポンスから引くので、Worker 側の `Transaction` と自動で揃う。
 */
export type Transaction = InferResponseType<typeof endpoint, 200>["items"][number];

/**
 * 絞り込み条件。
 *
 * API のクエリパラメータから `limit` / `offset` を除いたもの。ページングは
 * このフックが決めるため、呼び出し側には触らせない。#14 では常に空で、
 * #15 のフィルタパネルがここを埋める。
 */
export type TransactionFilter = Omit<
  NonNullable<InferRequestType<typeof endpoint>["query"]>,
  "limit" | "offset"
>;

/**
 * 明細を無限スクロールで取得する。
 *
 * @param filter 絞り込み条件。
 * @returns TanStack Query の無限クエリ。
 */
export function useTransactions(filter: TransactionFilter) {
  return useInfiniteQuery({
    queryKey: ["transactions", filter],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      unwrap(
        endpoint({
          query: { ...filter, limit: String(PAGE_SIZE), offset: String(pageParam) },
        }),
      ),
    getNextPageParam: (lastPage) => {
      const next = lastPage.offset + lastPage.limit;
      return next < lastPage.total ? next : undefined;
    },
  });
}
