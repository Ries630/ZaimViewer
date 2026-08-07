/**
 * ミラー DB へのアクセス境界。
 *
 * 読み取り（queries.ts）と書き込み（sync.ts）で必要なものが違うため、
 * 2 つの型を用意している。どちらもドライバ固有の型を名指ししないので、
 * 配置先（Workers + D1 / 手元の Bun + SQLite / HTTP 越しの D1）を
 * あとから選べる。
 */

import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

/**
 * 読み取り用。Drizzle のクエリビルダを通して使う。
 *
 * ドライバを問わない形にしてあるので、`drizzle-orm/d1`・`drizzle-orm/libsql`・
 * `drizzle-orm/sqlite-proxy`・`drizzle-orm/bun-sqlite` のいずれで作った
 * インスタンスでも渡せる。
 */
export type MirrorDatabase = BaseSQLiteDatabase<"async", unknown>;

/** バインド済みで実行可能なステートメント。 */
export interface PreparedStatement {
  /** プレースホルダに値を束縛した新しいステートメントを返す。 */
  bind(...values: unknown[]): PreparedStatement;
  /** 全行を取得する。 */
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  /** 先頭 1 行を取得する。該当が無ければ null。 */
  first<T = Record<string, unknown>>(): Promise<T | null>;
  /** 行を返さないステートメントを実行する。 */
  run(): Promise<unknown>;
}

/**
 * 書き込み用。素の SQL を直接投げる。
 *
 * 同期はテーブルを `*_new` として作り直してから差し替えるため、
 * テーブル名が動的になり Drizzle のスキーマでは表現できない。
 * DDL と一括 INSERT では ORM の利点も出ないので、ここは素のままにしてある。
 * D1Database はこの形を構造的に満たす。
 */
export interface Database {
  /** SQL を準備する。 */
  prepare(sql: string): PreparedStatement;
  /** 複数のステートメントを単一トランザクションとして実行する。 */
  batch(statements: PreparedStatement[]): Promise<unknown[]>;
}
