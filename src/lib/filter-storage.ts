/**
 * フィルタ状態の永続化。
 *
 * localStorage に保存して、リロードやホーム画面からの再起動で前回の絞り込みを
 * 取り戻す（ADR-0026）。URL には同期しない。
 *
 * **復元は項目ごとに検証し、読めない項目だけ既定値に倒す。** 保存形式は
 * これから増える見込みで、丸ごと捨てる作り方だと項目を 1 つ足すたびに
 * 利用者の設定が消える。項目ごとの `v.fallback` がその「倒す」を担う。
 *
 * 検証は valibot で書く（[ADR-0034](../../docs/adr/0034-valibot-for-validation.md)）。
 */

import * as v from "valibot";

import { MAX_AMOUNT } from "../../worker/src/limits";
import { DEFAULT_FILTER, type FilterState, MODES, type Mode } from "./filter";

/** localStorage のキー。 */
export const FILTER_STORAGE_KEY = "zaimviewer.filter.v1";

/** 受け付ける期間プリセット。 */
const PERIODS = [
  "all",
  "this-month",
  "last-month",
  "last-3-months",
  "this-year",
  "custom",
] as const;

/** 日付として受け付ける書式。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 配列の中身を 1 件ずつ検証し、通らなかったものだけ落とす。
 *
 * 配列ごと捨てないのは、異物 1 つで選んだカテゴリが全部消えるのを避けるため。
 *
 * **`v.fallback` はここには置かない。** valibot の fallback は効いた時点で
 * pipe を打ち切るので、中に挟むと後段の transform が走らなくなる。
 * 「配列でなければ空」は呼び出し側でフィールド全体を包んで表す。
 *
 * @param item 中身の検証に使うスキーマ。
 * @returns 通った要素だけを残すスキーマ。
 */
function sieve<T>(item: v.GenericSchema<unknown, T>) {
  return v.pipe(
    v.array(v.unknown()),
    v.transform((items) =>
      items.flatMap((candidate) => {
        const result = v.safeParse(item, candidate);
        return result.success ? [result.output] : [];
      }),
    ),
  );
}

/**
 * 整数の配列。配列でなければ空に倒す。
 *
 * @returns カテゴリ ID などの配列を読むスキーマ。
 */
const intArray = () => v.fallback(sieve(v.pipe(v.number(), v.safeInteger())), []);

/**
 * 金額。
 *
 * 上限を超えた値は落とす。API が 400 を返す値が保存に残っていると、
 * 起動しただけで一覧が出ない状態になる。
 */
const amount = v.fallback(
  v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(MAX_AMOUNT))),
  null,
);

/** 日付。書式が合わなければ null。 */
const date = v.fallback(v.nullable(v.pipe(v.string(), v.regex(DATE_PATTERN))), null);

/**
 * 種別。
 *
 * 空になったら既定に倒す。API では「指定なし = 制限なし」なので、種別が
 * 0 個の状態を送ると意図と逆に全件が出る。並びは保存された順ではなく
 * `MODES` の表示順に揃える。
 */
const modes = v.fallback(
  v.pipe(
    sieve<Mode>(v.picklist(MODES.map((mode) => mode.value))),
    v.transform((saved) => {
      const ordered = MODES.map((mode) => mode.value).filter((mode) => saved.includes(mode));
      return ordered.length > 0 ? ordered : DEFAULT_FILTER.modes;
    }),
  ),
  DEFAULT_FILTER.modes,
);

/**
 * 保存されているフィルタ状態。
 *
 * 項目ごとに `v.fallback` を持たせてあるので、この object が失敗するのは
 * オブジェクトでない値を渡されたときだけになる。知らないキーは落とす。
 */
const StoredFilter = v.object({
  period: v.fallback(v.picklist(PERIODS), DEFAULT_FILTER.period),
  dateFrom: date,
  dateTo: date,
  hideFuture: v.fallback(v.boolean(), DEFAULT_FILTER.hideFuture),
  modes,
  categoryIds: intArray(),
  genreIds: intArray(),
  accountIds: intArray(),
  amountMin: amount,
  amountMax: amount,
  q: v.fallback(v.string(), DEFAULT_FILTER.q),
  excludePlaces: v.fallback(sieve(v.pipe(v.string(), v.minLength(1))), []),
  excludeGenreIds: intArray(),
});

/**
 * 保存されていた JSON をフィルタ状態に戻す。
 *
 * @param raw localStorage から読んだ文字列。未保存なら null。
 * @returns 復元した状態。読めない項目は既定値になる。
 */
export function parseStoredFilter(raw: string | null): FilterState {
  if (raw === null) return DEFAULT_FILTER;

  try {
    const result = v.safeParse(StoredFilter, JSON.parse(raw));
    return result.success ? result.output : DEFAULT_FILTER;
  } catch {
    // JSON として壊れている
    return DEFAULT_FILTER;
  }
}
