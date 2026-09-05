/**
 * Zaim REST API v2 のクライアント（OAuth1.0a 認証）。
 *
 * fetch と Web Crypto のみで動くため Workers 上でそのまま走る。
 */

import type { EditChanges, EditMode } from "./edit-contract";
import { EDIT_REQUEST_TIMEOUT_MS, MAX_EDIT_LOOKUP_PAGES } from "./edit-contract";
import { type OAuth1Credentials, signRequest } from "./oauth1";

const BASE_URL = "https://api.zaim.net/v2";

/** ページング 1 回あたりの取得件数（API 上限）。 */
const PAGE_LIMIT = 100;

/** 連続リクエスト間の待機ミリ秒（レート制限への配慮）。 */
const REQUEST_INTERVAL_MS = 300;

/** Zaim の更新フォーム。キーを増やす場合も mapping と文字列値を保つ。 */
interface MoneyUpdateForm {
  mapping: string;
  [key: string]: string;
}

/** 部分更新フォームへ載せる値を文字列化する。undefined は省略する。 */
type MoneyUpdateValue = string | number | null | undefined;
function encodeMoneyUpdateValue(value: MoneyUpdateValue): string | undefined {
  if (value === undefined) return undefined;
  return value === null ? "" : String(value);
}

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

/** `receipt_id` を後付けする対象の明細種別。振替は検証未了のため含めない。 */
export type ReceiptIdUpdateMode = "payment" | "income";

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
  readonly #fetch: typeof fetch;

  /**
   * @param credentials Zaim API の OAuth1.0a 認証情報。
   * @param request HTTP リクエスト関数。テストでは外部通信を差し替える。
   */
  constructor(credentials: OAuth1Credentials, request: typeof fetch = fetch) {
    this.#credentials = credentials;
    this.#fetch = request;
  }

  /**
   * 署名付き GET を送り JSON を返す。
   *
   * @param path BASE_URL からの相対パス（先頭 / 付き）。
   * @param params クエリパラメータ。
   * @returns レスポンス JSON。
   * @throws HTTP ステータスが 200 以外の場合。
   */
  async #get<T>(path: string, params: Record<string, string> = {}, timeoutMs?: number): Promise<T> {
    const url = new URL(BASE_URL + path);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const { authorization } = await signRequest("GET", url.toString(), this.#credentials);
    const controller = timeoutMs === undefined ? undefined : new AbortController();
    const timeout =
      timeoutMs === undefined ? undefined : setTimeout(() => controller?.abort(), timeoutMs);
    try {
      const res = await this.#fetch(url, {
        headers: { Authorization: authorization },
        ...(controller === undefined ? {} : { signal: controller.signal }),
      }).catch(() => {
        throw new Error("Zaim API への通信結果を確認できませんでした");
      });
      if (res.status !== 200) {
        await res.body?.cancel();
        throw new Error(`Zaim API error ${res.status}`);
      }
      // SAFETY: 各呼び出し元が期待する Zaim 応答の型を指定し、編集経路では
      // 保存エンジンが snapshot と raw を照合する。
      return (await res.json().catch(() => {
        throw new Error("Zaim API の応答を読み取れませんでした");
      })) as T;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  /**
   * 署名付きフォーム POST を送る。
   *
   * @param path BASE_URL からの相対パス（先頭 / 付き）。
   * @param params フォームボディ。
   * @throws HTTP ステータスが 200 以外の場合。
   */
  async #post(path: string, params: Record<string, string>): Promise<void> {
    const url = BASE_URL + path;
    const { authorization } = await signRequest("POST", url, this.#credentials, params);
    const res = await this.#fetch(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params),
    });

    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error(`Zaim API error ${res.status}`);
    }
  }

  /**
   * 署名付きフォーム PUT を送る。
   *
   * 編集 API のエラー本文には明細やアカウント情報が含まれる可能性があるため、
   * 呼び出し側へ本文を渡さない。外部更新後の結果不明を安全側に扱うため、
   * ステータスだけをエラーへ残す。
   *
   * @param path BASE_URL からの相対パス（先頭 / 付き）。
   * @param params フォームボディ。
   * @throws HTTP ステータスが 200 以外の場合。
   */
  async #put(path: string, params: Record<string, string>): Promise<void> {
    const url = BASE_URL + path;
    const { authorization } = await signRequest("PUT", url, this.#credentials, params);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EDIT_REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: "PUT",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(params),
        signal: controller.signal,
      });
    } catch {
      throw new Error("Zaim API への通信結果を確認できませんでした");
    } finally {
      clearTimeout(timeout);
    }

    await res.body?.cancel();
    if (res.status !== 200) {
      throw new Error(`Zaim API error ${res.status}`);
    }
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
   * mode と現在日で範囲を絞り、指定 ID の明細を取得する。
   *
   * Zaim の一覧 API に ID フィルタが無いため、日付と mode で絞ったページを走査する。
   * 更新直前の amount と receipt_id を確認する用途で使う。
   *
   * @param mode 支出・収入・振替。
   * @param id 明細 ID。
   * @param date 現在の明細日。
   * @returns 最新の明細。指定日に見つからなければ undefined。
   */
  async moneyById(mode: EditMode, id: number, date: string): Promise<ZaimMoney | undefined> {
    let page = 1;
    for (;;) {
      const data = await this.#get<{ money: ZaimMoney[] }>(
        "/home/money",
        {
          mapping: "1",
          mode,
          start_date: date,
          end_date: date,
          limit: String(PAGE_LIMIT),
          page: String(page),
        },
        EDIT_REQUEST_TIMEOUT_MS,
      );
      const found = data.money.find((item) => item.id === id && item.mode === mode);
      if (found) return found;
      if (data.money.length < PAGE_LIMIT) return undefined;
      if (page >= MAX_EDIT_LOOKUP_PAGES) {
        throw new Error("Zaim API の明細検索上限を超えました");
      }
      page += 1;
      await sleep(REQUEST_INTERVAL_MS);
    }
  }

  /**
   * 既存明細を部分更新する。
   *
   * amount は Zaim API の仕様上、省略すると 0 になるため呼び出し側で必須にする。
   * undefined の項目は送らず、null は空文字として明示的な消去に変換する。
   *
   * @param mode 更新する明細種別。
   * @param id 更新する明細 ID。
   * @param changes 変更項目。amount は必須。
   */
  async updateMoney(
    mode: EditMode,
    id: number,
    changes: EditChanges & { amount: number },
  ): Promise<void> {
    const params: MoneyUpdateForm = { mapping: "1" };
    for (const [key, value] of Object.entries(changes)) {
      const encoded = encodeMoneyUpdateValue(value);
      if (encoded !== undefined) params[key] = encoded;
    }
    await this.#put(`/home/money/${mode}/${id}`, params);
  }

  /**
   * 既存明細の `receipt_id` だけを更新する。
   *
   * Zaim は更新時に `amount` を省略すると 0 にするため、必須引数として同送する。
   * 振替は更新挙動と画面表示が未検証なので、この境界では受け付けない。
   *
   * @param mode 支出または収入。
   * @param id 更新する明細 ID。
   * @param amount Zaim API から直前に取得した金額。
   * @param receiptId 設定するレシート ID。0 は元に戻す操作。
   */
  async updateReceiptId(
    mode: ReceiptIdUpdateMode,
    id: number,
    amount: number,
    receiptId: number,
  ): Promise<void> {
    await this.#post(`/home/money/${mode}/update/${id}`, {
      amount: String(amount),
      receipt_id: String(receiptId),
      mapping: "1",
    });
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
