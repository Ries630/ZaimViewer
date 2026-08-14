/**
 * 明細フィルタを SQL に変換する。
 *
 * CLAUDE.md の設計決定「除外は行ごとのフラグではなくクエリのルールで表現する」の
 * 実装箇所。ルールの追加・変更はすべてこのモジュールに閉じる。
 * 将来「よく使う除外条件に名前を付ける」層を載せる場合も、
 * その層は TransactionFilter を組み立てるだけでよく SQL を書く必要はない。
 */

import {
  type AnyColumn,
  type SQL,
  and,
  count,
  sum,
  desc,
  eq,
  gte,
  inArray,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import type { MirrorDatabase } from "./db";
import { accounts, categories, genres, transactions } from "./schema";

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

/**
 * フィルタを WHERE 条件のリストに変換する。
 *
 * 未指定の項目は undefined を返す。`and()` が undefined を無視するため、
 * 呼び出し側で絞り込む必要はない。
 *
 * @param filt 絞り込み条件。
 * @returns 条件式のリスト（未指定の項目は undefined）。
 */
function conditions(filt: TransactionFilter): (SQL | undefined)[] {
  const t = transactions;
  const pattern = filt.q ? `%${escapeLike(filt.q)}%` : undefined;

  return [
    filt.dateFrom ? gte(t.date, filt.dateFrom) : undefined,
    filt.dateTo ? lte(t.date, filt.dateTo) : undefined,
    filt.modes?.length ? inArray(t.mode, filt.modes) : undefined,
    filt.categoryIds?.length ? inArray(t.categoryId, filt.categoryIds) : undefined,
    filt.genreIds?.length ? inArray(t.genreId, filt.genreIds) : undefined,

    // 口座は payment なら from、income なら to に入る。
    // 利用者から見れば「その口座の明細」なので、どちらか一致で該当とする。
    filt.accountIds?.length
      ? or(inArray(t.fromAccountId, filt.accountIds), inArray(t.toAccountId, filt.accountIds))
      : undefined,

    filt.amountMin !== undefined ? gte(t.amount, filt.amountMin) : undefined,
    filt.amountMax !== undefined ? lte(t.amount, filt.amountMax) : undefined,

    // LIKE ... ESCAPE は Drizzle のヘルパに無いので sql で書く。
    // 退避文字を渡さないと、利用者が入力した % や _ がワイルドカードとして効いてしまう。
    pattern
      ? or(
          sql`COALESCE(${t.name}, '') LIKE ${pattern} ESCAPE ${LIKE_ESCAPE}`,
          sql`COALESCE(${t.place}, '') LIKE ${pattern} ESCAPE ${LIKE_ESCAPE}`,
          sql`COALESCE(${t.comment}, '') LIKE ${pattern} ESCAPE ${LIKE_ESCAPE}`,
        )
      : undefined,

    // place が NULL の行を NOT IN が取りこぼさないよう COALESCE を挟む
    // （NULL NOT IN (...) は NULL になり、行が消えてしまう）。
    filt.excludePlaces?.length
      ? notInArray(sql`COALESCE(${t.place}, '')`, filt.excludePlaces)
      : undefined,
    filt.excludeGenreIds?.length
      ? notInArray(sql`COALESCE(${t.genreId}, -1)`, filt.excludeGenreIds)
      : undefined,
  ];
}

/** 明細 1 件。マスタ名と ID の両方を持つ（名前は表示用、ID は UI がフィルタを組むため）。 */
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
  db: MirrorDatabase,
  filt: TransactionFilter,
  limit: number,
  offset: number,
): Promise<Transaction[]> {
  const t = transactions;
  // 出金元と入金先で accounts を 2 回引くため別名を付ける
  const fromAccount = alias(accounts, "fa");
  const toAccount = alias(accounts, "ta");

  return await db
    .select({
      id: t.id,
      mode: t.mode,
      date: t.date,
      amount: t.amount,
      category_id: t.categoryId,
      category: categories.name,
      genre_id: t.genreId,
      genre: genres.name,
      from_account_id: t.fromAccountId,
      from_account: fromAccount.name,
      to_account_id: t.toAccountId,
      to_account: toAccount.name,
      name: t.name,
      place: t.place,
      comment: t.comment,
      currency_code: t.currencyCode,
    })
    .from(t)
    .leftJoin(categories, eq(categories.id, t.categoryId))
    .leftJoin(genres, eq(genres.id, t.genreId))
    .leftJoin(fromAccount, eq(fromAccount.id, t.fromAccountId))
    .leftJoin(toAccount, eq(toAccount.id, t.toAccountId))
    .where(and(...conditions(filt)))
    // 同日内の順序を安定させるため id を第 2 キーにする
    // （不安定だとページ送りで明細が重複・欠落する）。
    .orderBy(desc(t.date), desc(t.id))
    .limit(limit)
    .offset(offset);
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
  db: MirrorDatabase,
  filt: TransactionFilter,
): Promise<TransactionTotals> {
  const [row] = await db
    .select({
      total: count(),
      totalAmount: sum(transactions.amount),
    })
    .from(transactions)
    .where(and(...conditions(filt)));

  return { total: row?.total ?? 0, totalAmount: Number(row?.totalAmount ?? 0) };
}

/**
 * 非アクティブなマスタを末尾へ回す並び順。
 *
 * Zaim で削除したマスタは `sort` が 0 に潰れるため、素直に `sort` で並べると
 * 削除済みのものが必ず先頭に来る。実データでは口座の先頭 4 件がこれに当たっていた。
 *
 * @param column 対象の `active` 列。
 * @returns 並び替え用の式。
 */
function activeFirst(column: SQL | AnyColumn): SQL {
  return sql`CASE WHEN ${column} = 1 THEN 0 ELSE 1 END`;
}

/**
 * 支出 → 収入 → その他の並び順。
 *
 * `mode` の辞書順だと `income` が `payment` より先になり、Zaim の画面
 * （支出が先）と食い違う。
 *
 * @param column 対象の `mode` 列。
 * @returns 並び替え用の式。
 */
function modeOrder(column: SQL | AnyColumn): SQL {
  return sql`CASE ${column} WHEN 'payment' THEN 0 WHEN 'income' THEN 1 ELSE 2 END`;
}

/**
 * 選択肢として出す価値があるマスタか判定する条件を作る。
 *
 * Zaim で削除したマスタ（`active = -1`）は隠す。ただし明細から参照されている
 * ものは残す。隠すと、その明細を口座やカテゴリで絞る手段が無くなるため。
 * 本番の実測では、削除済みカテゴリを参照する明細は 0 件、削除済み口座を
 * 参照する明細は 18 件（全 4,370 件の 0.4%）だった。
 *
 * @param active 対象の `active` 列。
 * @param referenced 明細から参照されていることを表す条件。
 * @returns WHERE に渡す条件。
 */
function selectable(active: AnyColumn, referenced: SQL): SQL {
  return sql`(${active} = 1 OR ${referenced})`;
}

/** フィルタ UI の選択肢に使うマスタ一式。 */
export interface Masters {
  categories: {
    id: number;
    mode: string | null;
    name: string | null;
    sort: number | null;
    active: number | null;
  }[];
  genres: {
    id: number;
    category_id: number | null;
    name: string | null;
    sort: number | null;
    active: number | null;
  }[];
  accounts: { id: number; name: string | null; sort: number | null; active: number | null }[];
}

/**
 * マスタ一式を、Zaim の画面と同じ並びで返す。
 *
 * 並びは「有効なものが先 → 支出・収入の順 → Zaim の `sort` → id」。
 * ジャンルはカテゴリの並びに従わせる（`category_id` の数値順では、
 * カテゴリ一覧と見出しの順序が揃わない）。
 *
 * @param db ミラー DB。
 * @returns カテゴリ・ジャンル・口座。
 */
export async function fetchMasters(db: MirrorDatabase): Promise<Masters> {
  const c = categories;
  const g = genres;
  const a = accounts;

  const [categoryRows, genreRows, accountRows] = await Promise.all([
    db
      .select({ id: c.id, mode: c.mode, name: c.name, sort: c.sort, active: c.active })
      .from(c)
      .where(
        selectable(c.active, sql`EXISTS (SELECT 1 FROM transactions WHERE category_id = ${c.id})`),
      )
      .orderBy(activeFirst(c.active), modeOrder(c.mode), c.sort, c.id),

    db
      .select({ id: g.id, category_id: g.categoryId, name: g.name, sort: g.sort, active: g.active })
      .from(g)
      .leftJoin(c, eq(c.id, g.categoryId))
      .where(
        selectable(g.active, sql`EXISTS (SELECT 1 FROM transactions WHERE genre_id = ${g.id})`),
      )
      // カテゴリを引けないジャンルは末尾へ。NULL は SQLite の昇順で先頭に来るため、
      // COALESCE で明示的に大きい値へ倒す
      .orderBy(
        activeFirst(g.active),
        sql`COALESCE(${activeFirst(c.active)}, 9)`,
        sql`COALESCE(${modeOrder(c.mode)}, 9)`,
        sql`COALESCE(${c.sort}, 999999)`,
        sql`COALESCE(${c.id}, 999999)`,
        g.sort,
        g.id,
      ),

    db
      .select({ id: a.id, name: a.name, sort: a.sort, active: a.active })
      .from(a)
      .where(
        selectable(
          a.active,
          sql`EXISTS (SELECT 1 FROM transactions
                      WHERE from_account_id = ${a.id} OR to_account_id = ${a.id})`,
        ),
      )
      .orderBy(activeFirst(a.active), a.sort, a.id),
  ]);

  return { categories: categoryRows, genres: genreRows, accounts: accountRows };
}
