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
 * レスポンスの union から、成功したときの本体だけを取り出す型。
 *
 * `zValidator` の付いたルートでは、RPC のレスポンス型が「成功」と
 * 「バリデーションエラー（400）」の union になる。`res.ok` で分岐しても
 * 値としては絞れるだけで、`json()` の戻り値は union のままなので、
 * 型の側でも成功側を選び出す必要がある。
 *
 * 判定に使うのは status。エラー側は `400` というリテラルなのに対し、
 * 成功側は `c.json()` にステータスを渡していないため `ContentfulStatusCode`
 * という広い union になる。したがって「200 を取りうるか」で選り分けられる
 * （`200 extends 400` は false、`200 extends ContentfulStatusCode` は true）。
 */
type SuccessBody<R> = R extends { status: infer S; json: () => Promise<infer T> }
  ? 200 extends S
    ? T
    : never
  : never;

/**
 * レスポンスから本体を取り出す。
 *
 * `zValidator` が 400 を返しうることが契約に含まれているため、
 * 呼び出し側は `res.ok` で絞ってからでないと本体に触れない。
 * 毎回それを書くと本題が埋もれるので、ここで 1 回だけ吸収する。
 *
 * @param call RPC の呼び出し（`client.api.meta.$get()` など）。
 * @returns 成功時のレスポンス本体。
 * @throws {Error} API がエラーを返したとき。
 */
export async function unwrap<
  R extends { ok: boolean; status: number; json: () => Promise<unknown> },
>(call: Promise<R>): Promise<SuccessBody<R>> {
  const res = await call;
  if (!res.ok) {
    throw new Error(`API がエラーを返した（${res.status}）`);
  }
  // SAFETY: 直前の `res.ok` で成功したレスポンスだけに絞ってある。`json()` の型は
  // union のままなので、SuccessBody で選んだ側に寄せる
  return (await res.json()) as SuccessBody<R>;
}
