/**
 * フィルタ UI の選択肢に使うマスタの取得。
 */

import { useQuery } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";

import { client, unwrap } from "./client";

/** マスタのエンドポイント。 */
const endpoint = client.api.masters.$get;

/** マスタ一式。categories 46 / genres 129 / accounts 36。 */
export type Masters = InferResponseType<typeof endpoint, 200>;

/**
 * マスタを取得する。
 *
 * 中身が変わるのは同期（1 日 1 回）のときだけで、合わせても 200 件強しかない。
 * 起動時に 1 回引いて以降は使い回す。
 *
 * @returns TanStack Query のクエリ。
 */
export function useMasters() {
  return useQuery({
    queryKey: ["masters"],
    queryFn: () => unwrap(endpoint()),
    staleTime: Infinity,
  });
}
