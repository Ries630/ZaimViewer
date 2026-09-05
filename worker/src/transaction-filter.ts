/** 一覧取得と一括編集で共有する検索条件。 */
import * as v from "valibot";
import { MAX_AMOUNT, MAX_QUERY_BYTES, withinQueryByteLimit } from "./limits";
import { editModeSchema, MAX_EDIT_FILTER_BINDINGS } from "./edit-contract";
import type { TransactionFilter } from "./queries";

/** 1 リクエストで返す明細の上限。無限スクロール 1 ページ分を想定。 */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
/** Drizzle が fetchTransactions の limit / offset を bind に変換する数。 */
const FETCH_PAGING_BINDINGS = 2;
/** q は 3 列それぞれにパターンと ESCAPE を渡すために消費する bind 数。 */
const QUERY_TERM_BINDINGS = 6;

/** 日付パラメータの書式。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 繰り返し指定されうるクエリパラメータを配列に正規化する。
 *
 * `?mode=payment&mode=income` は配列で届くが、1 個だけなら文字列で届く。
 * 呼び出し側で分岐したくないので、ここで必ず配列に揃える。
 *
 * @param item 各要素のスキーマ。
 * @returns 配列に正規化するスキーマ。
 */
function repeatable<T extends v.GenericSchema>(item: T) {
  // `v.optional` で包むのは、未指定のときに配列化を走らせないため。
  // 中で分岐すると `[undefined]` になり、要素の検証で落ちる
  return v.optional(
    v.pipe(
      v.unknown(),
      v.transform((value) => (Array.isArray(value) ? value : [value])),
      v.array(item),
    ),
  );
}

/**
 * クエリ文字列の整数。
 *
 * クエリは必ず文字列で届くので、数値に直してから整数か確かめる。valibot には
 * `z.coerce.number()` に当たる入口が無いぶん、変換を pipe に書き下す。
 *
 * **`v.integer()` ではなく `v.safeInteger()` を使う。** 前者は
 * `Number.isInteger` そのままで、`9007199254740993`（丸められて整数になる）も
 * `1e30` も通してしまう。zod の `.int()` は安全な整数の範囲で弾いていたので、
 * ここを合わせないと桁あふれした値が SQL に渡る。
 *
 * @returns 文字列を整数に直すスキーマ。
 */
const coercedInt = () => v.pipe(v.string(), v.transform(Number), v.number(), v.safeInteger());

/**
 * 明細一覧のクエリパラメータ。
 *
 * すべてのフィルタは未指定なら条件を課さない。「振替を除外」「今日以前だけ」
 * といった既定は API 側に持たせず、呼び出し側（PWA）が明示する。
 *
 * `limit` と `offset` の既定値が文字列なのは、`v.optional` の第 2 引数が
 * 変換前（= クエリ文字列）の型で渡す約束になっているため。
 */
export const transactionQuery = v.object({
  date_from: v.optional(v.pipe(v.string(), v.regex(DATE_PATTERN))),
  date_to: v.optional(v.pipe(v.string(), v.regex(DATE_PATTERN))),
  mode: repeatable(v.string()),
  category_id: repeatable(coercedInt()),
  genre_id: repeatable(coercedInt()),
  account_id: repeatable(coercedInt()),
  amount_min: v.optional(v.pipe(coercedInt(), v.minValue(0), v.maxValue(MAX_AMOUNT))),
  amount_max: v.optional(v.pipe(coercedInt(), v.minValue(0), v.maxValue(MAX_AMOUNT))),
  q: v.optional(
    v.pipe(
      v.string(),
      v.check(
        withinQueryByteLimit,
        `キーワードは UTF-8 で ${MAX_QUERY_BYTES} バイト以内（D1 の LIKE パターン長制限）`,
      ),
    ),
  ),
  exclude_place: repeatable(v.string()),
  exclude_genre_id: repeatable(coercedInt()),
  limit: v.optional(
    v.pipe(coercedInt(), v.minValue(1), v.maxValue(MAX_LIMIT)),
    String(DEFAULT_LIMIT),
  ),
  offset: v.optional(v.pipe(coercedInt(), v.minValue(0)), "0"),
});

/** ページングを受け付けない一括編集用の検索条件。 */
const transactionFilterEntries = v.omit(transactionQuery, ["limit", "offset"]).entries;
export const transactionFilterSchema = v.strictObject(transactionFilterEntries);

/** 編集 API では種別を固定し、D1 の bind 数を実行前に制限する検索条件。 */
export const editFilterSchema = v.pipe(
  v.strictObject({
    ...transactionFilterEntries,
    mode: repeatable(editModeSchema),
  }),
  v.check((filter) => {
    // account_id は出金元・入金先の両方へ展開し、q は 3 候補それぞれに
    // パターンと ESCAPE の値を渡すため、1 要素あたり複数 bind を消費する。
    const bindCount =
      FETCH_PAGING_BINDINGS +
      (filter.date_from === undefined ? 0 : 1) +
      (filter.date_to === undefined ? 0 : 1) +
      (filter.mode?.length ?? 0) +
      (filter.category_id?.length ?? 0) +
      (filter.genre_id?.length ?? 0) +
      (filter.account_id?.length ?? 0) * 2 +
      (filter.amount_min === undefined ? 0 : 1) +
      (filter.amount_max === undefined ? 0 : 1) +
      (filter.q ? QUERY_TERM_BINDINGS : 0) +
      (filter.exclude_place?.length ?? 0) +
      (filter.exclude_genre_id?.length ?? 0);
    return bindCount <= MAX_EDIT_FILTER_BINDINGS;
  }, `検索条件が複雑すぎます（${MAX_EDIT_FILTER_BINDINGS} bind以内で指定してください）`),
);
/**
 * API の指定を SQL 組み立て用の条件へ変換する。
 * @param params 検証済みの検索条件。
 * @returns DB の絞り込み条件。
 */
export function toDatabaseFilter(
  params: v.InferOutput<typeof transactionFilterSchema>,
): TransactionFilter {
  return {
    dateFrom: params.date_from,
    dateTo: params.date_to,
    modes: params.mode,
    categoryIds: params.category_id,
    genreIds: params.genre_id,
    accountIds: params.account_id,
    amountMin: params.amount_min,
    amountMax: params.amount_max,
    q: params.q,
    excludePlaces: params.exclude_place,
    excludeGenreIds: params.exclude_genre_id,
  };
}
