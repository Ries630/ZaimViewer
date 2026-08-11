/**
 * Access の JWT をテストから作るための足場。
 *
 * 本物の Access は手元に無いので、鍵ペアをその場で作り、JWKS の
 * エンドポイントを `globalThis.fetch` のモックで差し替えて Access の
 * 代わりをさせる。
 *
 * `access.test.ts` だけでなく、本番相当の条件を作る他のテストからも
 * 使う。JWT を用意できないと、`ENVIRONMENT=production` にした時点で
 * ミドルウェアに 403 で止められ、その先の挙動を確認できないため。
 */

import { env } from "cloudflare:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { vi } from "vitest";

import { type AccessEnv } from "../src/access";

/**
 * `env` のうち JWT 検証が読む項目を、テストから書き換えられる型で見たもの。
 *
 * `wrangler types` は `wrangler.jsonc` の vars をリテラル型で出力するため
 * （`TEAM_DOMAIN: "https://rieslab.cloudflareaccess.com"`）、`env` に直接
 * テスト用の値を入れると型が合わない。ここだけ宣言された型に緩める。
 */
export const accessEnv = env as AccessEnv;

/** テスト用のチームドメイン。JWT の issuer 兼 JWKS の取得元。 */
export const TEAM_DOMAIN = "https://example-team.cloudflareaccess.com";

/** 本番 URL の Access アプリの AUD タグ。 */
export const AUD_PRODUCTION = "aud-production";

/** Preview URL の Access アプリの AUD タグ。本番とは別アプリなので値が違う。 */
export const AUD_PREVIEW = "aud-preview";

/** Access が JWT を載せてくるリクエストヘッダ。 */
export const JWT_HEADER = "cf-access-jwt-assertion";

/** JWKS に載せる鍵の識別子。 */
const KEY_ID = "test-key";

/** 検証に通る想定の署名鍵。`installAccess()` が用意する。 */
let signingKey: CryptoKey | undefined;

/**
 * JWKS のモックを立て、`env` を本番相当に切り替える。
 *
 * `beforeAll` から呼ぶ。後始末は `vi.restoreAllMocks()` と
 * `env.ENVIRONMENT` の復帰を呼び出し側で行う。
 */
export async function installAccess(): Promise<void> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  signingKey = privateKey;

  // JWKS を引けないと検証は必ず失敗するので、「通る」ケースが成立すること
  // 自体がこのモックが効いていることの証明になる
  const publicJwk = await exportJWK(publicKey);
  const jwksUrl = `${TEAM_DOMAIN}/cdn-cgi/access/certs`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === jwksUrl) {
      return Response.json({ keys: [{ ...publicJwk, kid: KEY_ID, alg: "RS256", use: "sig" }] });
    }
    throw new Error(`予期しない外部リクエスト: ${request.url}`);
  });

  accessEnv.ENVIRONMENT = "production";
  accessEnv.TEAM_DOMAIN = TEAM_DOMAIN;
  accessEnv.POLICY_AUD = `${AUD_PRODUCTION},${AUD_PREVIEW}`;
}

/**
 * Access が発行するものと同じ形の JWT を作る。
 *
 * @param options 既定から変えたい項目。省略した項目は検証に通る値になる。
 * @returns 署名済みの JWT。
 */
export async function issueToken(
  options: {
    audience?: string | string[];
    issuer?: string;
    expiresIn?: string;
    key?: CryptoKey;
  } = {},
): Promise<string> {
  const key = options.key ?? signingKey;
  if (!key) throw new Error("installAccess() を先に呼ぶこと");

  return new SignJWT({ email: "ries@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .setIssuedAt()
    .setIssuer(options.issuer ?? TEAM_DOMAIN)
    .setAudience(options.audience ?? AUD_PRODUCTION)
    .setExpirationTime(options.expiresIn ?? "1h")
    .sign(key);
}

/**
 * JWT を載せた `fetch` の init を組み立てる。
 *
 * @param token 載せる JWT。
 * @param init 併せて渡したい init。
 * @returns ヘッダ付きの init。
 */
export function withToken(token: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set(JWT_HEADER, token);
  return { ...init, headers };
}
