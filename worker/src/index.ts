/**
 * ZaimViewer の Worker エントリポイント（検証用スパイク）。
 *
 * 方針転換の判断材料を得るための最小構成。
 * - OAuth1.0a 署名が Web Crypto だけで Zaim に通るか
 * - 全件同期の CPU 時間が Workers の枠に収まるか
 * - D1 の batch() でテーブル差し替えが原子的に行えるか
 */

import { Hono } from "hono";

import { type OAuth1Credentials, signRequest } from "./oauth1";
import { syncAll } from "./sync";
import { ZaimClient } from "./zaim";

/** Worker の環境バインディング。 */
interface Env {
  DB: D1Database;
  ZAIM_CONSUMER_KEY: string;
  ZAIM_CONSUMER_SECRET: string;
  ZAIM_ACCESS_TOKEN: string;
  ZAIM_ACCESS_TOKEN_SECRET: string;
}

/**
 * 環境変数から認証情報を組み立てる。
 *
 * @param env Worker の環境バインディング。
 * @returns OAuth1.0a 認証情報。
 */
function credentialsOf(env: Env): OAuth1Credentials {
  return {
    consumerKey: env.ZAIM_CONSUMER_KEY,
    consumerSecret: env.ZAIM_CONSUMER_SECRET,
    accessToken: env.ZAIM_ACCESS_TOKEN,
    accessTokenSecret: env.ZAIM_ACCESS_TOKEN_SECRET,
  };
}

const app = new Hono<{ Bindings: Env }>();

/** 稼働確認。 */
app.get("/", (c) => c.json({ ok: true, service: "zaimviewer-worker (spike)" }));

/**
 * 署名の決定性を確認するための固定ベクタ生成。
 *
 * nonce と timestamp を固定して署名を返す。Python の requests-oauthlib で
 * 同じ入力から生成した署名と一致すれば、実装の同値性が確認できる。
 * 実際の認証情報を使うため署名そのものは秘密ではないが、鍵は返さない。
 */
app.get("/sign-vector", async (c) => {
  const url = c.req.query("url") ?? "https://api.zaim.net/v2/home/money?mapping=1&limit=100&page=1";
  const method = c.req.query("method") ?? "GET";
  const body = c.req.query("body");
  const bodyParams: Record<string, string> = body ? Object.fromEntries(new URLSearchParams(body)) : {};

  const signed = await signRequest(method, url, credentialsOf(c.env), bodyParams, {
    nonce: "fixednonce0123456789",
    timestamp: 1700000000,
  });
  return c.json({ baseString: signed.baseString, signature: signed.signature });
});

/** Zaim への実リクエスト。署名が通るかの end-to-end 検証。 */
app.get("/verify", async (c) => {
  const client = new ZaimClient(credentialsOf(c.env));
  const me = await client.verify();
  return c.json({ ok: true, me });
});

/** 全件同期。件数と所要時間の内訳を返す。 */
app.post("/sync", async (c) => {
  const client = new ZaimClient(credentialsOf(c.env));
  const result = await syncAll(c.env.DB, client);
  return c.json(result);
});

/**
 * CPU 時間だけを切り出して測る。
 *
 * ネットワーク待ちは Workers の CPU 時間に計上されないため、
 * 同期処理のうち「本当に CPU を使う部分」= JSON パースと行の組み立てのみを
 * 1 ページ分の実データに対して繰り返し実行し、全 44 ページ換算で見積もる。
 */
app.get("/cpu-bench", async (c) => {
  const client = new ZaimClient(credentialsOf(c.env));
  // 実データを 1 ページ分だけ取得し、以降はネットワークに触れずに測る
  const page = await client.rawMoneyPage(1);
  // Date.now() は ms 粒度しかないため、回数を増やして分解能を稼ぐ
  const iterations = 500;

  const t = Date.now();
  let rows = 0;
  for (let i = 0; i < iterations; i++) {
    const parsed = JSON.parse(page) as { money: Record<string, unknown>[] };
    for (const row of parsed.money) {
      // 実際の同期と同じ作業量: raw 列用の再シリアライズ
      JSON.stringify(row);
      rows += 1;
    }
  }
  const elapsed = Date.now() - t;

  const perPageMs = elapsed / iterations;
  return c.json({
    bytesPerPage: page.length,
    rowsPerIteration: rows / iterations,
    iterations,
    perPageMs,
    estimatedFullSyncCpuMs: Math.round(perPageMs * 44 * 10) / 10,
  });
});

/**
 * 差し替えバッチの原子性を確認する。
 *
 * 「DROP → RENAME の途中で失敗しても旧テーブルが残る」ことが、
 * Python 版の os.replace に相当する保証の根拠になっている。
 * 故意に失敗するステートメントを末尾に混ぜ、件数が変わらないことを確かめる。
 */
app.get("/swap-rollback-test", async (c) => {
  const before = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first<{ n: number }>();

  await c.env.DB.prepare("DROP TABLE IF EXISTS transactions_new").run();
  await c.env.DB.prepare("CREATE TABLE transactions_new (id INTEGER PRIMARY KEY)").run();

  let failed = false;
  let message = "";
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("DROP TABLE transactions"),
      c.env.DB.prepare("ALTER TABLE transactions_new RENAME TO transactions"),
      // 存在しないテーブルを参照して確実に失敗させる
      c.env.DB.prepare("INSERT INTO no_such_table (id) VALUES (1)"),
    ]);
  } catch (e) {
    failed = true;
    message = e instanceof Error ? e.message : String(e);
  }

  const after = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first<{ n: number }>();
  const indexes = await c.env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'transactions' ORDER BY name",
  ).all<{ name: string }>();

  return c.json({
    batchFailed: failed,
    error: message.slice(0, 200),
    countBefore: before?.n ?? -1,
    countAfter: after?.n ?? -1,
    rolledBack: (before?.n ?? -1) === (after?.n ?? -2),
    indexes: indexes.results.map((r) => r.name),
  });
});

/** 同期結果の確認用。件数と先頭数件を返す。 */
app.get("/transactions", async (c) => {
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first<{ n: number }>();
  const rows = await c.env.DB.prepare(
    "SELECT id, mode, date, amount, name, place FROM transactions ORDER BY date DESC LIMIT 5",
  ).all();
  return c.json({ count: count?.n ?? 0, sample: rows.results });
});

export default app;
