/**
 * Worker の読み取り API を叩くクライアント。
 *
 * `hc<AppType>` で型が付く。エンドポイントのパス・クエリパラメータ・
 * レスポンス形状はすべて Worker 側の定義から来るので、ここには書かない。
 */

import { hc } from "hono/client";

import type { AppType } from "../../worker/src/index";
import { accessAwareFetch } from "./access";

/**
 * API クライアント。
 *
 * PWA は Worker と同一オリジンから配信されるので、ベース URL は相対で足りる。
 * `fetch` を差し替えて Access のセッション切れを拾う。
 */
export const client = hc<AppType>("/", { fetch: accessAwareFetch });

/**
 * レスポンスから本体を取り出す。
 *
 * RPC のレスポンス型は「成功」と「バリデーションエラー」の union になる。
 * `zValidator` が 400 を返しうることが契約に含まれているため、`res.ok` で
 * 絞ってからでないと本体に触れない。呼び出しごとにこれを書くと本題が
 * 埋もれるので、ここで 1 回だけ吸収する。
 *
 * @param call RPC の呼び出し（`api.api.meta.$get()` など）。
 * @returns 成功時のレスポンス本体。
 * @throws {Error} API がエラーを返したとき。
 */
export async function unwrap<T>(
  call: Promise<{ ok: boolean; status: number; json: () => Promise<T> }>,
): Promise<T> {
  const res = await call;
  if (!res.ok) {
    throw new Error(`API がエラーを返した（${res.status}）`);
  }
  return res.json();
}
