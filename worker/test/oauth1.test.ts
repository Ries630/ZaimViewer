/**
 * OAuth1.0a 署名の検証。
 *
 * 期待値は Python の oauthlib 3.3.1 で生成した固定ベクタ。
 * 署名は一致するかしないかしかなく、ずれても Zaim が 401 を返すだけで
 * 原因が署名ベース文字列のどこにあるかは分からない。参照実装との一致を
 * ここで固定しておく。
 *
 * 認証情報は架空の値だが、パーセントエンコードの差分が出るよう
 * 記号（`!*'()` と `~-._`）と日本語を意図的に含めてある。
 */

import { describe, expect, it } from "vitest";

import { percentEncode, signRequest } from "../src/oauth1";

const CREDENTIALS = {
  consumerKey: "consumer-key-テスト",
  consumerSecret: "consumer-secret!*'()",
  accessToken: "access-token-1234",
  accessTokenSecret: "access-token-secret~-._",
};

const OPTIONS = { nonce: "fixednonce0123456789", timestamp: 1700000000 };

/** oauthlib で生成した参照ベクタ。 */
const VECTORS: { label: string; method: string; url: string; body?: string; signature: string }[] =
  [
    {
      label: "クエリ無しの GET",
      method: "GET",
      url: "https://api.zaim.net/v2/home/user/verify",
      signature: "M2GfPrK4xbqEoINEHRQl/dH+5zo=",
    },
    {
      label: "クエリ付きの GET",
      method: "GET",
      url: "https://api.zaim.net/v2/home/money?mapping=1&limit=100&page=1",
      signature: "DI0YHvSID0UUU7y4TcvU7U42bJw=",
    },
    {
      label: "記号・日本語・プラスを含むクエリ",
      method: "GET",
      url: "https://api.zaim.net/v2/home/money?s=%21%2A%27%28%29&j=%E6%97%A5%E6%9C%AC%E8%AA%9E&sp=a+b",
      signature: "wk41aCAP6pN0yTTRXjmMela9V0U=",
    },
    {
      label: "フォームボディ付きの POST（編集プロキシの経路）",
      method: "POST",
      url: "https://api.zaim.net/v2/home/money/payment/update/12345",
      body: "amount=1280&comment=%E3%83%86%E3%82%B9%E3%83%88+%26+%E7%A2%BA%E8%AA%8D&date=2026-08-07&mapping=1",
      signature: "e73nnCboJ6Rd6tTtjgOL9Kf1HXw=",
    },
  ];

describe("percentEncode", () => {
  it("RFC 3986 の非予約文字はそのまま残す", () => {
    expect(percentEncode("aZ09-._~")).toBe("aZ09-._~");
  });

  it("encodeURIComponent が残す記号もエンコードする", () => {
    // ここを取りこぼすと署名ベース文字列がずれ、署名だけが静かに不一致になる
    expect(percentEncode("!*'()")).toBe("%21%2A%27%28%29");
  });

  it("空白とプラスを区別する", () => {
    expect(percentEncode("a b")).toBe("a%20b");
    expect(percentEncode("a+b")).toBe("a%2Bb");
  });

  it("日本語を UTF-8 のままエンコードする", () => {
    expect(percentEncode("日本語")).toBe("%E6%97%A5%E6%9C%AC%E8%AA%9E");
  });
});

describe("signRequest", () => {
  it.each(VECTORS)("oauthlib と一致する: $label", async ({ method, url, body, signature }) => {
    const bodyParams = body ? Object.fromEntries(new URLSearchParams(body)) : {};
    const signed = await signRequest(method, url, CREDENTIALS, bodyParams, OPTIONS);
    expect(signed.signature).toBe(signature);
  });

  it("Authorization ヘッダに oauth_* を全て載せる", async () => {
    const { authorization } = await signRequest(
      "GET",
      "https://api.zaim.net/v2/home/user/verify",
      CREDENTIALS,
      {},
      OPTIONS,
    );
    expect(authorization).toMatch(/^OAuth /);
    for (const key of [
      "oauth_consumer_key",
      "oauth_nonce",
      "oauth_signature_method",
      "oauth_timestamp",
      "oauth_token",
      "oauth_version",
      "oauth_signature",
    ]) {
      expect(authorization).toContain(`${key}="`);
    }
  });

  it("クエリパラメータは Authorization ヘッダに載せない", async () => {
    // 署名対象には含めるが、ヘッダに載せるのは oauth_* だけ
    const { authorization } = await signRequest(
      "GET",
      "https://api.zaim.net/v2/home/money?mapping=1",
      CREDENTIALS,
      {},
      OPTIONS,
    );
    expect(authorization).not.toContain("mapping");
  });

  it("nonce を省略すると毎回異なる署名になる", async () => {
    const url = "https://api.zaim.net/v2/home/user/verify";
    const a = await signRequest("GET", url, CREDENTIALS);
    const b = await signRequest("GET", url, CREDENTIALS);
    expect(a.signature).not.toBe(b.signature);
  });
});
