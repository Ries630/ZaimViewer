/**
 * D1 の HTTP API 越しに動く `Database` 実装。
 *
 * 同期は Worker の中では動かせない（CPU 時間と invocation あたりクエリ数の
 * 両方に収まらない）ため、手元から実行して D1 を書き換える経路が要る。
 * `db.ts` の `Database` がドライバを名指ししない形になっているので、
 * ここを差し替えるだけで `sync.ts` の同期処理をそのまま再利用できる。
 *
 * Cloudflare API の `POST /accounts/{id}/d1/database/{id}/query` は
 * `{ batch: [...] }` 形式を受け付け、バッチ全体を 1 トランザクションとして扱う。
 * これによりテーブル差し替えの原子性が Workers バインディング経由と同じになる。
 */

import type { Database, PreparedStatement } from "./db";

const API_BASE = "https://api.cloudflare.com/client/v4";

/** リトライしてよい HTTP ステータス。429 は API のレート制限、5xx は一時障害。 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** リトライ上限と初回の待機ミリ秒（以降は倍々に伸ばす）。 */
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

/** D1 の HTTP API に接続するための設定。 */
export interface D1HttpConfig {
  /** Cloudflare のアカウント ID。 */
  accountId: string;
  /** D1 データベースの ID（`wrangler.jsonc` の `database_id`）。 */
  databaseId: string;
  /** `Account > D1 > Edit` 権限を持つ API トークン。 */
  apiToken: string;
  /** 差し替え可能な fetch。テストで実際の通信を避けるために使う。 */
  fetch?: typeof fetch;
}

/** 1 ステートメント分の実行結果。 */
interface D1QueryResult {
  results: Record<string, unknown>[];
  success: boolean;
}

/** Cloudflare API 共通のレスポンス封筒。 */
interface CloudflareEnvelope {
  success: boolean;
  result: D1QueryResult[];
  errors: { code: number; message: string }[];
}

/** 送信に必要な接続情報。ステートメントと DB の両方が持つ。 */
interface Connection {
  endpoint: string;
  apiToken: string;
  fetch: typeof fetch;
}

/**
 * 指定ミリ秒だけ待つ。
 *
 * @param ms 待機ミリ秒。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ステートメント群を 1 リクエストにまとめて送る。
 *
 * バッチは単一トランザクションとして実行されるため、途中で失敗すれば
 * どの文も反映されない。よってリトライで同じバッチを二重に適用する心配は
 * 「サーバ側では成功したが応答が届かなかった」場合に限られ、その場合は
 * INSERT の主キー衝突として表に出る。同期全体は `*_new` の DROP から
 * 始まるので、そのときは最初からやり直せばよい。
 *
 * @param conn 接続情報。
 * @param statements 実行するステートメント。
 * @returns ステートメントと同じ順に並んだ結果。
 * @throws HTTP エラー、または API が `success: false` を返した場合。
 */
async function send(conn: Connection, statements: HttpStatement[]): Promise<D1QueryResult[]> {
  const body = JSON.stringify({
    batch: statements.map((s) => ({ sql: s.sql, params: s.params })),
  });

  for (let attempt = 0; ; attempt++) {
    const res = await conn.fetch(conn.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${conn.apiToken}`,
        "Content-Type": "application/json",
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      throw new Error(`D1 HTTP API error ${res.status}: ${text.slice(0, 500)}`);
    }

    // HTTP 200 でも SQL エラーは success: false で返る
    const envelope = (await res.json()) as CloudflareEnvelope;
    if (!envelope.success) {
      const detail = envelope.errors.map((e) => `${e.code}: ${e.message}`).join(", ");
      throw new Error(`D1 query failed: ${detail || "(詳細なし)"}`);
    }
    return envelope.result;
  }
}

/** バインド済みの 1 ステートメント。`bind()` は元を書き換えず新しい値を返す。 */
class HttpStatement implements PreparedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly #conn: Connection;

  /**
   * @param conn 接続情報。
   * @param sql プレースホルダを含む SQL。
   * @param params バインド済みの値。
   */
  constructor(conn: Connection, sql: string, params: readonly unknown[]) {
    this.#conn = conn;
    this.sql = sql;
    this.params = params;
  }

  /**
   * プレースホルダに値を束縛した新しいステートメントを返す。
   *
   * `sync.ts` は 1 つの prepared statement を全行で使い回すので、
   * ここで元のインスタンスを書き換えてはならない。
   *
   * @param values 束縛する値。
   * @returns 新しいステートメント。
   */
  bind(...values: unknown[]): PreparedStatement {
    return new HttpStatement(this.#conn, this.sql, values);
  }

  /**
   * 全行を取得する。
   *
   * @returns 取得した行。
   */
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const [result] = await send(this.#conn, [this]);
    return { results: (result?.results ?? []) as T[] };
  }

  /**
   * 先頭 1 行を取得する。
   *
   * @returns 先頭の行。該当が無ければ null。
   */
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const { results } = await this.all<T>();
    return results[0] ?? null;
  }

  /**
   * 行を返さないステートメントを実行する。
   *
   * @returns 実行結果。
   */
  async run(): Promise<unknown> {
    const [result] = await send(this.#conn, [this]);
    return result;
  }
}

/** D1 の HTTP API を叩く `Database` 実装。 */
export class D1HttpDatabase implements Database {
  readonly #conn: Connection;

  /**
   * @param config 接続設定。
   */
  constructor(config: D1HttpConfig) {
    this.#conn = {
      endpoint: `${API_BASE}/accounts/${config.accountId}/d1/database/${config.databaseId}/query`,
      apiToken: config.apiToken,
      fetch: config.fetch ?? fetch,
    };
  }

  /**
   * SQL を準備する。
   *
   * @param sql プレースホルダを含む SQL。
   * @returns バインド前のステートメント。
   */
  prepare(sql: string): PreparedStatement {
    return new HttpStatement(this.#conn, sql, []);
  }

  /**
   * 複数のステートメントを単一トランザクションとして実行する。
   *
   * @param statements 実行するステートメント。
   * @returns ステートメントと同じ順に並んだ結果。
   * @throws このドライバが作っていないステートメントが混ざっていた場合。
   */
  async batch(statements: PreparedStatement[]): Promise<unknown[]> {
    const own = statements.map((s) => {
      if (!(s instanceof HttpStatement)) {
        throw new TypeError("D1HttpDatabase.prepare() で作ったステートメントではない");
      }
      return s;
    });
    return await send(this.#conn, own);
  }
}
