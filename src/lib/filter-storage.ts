/**
 * フィルタ状態の永続化。
 *
 * localStorage に保存して、リロードやホーム画面からの再起動で前回の絞り込みを
 * 取り戻す（ADR-0026）。URL には同期しない。
 *
 * **復元は項目ごとに検証し、読めない項目だけ既定値に倒す。** 保存形式は
 * これから増える見込みで、丸ごと捨てる作り方だと項目を 1 つ足すたびに
 * 利用者の設定が消える。項目ごとの `z.catch` がその「倒す」を担う。
 *
 * 検証は `zod/mini` で書く。手書きの `typeof` ガードから移した理由と、
 * 通常の `zod` ではなく mini を選んだ測定値は
 * [ADR-0033](../../docs/adr/0033-zod-mini-for-client-parsing.md) にある。
 */

import * as z from "zod/mini";

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
 * @param item 中身の検証に使うスキーマ。
 * @returns 通った要素だけを残すスキーマ。配列でなければ空になる。
 */
function sieve<T>(item: z.ZodMiniType<T>) {
  return z.pipe(
    z.catch(z.array(z.unknown()), []),
    z.transform((items: unknown[]) =>
      items.flatMap((candidate) => {
        const result = item.safeParse(candidate);
        return result.success ? [result.data] : [];
      }),
    ),
  );
}

/**
 * 金額。
 *
 * 上限を超えた値は落とす。API が 400 を返す値が保存に残っていると、
 * 起動しただけで一覧が出ない状態になる。
 */
const amount = z.catch(z.nullable(z.int().check(z.minimum(0), z.maximum(MAX_AMOUNT))), null);

/** 日付。書式が合わなければ null。 */
const date = z.catch(z.nullable(z.string().check(z.regex(DATE_PATTERN))), null);

/**
 * 種別。
 *
 * 空になったら既定に倒す。API では「指定なし = 制限なし」なので、種別が
 * 0 個の状態を送ると意図と逆に全件が出る。並びは保存された順ではなく
 * `MODES` の表示順に揃える。
 */
const modes = z.pipe(
  sieve<Mode>(z.enum(MODES.map((mode) => mode.value))),
  z.transform((saved: Mode[]) => {
    const ordered = MODES.map((mode) => mode.value).filter((mode) => saved.includes(mode));
    return ordered.length > 0 ? ordered : DEFAULT_FILTER.modes;
  }),
);

/**
 * 保存されているフィルタ状態。
 *
 * 項目ごとに `z.catch` を持たせてあるので、この object が失敗するのは
 * オブジェクトでない値を渡されたときだけになる。知らないキーは落とす。
 */
const StoredFilter = z.object({
  period: z.catch(z.enum(PERIODS), DEFAULT_FILTER.period),
  dateFrom: date,
  dateTo: date,
  hideFuture: z.catch(z.boolean(), DEFAULT_FILTER.hideFuture),
  modes,
  categoryIds: sieve(z.int()),
  genreIds: sieve(z.int()),
  accountIds: sieve(z.int()),
  amountMin: amount,
  amountMax: amount,
  q: z.catch(z.string(), DEFAULT_FILTER.q),
  excludePlaces: sieve(z.string().check(z.minLength(1))),
  excludeGenreIds: sieve(z.int()),
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
    const result = StoredFilter.safeParse(JSON.parse(raw));
    return result.success ? result.data : DEFAULT_FILTER;
  } catch {
    // JSON として壊れている
    return DEFAULT_FILTER;
  }
}
