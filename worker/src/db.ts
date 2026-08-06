/**
 * ミラー DB へのアクセス境界。
 *
 * クエリ層はこのインターフェースにだけ依存し、D1 の型を直接参照しない。
 * 配置先（Workers + D1 / 手元の Bun + SQLite）をあとから選べるようにするため。
 * D1Database はこの形を構造的に満たすので、Workers 上では実装を挟まずそのまま渡せる。
 */

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

/** ミラー DB。D1Database の部分集合。 */
export interface Database {
  /** SQL を準備する。 */
  prepare(sql: string): PreparedStatement;
  /** 複数のステートメントを単一トランザクションとして実行する。 */
  batch(statements: PreparedStatement[]): Promise<unknown[]>;
}
