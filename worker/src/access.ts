/**
 * Cloudflare Access が発行する JWT の検証。
 *
 * 認証そのものはエッジの Access が止めている（ADR-0016）。ここで二重に
 * 検証するのは、Access の設定ミス・保護漏れ・カスタムドメインの張り忘れが
 * 「静かな素通り」になるのを防ぐため。Worker が自分でも判定を持てば、
 * エッジをすり抜けた経路はその場で 403 になる。
 *
 * 実装は Cloudflare のサンプルに沿っている。
 * https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
 */

import { type MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";

/** JWT 検証に要る環境変数。`index.ts` の `Env` はこれを継承する。 */
export interface AccessEnv {
  /** 実行環境。"production" のときだけ検証する。 */
  ENVIRONMENT: string;
  /** `https://<team>.cloudflareaccess.com`。JWT の issuer 兼 JWKS の取得元。 */
  TEAM_DOMAIN?: string;
  /**
   * 許可する Access アプリの AUD タグ。カンマ区切りで複数指定できる。
   *
   * 本番 URL と Preview URL は別々の Access アプリになり AUD が異なるので、
   * 1 個しか受け付けないと Preview URL 経由がすべて 403 になる。
   * どちらも同じポリシー配下の自分のアプリなので、両方許して
   * デプロイ前の動作確認手段を残す。
   */
  POLICY_AUD?: string;
}

/** Access が JWT を載せてくるリクエストヘッダ。 */
const JWT_HEADER = "cf-access-jwt-assertion";

/**
 * チームドメインごとの JWKS 取得関数。
 *
 * jose の鍵キャッシュは `createRemoteJWKSet` の戻り値クロージャに入る。
 * リクエストごとに作り直すとキャッシュを毎回捨てることになり、
 * 1 リクエストにつき 1 回 JWKS を取りに行ってしまう。
 */
const jwksByTeamDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * チームドメインに対応する JWKS 取得関数を返す。無ければ作って覚える。
 *
 * @param teamDomain `https://<team>.cloudflareaccess.com`。
 * @returns jose に渡す鍵解決関数。
 */
function jwksFor(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksByTeamDomain.get(teamDomain);
  if (cached) return cached;

  const jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
  jwksByTeamDomain.set(teamDomain, jwks);
  return jwks;
}

/**
 * カンマ区切りの AUD タグを配列に分解する。
 *
 * @param policyAud 環境変数の生の値。
 * @returns 空要素を除いた AUD タグの配列。
 */
function audiences(policyAud: string): string[] {
  return policyAud
    .split(",")
    .map((aud) => aud.trim())
    .filter((aud) => aud.length > 0);
}

/**
 * Access の JWT を検証するミドルウェア。
 *
 * 本番では設定が欠けていたら通さない。「変数があるときだけ検証する」形にすると、
 * 本番で `POLICY_AUD` を入れ忘れたときに保護が静かに消え、この検証を足した
 * 意味が無くなる。`ENVIRONMENT` の既定は `wrangler.jsonc` で "production" なので、
 * 設定漏れは素通りではなく全リクエスト 403 として表に出る。
 *
 * 逆にローカル開発とテストでは検証しない。Access は手元の `wrangler dev` の
 * 前には立っておらず、JWT を用意する手段が無いため。
 */
export const accessGuard: MiddlewareHandler<{ Bindings: AccessEnv }> = async (c, next) => {
  if (c.env.ENVIRONMENT !== "production") {
    return next();
  }

  const teamDomain = c.env.TEAM_DOMAIN;
  const policyAud = c.env.POLICY_AUD;
  if (!teamDomain || !policyAud) {
    return c.json({ error: "Access の検証設定（TEAM_DOMAIN / POLICY_AUD）が無い" }, 403);
  }

  const token = c.req.header(JWT_HEADER);
  if (!token) {
    return c.json({ error: "Access の JWT が無い" }, 403);
  }

  try {
    await jwtVerify(token, jwksFor(teamDomain), {
      issuer: teamDomain,
      audience: audiences(policyAud),
    });
  } catch (error) {
    // 失敗の内訳（期限切れか AUD 不一致か）は未認証の相手には返さない。
    // 追跡はログ側で行う（observability は wrangler.jsonc で有効）
    console.warn("Access JWT の検証に失敗", error);
    return c.json({ error: "Access の JWT を検証できない" }, 403);
  }

  return next();
};
