/**
 * クライアント側の型検査のためだけに置く、Workers 固有グローバルの穴埋め。
 *
 * `api/client.ts` が `hc<AppType>` のために `worker/src/index.ts` を
 * 型として import する。すると Worker のソースがクライアント側のプログラムにも
 * 取り込まれ、そこに書かれた `D1Database` や `ExportedHandler` が解決できずに
 * 落ちる。これらは `worker-configuration.d.ts`（`wrangler types` の生成物）が
 * 宣言するグローバルで、Workers ランタイムの型一式を伴う。
 *
 * **その生成物をクライアントの `types` に足す手は取れない。** Workers の
 * ランタイム型は `fetch` や `Response` を DOM とは別の形で宣言するため、
 * DOM と同じプログラムに入れると衝突する。同じ理由で
 * `worker/tsconfig.scripts.json` も分けてある。
 *
 * ここで穴を埋めても Worker 側の型安全は落ちない。`worker/tsconfig.json` が
 * 本物の型で同じソースを検査しており、そちらが正。ここが見ているのは
 * 「クライアントから触るルートの形」だけでよい。
 *
 * `unknown` ではなく `any` にしてあるのは、Worker のソースが D1 のバインディングを
 * `drizzle()` や `syncAll()` に渡しており、`unknown` だと引数の型に代入できずに
 * 落ちるため。ここを厳密にしても得るものが無いので通り抜けさせる。
 */

/** ミラー DB のバインディング。実体は `worker/tsconfig.json` 側で検査される。 */
// oxlint-disable-next-line typescript/no-explicit-any -- 上記のとおり意図的
declare type D1Database = any;

/** Worker のエントリポイントの形。同上。 */
// oxlint-disable-next-line typescript/no-explicit-any -- 上記のとおり意図的
declare type ExportedHandler<Env = unknown> = any;
