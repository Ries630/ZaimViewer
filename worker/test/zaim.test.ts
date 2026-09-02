/** ZaimClient の更新リクエスト境界を検証する。 */

import { describe, expect, it, vi } from "vitest";

import { ZaimClient } from "../src/zaim";

const CREDENTIALS = {
  consumerKey: "consumer-key",
  consumerSecret: "consumer-secret",
  accessToken: "access-token",
  accessTokenSecret: "access-token-secret",
};

/** 成功レスポンスを返す fetch の代替を作る。 */
function createFetchMock(): typeof fetch {
  return vi.fn<typeof fetch>(async () => Response.json({ money: { id: 123 } }));
}

/** 配列の要素が存在することをテスト内で明示する。 */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("期待したテスト値がない");
  return value;
}

describe("ZaimClient.updateReceiptId", () => {
  it("最新の amount と receipt_id だけをフォームボディへ載せる", async () => {
    const request = createFetchMock();
    const client = new ZaimClient(CREDENTIALS, request);

    await client.updateReceiptId("payment", 123, 1280, 4_200_000_001);

    expect(request).toHaveBeenCalledOnce();
    const [input, init] = required(vi.mocked(request).mock.calls[0]);
    expect(new Request(input).url).toBe("https://api.zaim.net/v2/home/money/payment/update/123");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: expect.stringMatching(/^OAuth /),
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    const body = init?.body;
    if (!(body instanceof URLSearchParams)) throw new Error("フォームボディではない");
    expect(body).toEqual(
      new URLSearchParams({ amount: "1280", receipt_id: "4200000001", mapping: "1" }),
    );
  });

  it("income の更新先を mode から組み立てる", async () => {
    const request = createFetchMock();
    const client = new ZaimClient(CREDENTIALS, request);

    await client.updateReceiptId("income", 456, 5000, 4_200_000_002);

    expect(new Request(required(vi.mocked(request).mock.calls[0])[0]).url).toBe(
      "https://api.zaim.net/v2/home/money/income/update/456",
    );
  });

  it("Zaim が 200 以外を返したら本文を含むエラーにする", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("rate limited", { status: 429 }));
    const client = new ZaimClient(CREDENTIALS, request);

    await expect(client.updateReceiptId("payment", 123, 1280, 4_200_000_001)).rejects.toThrow(
      "Zaim API error 429: rate limited",
    );
  });
});
