/**
 * Cloudflare Access の JWT 検証（`src/access.ts`）を確認する。
 *
 * 見たいのは jose の正しさではなく「どの条件で通し、どの条件で落とすか」。
 * 鍵と JWKS は `access-harness.ts` が偽物を用意する。
 */

import { SELF, env } from "cloudflare:test";
import { generateKeyPair } from "jose";
import { afterAll, beforeAll, expect, it } from "vitest";

import { AUD_PREVIEW, accessEnv, installAccess, issueToken, withToken } from "./access-harness";
import { seedDatabase } from "./fixtures";

/** JWKS には載らない署名鍵。署名検証が実際に効いているかを見るために使う。 */
let foreignKey: CryptoKey;

/** テストが差し替える前の実行環境。後始末で戻す。 */
const originalEnvironment = env.ENVIRONMENT;

beforeAll(async () => {
  await seedDatabase(env.DB);
  await installAccess();
  foreignKey = (await generateKeyPair("RS256", { extractable: true })).privateKey;
});

afterAll(() => {
  env.ENVIRONMENT = originalEnvironment;
});

/**
 * JWT を付けて API を叩く。
 *
 * @param token 付ける JWT。省略するとヘッダ自体を付けない。
 * @returns レスポンス。
 */
async function callApi(token?: string): Promise<Response> {
  const url = "http://example.com/api/meta";
  return token ? SELF.fetch(url, withToken(token)) : SELF.fetch(url);
}

it("正しい JWT なら通る", async () => {
  const res = await callApi(await issueToken());
  expect(res.status).toBe(200);
});

it("Preview URL の AUD でも通る", async () => {
  // 本番と Preview は別の Access アプリなので AUD が違う。片方しか
  // 受け付けないと Preview URL 経由の確認がすべて落ちる
  const res = await callApi(await issueToken({ audience: AUD_PREVIEW }));
  expect(res.status).toBe(200);
});

it("JWT が無ければ 403", async () => {
  const res = await callApi();
  expect(res.status).toBe(403);
});

it("期限切れの JWT は 403", async () => {
  const res = await callApi(await issueToken({ expiresIn: "-1h" }));
  expect(res.status).toBe(403);
});

it("AUD が一致しない JWT は 403", async () => {
  // 他の Access アプリで発行された JWT を使い回せないことの確認
  const res = await callApi(await issueToken({ audience: "aud-someone-else" }));
  expect(res.status).toBe(403);
});

it("issuer が一致しない JWT は 403", async () => {
  const res = await callApi(await issueToken({ issuer: "https://other.cloudflareaccess.com" }));
  expect(res.status).toBe(403);
});

it("JWKS に無い鍵で署名した JWT は 403", async () => {
  // 中身が正しくても署名を見ていなければ通ってしまう。そこを塞げているか
  const res = await callApi(await issueToken({ key: foreignKey }));
  expect(res.status).toBe(403);
});

it("本番で POLICY_AUD が未設定なら、正しい JWT でも 403", async () => {
  // 設定漏れが「静かな素通り」ではなく明示的な拒否になることの確認。
  // ここが通ってしまうと、この検証を足した意味が無くなる
  const token = await issueToken();
  const saved = accessEnv.POLICY_AUD;
  // 未設定（undefined）も空文字も、ミドルウェアは同じ falsy として弾く
  accessEnv.POLICY_AUD = undefined;
  try {
    const res = await callApi(token);
    expect(res.status).toBe(403);
  } finally {
    accessEnv.POLICY_AUD = saved;
  }
});

it("開発環境では JWT が無くても通る", async () => {
  const saved = env.ENVIRONMENT;
  env.ENVIRONMENT = "development";
  try {
    const res = await callApi();
    expect(res.status).toBe(200);
  } finally {
    env.ENVIRONMENT = saved;
  }
});
