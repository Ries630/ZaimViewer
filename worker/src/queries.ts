/**
 * 明細フィルタを SQL に変換する。
 *
 * CLAUDE.md の設計決定「除外は行ごとのフラグではなくクエリのルールで表現する」の
 * 実装箇所。ルールの追加・変更はすべてこのモジュールに閉じる。
 * 将来「よく使う除外条件に名前を付ける」層を載せる場合も、
 * その層は TransactionFilter を組み立てるだけでよく、SQL を書く必要はない。
 */

import type { Database } from "./db";

// 明細一覧の SELECT 句。マスタ名と ID の両方を返す
// （名前は表示用、ID は UI がフィルタを組み立てるために使う）。
//
// v_transactions VIEW を使わず自前で JOIN しているのは、VIEW が ID 列を持たないため。
// VIEW を変更するにはスキーマの変更と再同期が要る一方、API 側の JOIN なら
// ミラーの構造に触れずに済む。
const SELECT_COLUMNS = `
    t.id,
    t.mode,
    t.date,
    t.amount,
    t.category_id,
    c.name  AS category,
    t.genre_id,
    g.name  AS genre,
    t.from_account_id,
    fa.name AS from_account,
    t.to_account_id,
    ta.name AS to_account,
    t.name,
    t.place,
    t.comment,
    t.currency_code
`;

const FROM_JOIN = `
FROM transactions t
LEFT JOIN categories c  ON c.id  = t.category_id
LEFT JOIN genres g      ON g.id  = t.genre_id
LEFT JOIN accounts fa   ON fa.id = t.from_account_id
LEFT JOIN accounts ta   ON ta.id = t.to_account_id
`;

/** LIKE 検索でワイルドカードとして解釈させないための退避文字。 */
const LIKE_ESCAPE = "\\";

/**
 * 明細の絞り込み条件。
 *
 * 未指定（undefined または空配列）の項目は条件を課さない。
 * 「振替を除外」「今日以前だけ」といった既定値は API 側には持たせず、
 * 呼び出し側（PWA）が明示的に指定する。
 */
export interface TransactionFilter {
  /** 開始日（YYYY-MM-DD、この日を含む）。 */
  dateFrom?: string;
  /** 終了日（YYYY-MM-DD、この日を含む）。 */
  dateTo?: string;
  /** 含める mode（payment / income / transfer）。 */
  modes?: string[];
  /** 含めるカテゴリ ID。 */
  categoryIds?: number[];
  /** 含めるジャンル ID。 */
  genreIds?: number[];
  /** 含める口座 ID（出金元・入金先のいずれかが一致すれば該当）。 */
  accountIds?: number[];
  /** 金額の下限（この値を含む）。 */
  amountMin?: number;
  /** 金額の上限（この値を含む）。 */
  amountMax?: number;
  /** 品名・店舗・メモへの部分一致キーワード。 */
  q?: string;
  /** 除外する店舗名（完全一致）。 */
  excludePlaces?: string[];
  /** 除外するジャンル ID。 */
  excludeGenreIds?: number[];
}

/** 組み立て中の WHERE 句とバインド値。 */
class WhereBuilder {
  readonly #clauses: string[] = [];
  readonly #params: unknown[] = [];

  /**
   * 条件を 1 つ追加する。
   *
   * @param clause SQL の条件式（プレースホルダを含む）。
   * @param params プレースホルダにバインドする値。
   */
  add(clause: string, ...params: unknown[]): void {
    this.#clauses.push(clause);
    this.#params.push(...params);
  }

  /**
   * IN / NOT IN 条件を追加する。値が空なら何もしない。
   *
   * @param column 対象の列式。
   * @param values 候補値。空なら条件を追加しない。
   * @param negate true なら NOT IN にする。
   */
  addIn(column: string, values: readonly unknown[] | undefined, negate = false): void {
    if (!values || values.length === 0) return;
    const placeholders = values.map(() => "?").join(", ");
    this.add(`${column} ${negate ? "NOT IN" : "IN"} (${placeholders})`, ...values);
  }

  /** WHERE 句の文字列を返す。条件が無ければ空文字。 */
  render(): string {
    return this.#clauses.length > 0 ? ` WHERE ${this.#clauses.join(" AND ")}` : "";
  }

  /** バインド値を返す。 */
  get params(): unknown[] {
    return this.#params;
  }
}

/**
 * LIKE のワイルドカード（% _）と退避文字自体をエスケープする。
 *
 * @param term 利用者が入力した検索語。
 * @returns LIKE パターンに埋め込める文字列。
 */
function escapeLike(term: string): string {
  let escaped = term;
  for (const char of [LIKE_ESCAPE, "%", "_"]) {
    escaped = escaped.split(char).join(LIKE_ESCAPE + char);
  }
  return escaped;
}

/** WHERE 句とバインド値の組。 */
export interface WhereClause {
  sql: string;
  params: unknown[];
}

/**
 * フィルタを WHERE 句とバインド値に変換する。
 *
 * @param filt 絞り込み条件。
 * @returns WHERE 句（条件が無ければ空文字）とバインド値。
 */
export function buildWhere(filt: TransactionFilter): WhereClause {
  const where = new WhereBuilder();

  if (filt.dateFrom) where.add("t.date >= ?", filt.dateFrom);
  if (filt.dateTo) where.add("t.date <= ?", filt.dateTo);

  where.addIn("t.mode", filt.modes);
  where.addIn("t.category_id", filt.categoryIds);
  where.addIn("t.genre_id", filt.genreIds);

  // 口座は payment なら from、income なら to に入る。
  // 利用者から見れば「その口座の明細」なので、どちらか一致で該当とする。
  if (filt.accountIds && filt.accountIds.length > 0) {
    const placeholders = filt.accountIds.map(() => "?").join(", ");
    where.add(
      `(t.from_account_id IN (${placeholders}) OR t.to_account_id IN (${placeholders}))`,
      ...filt.accountIds,
      ...filt.accountIds,
    );
  }

  if (filt.amountMin !== undefined) where.add("t.amount >= ?", filt.amountMin);
  if (filt.amountMax !== undefined) where.add("t.amount <= ?", filt.amountMax);

  if (filt.q) {
    const pattern = `%${escapeLike(filt.q)}%`;
    where.add(
      "(COALESCE(t.name, '') LIKE ? ESCAPE ?" +
        " OR COALESCE(t.place, '') LIKE ? ESCAPE ?" +
        " OR COALESCE(t.comment, '') LIKE ? ESCAPE ?)",
      pattern,
      LIKE_ESCAPE,
      pattern,
      LIKE_ESCAPE,
      pattern,
      LIKE_ESCAPE,
    );
  }

  // place が NULL の行を NOT IN が取りこぼさないよう COALESCE を挟む
  // （NULL NOT IN (...) は NULL になり、行が消えてしまう）。
  where.addIn("COALESCE(t.place, '')", filt.excludePlaces, true);
  where.addIn("COALESCE(t.genre_id, -1)", filt.excludeGenreIds, true);

  return { sql: where.render(), params: where.params };
}

/** 明細 1 件。マスタ名と ID の両方を持つ。 */
export interface Transaction {
  id: number;
  mode: string;
  date: string;
  amount: number;
  category_id: number | null;
  category: string | null;
  genre_id: number | null;
  genre: string | null;
  from_account_id: number | null;
  from_account: string | null;
  to_account_id: number | null;
  to_account: string | null;
  name: string | null;
  place: string | null;
  comment: string | null;
  currency_code: string | null;
}

/**
 * フィルタに一致する明細を日付の新しい順に取得する。
 *
 * @param db ミラー DB。
 * @param filt 絞り込み条件。
 * @param limit 取得件数の上限。
 * @param offset スキップする件数。
 * @returns 明細のリスト。
 */
export async function fetchTransactions(
  db: Database,
  filt: TransactionFilter,
  limit: number,
  offset: number,
): Promise<Transaction[]> {
  const { sql: whereSql, params } = buildWhere(filt);
  // 同日内の順序を安定させるため id を第 2 キーにする
  // （不安定だとページ送りで明細が重複・欠落する）。
  const sql =
    `SELECT ${SELECT_COLUMNS} ${FROM_JOIN} ${whereSql}` +
    " ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?";
  const { results } = await db
    .prepare(sql)
    .bind(...params, limit, offset)
    .all<Transaction>();
  return results;
}

/** 件数と金額合計。 */
export interface TransactionTotals {
  total: number;
  totalAmount: number;
}

/**
 * フィルタに一致する明細の件数と金額合計を返す。
 *
 * 件数はページャに、合計は「この条件で総額いくらか」の確認に使う。
 * 1 回の集計クエリで両方を得る。
 *
 * @param db ミラー DB。
 * @param filt 絞り込み条件。
 * @returns 件数と金額合計。一致 0 件なら両方 0。
 */
export async function countTransactions(
  db: Database,
  filt: TransactionFilter,
): Promise<TransactionTotals> {
  const { sql: whereSql, params } = buildWhere(filt);
  const sql = `SELECT COUNT(*) AS total, COALESCE(SUM(t.amount), 0) AS total_amount ${FROM_JOIN} ${whereSql}`;
  const row = await db
    .prepare(sql)
    .bind(...params)
    .first<{ total: number; total_amount: number }>();
  return { total: row?.total ?? 0, totalAmount: row?.total_amount ?? 0 };
}
