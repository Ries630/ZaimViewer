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

describe("ZaimClient.moneyById", () => {
  it("mode と現在日で絞り、対象 ID の最新明細を返す", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        money: [
          {
            id: 123,
            mode: "payment",
            date: "2026-04-01",
            amount: 9999,
            receipt_id: 0,
          },
        ],
      }),
    );
    const client = new ZaimClient(CREDENTIALS, request);

    const money = await client.moneyById("payment", 123, "2026-04-01");

    expect(money).toMatchObject({ id: 123, amount: 9999 });
    const url = new Request(required(vi.mocked(request).mock.calls[0])[0]).url;
    expect(url).toBe(
      "https://api.zaim.net/v2/home/money?mapping=1&mode=payment&start_date=2026-04-01&end_date=2026-04-01&limit=100&page=1",
    );
  });

  it("指定日のレスポンスに対象 ID がなければ undefined を返す", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ money: [] }));
    const client = new ZaimClient(CREDENTIALS, request);

    await expect(client.moneyById("income", 456, "2026-03-01")).resolves.toBeUndefined();
  });
});
