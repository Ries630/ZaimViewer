/**
 * Worker とクライアントが共有する制限値。
 *
 * **48 バイト制限の正はこのファイル 1 か所。** Worker 側は 400 を返す判定に、
 * クライアント側は入力欄でそれより前に気付かせるために使う。
 *
 * 依存を持たないモジュールとして切り出してあるのが肝で、`index.ts` に置いたまま
 * 値として import するとクライアントのバンドルに Worker 本体が入る
 * （`src/api/client.ts` が `index.ts` を型としてしか読んでいないのはそのため）。
 */

/**
 * キーワードの最大バイト数。
 *
 * D1 は LIKE / GLOB のパターン長を 50 バイトに制限している
 * （標準の SQLite ビルドは 50,000 なので、ローカルのテストでは踏めない）。
 * 実際に渡すパターンは前後に `%` が付くので、キーワード自体は 48 バイトまで。
 * UTF-8 の日本語は 1 文字 3 バイトなので、日本語だけなら 16 文字が上限になる。
 */
export const MAX_QUERY_BYTES = 48;

/**
 * 金額として受け付ける上限。
 *
 * 上限を置かないと、`z.coerce.number().int()` が安全な整数（2^53-1 =
 * 9,007,199,254,740,991）を超えた時点で 400 を返す。`<input type="number">` は
 * 桁数を制限しないので、17 桁を入れれば到達する。
 *
 * 9 桁（約 10 億）にしてあるのは、本番のミラーで最大の明細が 50 万円未満
 * （10 万円以上が 179 件、50 万円以上は 0 件）だから。実用上の余裕を 2,000 倍
 * 取ったうえで、安全な整数の 900 万分の 1 に収まる。
 */
export const MAX_AMOUNT = 999_999_999;

/**
 * 文字列の UTF-8 バイト数を返す。
 *
 * @param value 対象の文字列。
 * @returns UTF-8 でのバイト数。
 */
export function queryByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * 文字列の UTF-8 バイト数が上限以内か判定する。
 *
 * @param value 判定する文字列。
 * @returns 上限以内なら true。
 */
export function withinQueryByteLimit(value: string): boolean {
  return queryByteLength(value) <= MAX_QUERY_BYTES;
}
