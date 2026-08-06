/**
 * Zaim REST API v2 のクライアント（OAuth1.0a 認証）。
 *
 * Python 版 `src/zaimviewer/zaim_client.py` の移植。
 * fetch と Web Crypto のみで動くため Workers 上でそのまま走る。
 */

import { type OAuth1Credentials, signRequest } from "./oauth1";

const BASE_URL = "https://api.zaim.net/v2";

/** ページング 1 回あたりの取得件数（API 上限）。 */
const PAGE_LIMIT = 100;

/** 連続リクエスト間の待機ミリ秒（レート制限への配慮）。 */
const REQUEST_INTERVAL_MS = 300;

/** Zaim の明細 1 件（必要な列のみ。実際は他のキーも含む）。 */
export interface ZaimMoney {
  id: number;
  mode: string;
  date: string;
  amount: number;
  category_id?: number;
  genre_id?: number;
  from_account_id?: number;
  to_account_id?: number;
  name?: string;
  place?: string;
  comment?: string;
  currency_code?: string;
  receipt_id?: number;
  active?: number;
  created?: string;
  [key: string]: unknown;
}

/** Zaim のマスタ 1 件（categories / genres / accounts 共通の緩い型）。 */
export interface ZaimMaster {
  id: number;
  [key: string]: unknown;
}

/**
 * 指定ミリ秒だけ待つ。
 *
 * @param ms 待機ミリ秒。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Zaim API v2 を呼び出すクライアント。 */
export class ZaimClient {
  readonly #credentials: OAuth1Credentials;

  /**
   * @param credentials Zaim API の OAuth1.0a 認証情報。
   */
  constructor(credentials: OAuth1Credentials) {
    this.#credentials = credentials;
  }

  /**
   * 署名付き GET を送り JSON を返す。
   *
   * @param path BASE_URL からの相対パス（先頭 / 付き）。
   * @param params クエリパラメータ。
   * @returns レスポンス JSON。
   * @throws HTTP ステータスが 200 以外の場合。
   */
  async #get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(BASE_URL + path);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const { authorization } = await signRequest("GET", url.toString(), this.#credentials);
    const res = await fetch(url, { headers: { Authorization: authorization } });

    if (res.status !== 200) {
      const body = await res.text();
      throw new Error(`Zaim API error ${res.status}: ${body.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }

  /**
   * 認証確認とユーザー情報の取得。
   *
   * @returns ユーザー情報。
   */
  async verify(): Promise<Record<string, unknown>> {
    const data = await this.#get<{ me: Record<string, unknown> }>("/home/user/verify");
    return data.me;
  }

  /**
   * ユーザーのカテゴリ一覧を取得する。
   *
   * @returns カテゴリのリスト。
   */
  async categories(): Promise<ZaimMaster[]> {
    const data = await this.#get<{ categories: ZaimMaster[] }>("/home/category", { mapping: "1" });
    return data.categories;
  }

  /**
   * ユーザーのジャンル（カテゴリ内訳）一覧を取得する。
   *
   * @returns ジャンルのリスト。
   */
  async genres(): Promise<ZaimMaster[]> {
    const data = await this.#get<{ genres: ZaimMaster[] }>("/home/genre", { mapping: "1" });
    return data.genres;
  }

  /**
   * ユーザーの口座一覧を取得する。
   *
   * @returns 口座のリスト。
   */
  async accounts(): Promise<ZaimMaster[]> {
    const data = await this.#get<{ accounts: ZaimMaster[] }>("/home/account", { mapping: "1" });
    return data.accounts;
  }

  /**
   * 全明細をページ単位で順に返す。
   *
   * 日付フィルタを付けず全期間を新しい順に走査する。
   *
   * @yields 明細のリスト（1 ページ分、最大 PAGE_LIMIT 件）。
   */
  async *iterMoney(): AsyncGenerator<ZaimMoney[]> {
    let page = 1;
    for (;;) {
      const data = await this.#get<{ money: ZaimMoney[] }>("/home/money", {
        mapping: "1",
        limit: String(PAGE_LIMIT),
        page: String(page),
      });
      const chunk = data.money;
      if (chunk.length === 0) return;
      yield chunk;
      if (chunk.length < PAGE_LIMIT) return;
      page += 1;
      await sleep(REQUEST_INTERVAL_MS);
    }
  }
}
