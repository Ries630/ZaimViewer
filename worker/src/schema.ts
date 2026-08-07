/**
 * ミラー DB のスキーマ定義。
 *
 * テーブルの実体は `sync.ts` の DDL が作る（同期のたび `*_new` として作り直し、
 * まとめて差し替えるため、テーブル名が動的になり Drizzle からは作れない）。
 * この定義は読み取り側の型付けに使う。2 つがずれていないことは
 * `test/schema.test.ts` が PRAGMA と突き合わせて検証する。
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** 明細（payment / income / transfer すべて）。 */
export const transactions = sqliteTable("transactions", {
  /** Zaim の明細 ID。 */
  id: integer("id").primaryKey(),
  mode: text("mode").notNull(),
  date: text("date").notNull(),
  amount: integer("amount").notNull(),
  categoryId: integer("category_id"),
  genreId: integer("genre_id"),
  fromAccountId: integer("from_account_id"),
  toAccountId: integer("to_account_id"),
  /** 品名。 */
  name: text("name"),
  /** 店舗。 */
  place: text("place"),
  comment: text("comment"),
  currencyCode: text("currency_code"),
  receiptId: integer("receipt_id"),
  active: integer("active"),
  /** Zaim 上の登録日時。 */
  created: text("created"),
  /** API レスポンス原文。将来の列追加に備える。 */
  raw: text("raw").notNull(),
});

/** カテゴリマスタ。 */
export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey(),
  mode: text("mode"),
  name: text("name"),
  sort: integer("sort"),
  active: integer("active"),
  raw: text("raw").notNull(),
});

/** ジャンル（カテゴリ内訳）マスタ。 */
export const genres = sqliteTable("genres", {
  id: integer("id").primaryKey(),
  categoryId: integer("category_id"),
  name: text("name"),
  sort: integer("sort"),
  active: integer("active"),
  raw: text("raw").notNull(),
});

/** 口座マスタ。 */
export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey(),
  name: text("name"),
  sort: integer("sort"),
  active: integer("active"),
  raw: text("raw").notNull(),
});

/** 同期メタ情報。 */
export const syncMeta = sqliteTable("sync_meta", {
  key: text("key").primaryKey(),
  value: text("value"),
});
