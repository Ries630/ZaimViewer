/** ZaimClient の更新リクエスト境界を検証する。 */

import { describe, expect, it, vi } from "vitest";

import { ZaimClient } from "../src/zaim";
import { EDIT_REQUEST_TIMEOUT_MS } from "../src/edit-contract";

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

  it("Zaim が 200 以外を返したら本文を含めずステータスを返す", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("rate limited", { status: 429 }));
    const client = new ZaimClient(CREDENTIALS, request);

    await expect(client.updateReceiptId("payment", 123, 1280, 4_200_000_001)).rejects.toThrow(
      "Zaim API error 429",
    );
    await expect(client.updateReceiptId("payment", 123, 1280, 4_200_000_001)).rejects.not.toThrow(
      "rate limited",
    );
  });
});

describe("ZaimClient.updateMoney", () => {
  it("mode/id の PUT へ mapping と amount を含めたフォームを送る", async () => {
    const request = createFetchMock();
    const client = new ZaimClient(CREDENTIALS, request);

    await client.updateMoney("payment", 123, {
      amount: 1280,
      date: "2026-09-05",
      category_id: 101,
      genre_id: 1001,
      from_account_id: 11,
      comment: "更新",
    });

    const [input, init] = required(vi.mocked(request).mock.calls[0]);
    expect(new Request(input).url).toBe("https://api.zaim.net/v2/home/money/payment/123");
    expect(init?.method).toBe("PUT");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = init?.body;
    if (!(body instanceof URLSearchParams)) throw new Error("フォームボディではない");
    expect(body).toEqual(
      new URLSearchParams({
        mapping: "1",
        amount: "1280",
        date: "2026-09-05",
        category_id: "101",
        genre_id: "1001",
        from_account_id: "11",
        comment: "更新",
      }),
    );
  });

  it("通信失敗や HTTP エラーに生本文を含めない", async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response("private details", { status: 400 }),
    );
    const client = new ZaimClient(CREDENTIALS, request);

    await expect(client.updateMoney("income", 456, { amount: 5000 })).rejects.toThrow(
      "Zaim API error 400",
    );
    await expect(client.updateMoney("income", 456, { amount: 5000 })).rejects.not.toThrow(
      "private details",
    );
  });
});

describe("ZaimClient.moneyById", () => {
  it("ヘッダ受信後に本文が止まっても編集要求の期限で中断する", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<typeof fetch>(async (_input, init) => {
        const response = Response.json({ money: [] });
        vi.spyOn(response, "json").mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        );
        return response;
      });
      const result = new ZaimClient(CREDENTIALS, request).moneyById("payment", 123, "2026-09-05");
      const assertion = expect(result).rejects.toThrow("応答を読み取れませんでした");
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(EDIT_REQUEST_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

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

  it("transfer も編集経路の指定日検索対象にできる", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        money: [
          {
            id: 7,
            mode: "transfer",
            date: "2026-07-26",
            amount: 50000,
            currency_code: "JPY",
            active: 1,
          },
        ],
      }),
    );
    const client = new ZaimClient(CREDENTIALS, request);

    await expect(client.moneyById("transfer", 7, "2026-07-26")).resolves.toMatchObject({ id: 7 });
  });
});
