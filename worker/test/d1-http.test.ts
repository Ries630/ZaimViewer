/**
 * D1 の HTTP ドライバを確認する。
 *
 * 実際の Cloudflare API は叩かず、`fetch` を差し替えてリクエストの中身を見る。
 * 本物の API の挙動（数値バインドが INTEGER として格納される、バッチが
 * 単一トランザクションになる）は本番 D1 で確認済みで、ここで検証するのは
 * こちらが組み立てる側の責務だけ。
 */

import { expect, it } from "vitest";

import { D1HttpDatabase } from "../src/d1-http";

/** 差し替えた fetch が受け取ったリクエスト。 */
interface CapturedRequest {
  url: string;
  authorization: string | null;
  body: { batch: { sql: string; params: unknown[] }[] };
}

/** 1 回のテストで使う fetch スタブと、その記録。 */
interface Harness {
  db: D1HttpDatabase;
  requests: CapturedRequest[];
}

/**
 * 応答を順に返す fetch スタブを仕込んだ DB を作る。
 *
 * @param responses 呼ばれた順に返す応答。足りなくなったら最後のものを繰り返す。
 * @returns DB と記録用の配列。
 */
function harness(responses: Response[]): Harness {
  const requests: CapturedRequest[] = [];
  let index = 0;

  const stub: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      authorization: headers.get("Authorization"),
      body: JSON.parse(init?.body as string) as CapturedRequest["body"],
    });
    const res = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return res!.clone();
  };

  const db = new D1HttpDatabase({
    accountId: "acct",
    databaseId: "dbid",
    apiToken: "token",
    fetch: stub,
  });
  return { db, requests };
}

/**
 * Cloudflare API の成功応答を組み立てる。
 *
 * @param rows ステートメントごとの結果行。
 * @returns 応答。
 */
function ok(rows: Record<string, unknown>[][]): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result: rows.map((results) => ({ results, success: true })),
  });
}

it("バッチは 1 リクエストにまとめて送られる", async () => {
  const { db, requests } = harness([ok([[], []])]);
  const stmt = db.prepare("INSERT INTO t (a, b) VALUES (?, ?)");
  await db.batch([stmt.bind(1, "x"), stmt.bind(2, null)]);

  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(
    "https://api.cloudflare.com/client/v4/accounts/acct/d1/database/dbid/query",
  );
  expect(requests[0]?.authorization).toBe("Bearer token");
  expect(requests[0]?.body.batch).toEqual([
    { sql: "INSERT INTO t (a, b) VALUES (?, ?)", params: [1, "x"] },
    { sql: "INSERT INTO t (a, b) VALUES (?, ?)", params: [2, null] },
  ]);
});

it("bind() は元のステートメントを書き換えない", async () => {
  // sync.ts は prepared statement を 1 つ作って全行で使い回すので、
  // ここが破壊的だと全行が最後の値になる
  const { db, requests } = harness([ok([[]])]);
  const stmt = db.prepare("INSERT INTO t (a) VALUES (?)");
  const first = stmt.bind(1);
  stmt.bind(2);
  await db.batch([first]);

  expect(requests[0]?.body.batch[0]?.params).toEqual([1]);
});

it("all() は行を返し、first() は該当が無ければ null を返す", async () => {
  const { db } = harness([ok([[{ id: 1 }]]), ok([[]])]);
  const { results } = await db.prepare("SELECT 1").all<{ id: number }>();
  expect(results).toEqual([{ id: 1 }]);
  expect(await db.prepare("SELECT 1").first()).toBeNull();
});

it("SQL エラーは success: false で届くので例外にする", async () => {
  const failure = Response.json({
    success: false,
    result: [],
    messages: [],
    errors: [{ code: 7500, message: "UNIQUE constraint failed: t.id" }],
  });
  const { db } = harness([failure]);
  await expect(db.prepare("INSERT INTO t (id) VALUES (1)").run()).rejects.toThrow(
    /7500: UNIQUE constraint failed/,
  );
});

it("5xx はリトライし、成功したらその結果を返す", async () => {
  const { db, requests } = harness([
    new Response("bad gateway", { status: 502 }),
    ok([[{ n: 1 }]]),
  ]);
  const { results } = await db.prepare("SELECT 1").all<{ n: number }>();

  expect(requests).toHaveLength(2);
  expect(results).toEqual([{ n: 1 }]);
});

it("リトライ対象でないステータスは即座に例外にする", async () => {
  const { db, requests } = harness([new Response("bad request", { status: 400 })]);
  await expect(db.prepare("SELECT 1").all()).rejects.toThrow(/400/);
  expect(requests).toHaveLength(1);
});

it("他所で作ったステートメントを batch に混ぜると弾く", async () => {
  const { db } = harness([ok([[]])]);
  const alien = {
    bind: () => alien,
    all: async () => ({ results: [] }),
    first: async () => null,
    run: async () => null,
  };
  await expect(db.batch([alien])).rejects.toThrow(TypeError);
});
