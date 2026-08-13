/**
 * フィルタ状態の永続化。
 *
 * localStorage に保存して、リロードやホーム画面からの再起動で前回の絞り込みを
 * 取り戻す（ADR-0026）。URL には同期しない。
 *
 * **復元は項目ごとに検証し、読めない項目だけ既定値に倒す。** 保存形式は
 * これから増える見込みで、丸ごと捨てる作り方だと項目を 1 つ足すたびに
 * 利用者の設定が消える。zod を使わないのは、この 1 か所のためにクライアントの
 * バンドルへ載せる価値が無いため。
 */

import { MAX_AMOUNT } from "../../worker/src/limits";
import { DEFAULT_FILTER, type FilterState, MODES, type Mode } from "./filter";
import type { PeriodPreset } from "./period";

/** localStorage のキー。 */
export const FILTER_STORAGE_KEY = "zaimviewer.filter.v1";

/** 受け付ける期間プリセット。 */
const PERIODS: PeriodPreset[] = [
  "all",
  "this-month",
  "last-month",
  "last-3-months",
  "this-year",
  "custom",
];

/** 日付として受け付ける書式。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 値がオブジェクトか判定する。
 *
 * @param value 判定する値。
 * @returns プレーンなオブジェクトなら true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 真偽値を取り出す。
 *
 * @param value 保存されていた値。
 * @param fallback 読めなかったときの既定値。
 * @returns 真偽値。
 */
function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * 文字列を取り出す。
 *
 * @param value 保存されていた値。
 * @param fallback 読めなかったときの既定値。
 * @returns 文字列。
 */
function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * 日付を取り出す。書式が合わなければ null。
 *
 * @param value 保存されていた値。
 * @returns `YYYY-MM-DD` の文字列、または null。
 */
function asDate(value: unknown): string | null {
  return typeof value === "string" && DATE_PATTERN.test(value) ? value : null;
}

/**
 * 金額を取り出す。
 *
 * 上限を超えた値は落とす。API が 400 を返す値が保存に残っていると、
 * 起動しただけで一覧が出ない状態になる。
 *
 * @param value 保存されていた値。
 * @returns 金額、または null。
 */
function asAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 0 && value <= MAX_AMOUNT ? value : null;
}

/**
 * 整数の配列を取り出す。
 *
 * @param value 保存されていた値。
 * @returns 整数だけを残した配列。配列でなければ空。
 */
function asIntArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === "number" && Number.isInteger(item));
}

/**
 * 文字列の配列を取り出す。
 *
 * @param value 保存されていた値。
 * @returns 空でない文字列だけを残した配列。配列でなければ空。
 */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/**
 * 種別の配列を取り出す。
 *
 * 空になったら既定に倒す。API では「指定なし = 制限なし」なので、
 * 種別が 0 個の状態を送ると意図と逆に全件が出る。
 *
 * @param value 保存されていた値。
 * @returns 種別の配列。
 */
function asModes(value: unknown): Mode[] {
  const known = MODES.map((mode) => mode.value);
  const modes = Array.isArray(value)
    ? known.filter((mode) => (value as unknown[]).includes(mode))
    : [];
  return modes.length > 0 ? modes : DEFAULT_FILTER.modes;
}

/**
 * 保存されていた JSON をフィルタ状態に戻す。
 *
 * @param raw localStorage から読んだ文字列。未保存なら null。
 * @returns 復元した状態。読めない項目は既定値になる。
 */
export function parseStoredFilter(raw: string | null): FilterState {
  if (raw === null) return DEFAULT_FILTER;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_FILTER;
  }
  if (!isRecord(parsed)) return DEFAULT_FILTER;

  const period = PERIODS.find((candidate) => candidate === parsed.period) ?? DEFAULT_FILTER.period;

  return {
    period,
    dateFrom: asDate(parsed.dateFrom),
    dateTo: asDate(parsed.dateTo),
    hideFuture: asBoolean(parsed.hideFuture, DEFAULT_FILTER.hideFuture),
    modes: asModes(parsed.modes),
    categoryIds: asIntArray(parsed.categoryIds),
    genreIds: asIntArray(parsed.genreIds),
    accountIds: asIntArray(parsed.accountIds),
    amountMin: asAmount(parsed.amountMin),
    amountMax: asAmount(parsed.amountMax),
    q: asString(parsed.q, DEFAULT_FILTER.q),
    excludePlaces: asStringArray(parsed.excludePlaces),
    excludeGenreIds: asIntArray(parsed.excludeGenreIds),
  };
}
