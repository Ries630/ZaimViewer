/**
 * Drizzle のスキーマ定義と、実際に作られるテーブルの一致を検証する。
 *
 * テーブルの実体は `sync.ts` の DDL が作り、読み取りの型付けは
 * `schema.ts` が担う。両者は別々に書かれているため、片方だけ変更すると
 * 型は通るのに実行時に列が無い、という壊れ方をする。
 * ここで PRAGMA と突き合わせて、その食い違いを検出する。
 */

import { env } from "cloudflare:test";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { beforeAll, describe, expect, it } from "vitest";

import { accounts, categories, genres, syncMeta, transactions } from "../src/schema";
import { seedDatabase } from "./fixtures";

/** 実テーブルの列情報（PRAGMA table_info の結果）。 */
interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

/** 比較用に正規化した列の姿。 */
interface NormalizedColumn {
  name: string;
  type: string;
  notNull: boolean;
}

const TABLES = [transactions, categories, genres, accounts, syncMeta];

beforeAll(async () => {
  await seedDatabase(env.DB);
});

describe("スキーマ定義と実テーブルの一致", () => {
  it.each(TABLES.map((table) => [getTableConfig(table).name, table] as const))(
    "%s",
    async (tableName, table) => {
      const { results } = await env.DB.prepare(`PRAGMA table_info(${tableName})`).all<ColumnInfo>();

      // SQLite の INTEGER PRIMARY KEY は rowid の別名で notnull が 0 になるが、
      // 意味としては NOT NULL なので主キーは NOT NULL として扱う
      const actual: NormalizedColumn[] = results
        .map((column) => ({
          name: column.name,
          type: column.type.toLowerCase(),
          notNull: column.notnull === 1 || column.pk === 1,
        }))
        .toSorted((a, b) => a.name.localeCompare(b.name));

      const expected: NormalizedColumn[] = getTableConfig(table)
        .columns.map((column) => ({
          name: column.name,
          type: column.getSQLType().toLowerCase(),
          notNull: column.notNull || column.primary,
        }))
        .toSorted((a, b) => a.name.localeCompare(b.name));

      expect(actual).toEqual(expected);
    },
  );
});
