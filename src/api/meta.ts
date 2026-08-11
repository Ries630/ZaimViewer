/**
 * ミラーの鮮度の取得。
 */

import { useQuery } from "@tanstack/react-query";

import { client, unwrap } from "./client";

/**
 * ミラーの同期時刻と件数を取得する。
 *
 * @returns TanStack Query のクエリ。
 */
export function useMeta() {
  return useQuery({
    queryKey: ["meta"],
    queryFn: () => unwrap(client.api.meta.$get()),
  });
}
