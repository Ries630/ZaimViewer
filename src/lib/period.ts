/**
 * 期間の組み立て。
 *
 * **日付演算に Temporal を使うのはこのモジュールだけ**（ADR-0025）。表示の整形は
 * `format.ts` の `Intl` に残してあり、`Temporal` 型は境界の外へ出さない。
 * 入出力はどちらも `YYYY-MM-DD` の文字列。
 *
 * ネイティブ実装は使わず polyfill を明示 import する。主な入口の iOS Safari が
 * 非対応で polyfill が本番の実行経路になるため、対応済みの環境だけ別実装が
 * 走る状態を作らない。
 */

import { Temporal } from "temporal-polyfill";

/** 期間プリセットの識別子。`custom` は利用者が直接入れた日付を使う。 */
export type PeriodPreset =
  | "all"
  | "this-month"
  | "last-month"
  | "last-3-months"
  | "this-year"
  | "custom";

/** 期間。null は「その側に制限を課さない」。 */
export interface DateRange {
  /** 開始日（`YYYY-MM-DD`）。 */
  from: string | null;
  /** 終了日（`YYYY-MM-DD`）。 */
  to: string | null;
}

/** プリセットの選択肢。`custom` は利用者が日付を触ったときに入るので、ボタンには出さない。 */
export const PERIOD_PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "this-month", label: "今月" },
  { value: "last-month", label: "先月" },
  { value: "last-3-months", label: "3 か月" },
  { value: "this-year", label: "今年" },
];

/**
 * プリセットに対応する期間を返す。
 *
 * 暦の区切り（今月・先月・今年）は月末・年末までを返し、今日で切らない。
 * 「未来を隠す」は独立したフラグとして `filter.ts` が畳み込むので、
 * ここで両方の都合を混ぜない。
 *
 * @param preset プリセットの識別子。
 * @param today JST の今日（`YYYY-MM-DD`）。
 * @returns 期間。`all` と `custom` は両端とも null。
 */
export function rangeOfPreset(preset: PeriodPreset, today: string): DateRange {
  const date = Temporal.PlainDate.from(today);

  switch (preset) {
    // custom は利用者が入れた日付をそのまま使うので、ここでは何も決めない
    case "all":
    case "custom":
      return { from: null, to: null };

    case "this-month":
      return { from: startOfMonth(date), to: endOfMonth(date) };

    case "last-month": {
      const previous = date.with({ day: 1 }).subtract({ months: 1 });
      return { from: startOfMonth(previous), to: endOfMonth(previous) };
    }

    case "last-3-months":
      // 暦月ではなく相対期間なので 3 か月前の同日から。ここが Temporal を
      // 入れた理由で、月末は既定の constrain で丸まる（5/31 の 3 か月前は 2/28）。
      // `new Date(y, m - 1, d)` は繰り上がって 3/3 になる
      return { from: date.subtract({ months: 3 }).toString(), to: today };

    case "this-year":
      return {
        from: date.with({ month: 1, day: 1 }).toString(),
        to: date.with({ month: 12, day: 31 }).toString(),
      };

    default: {
      // 到達しない。プリセットを増やしたときに、ここが型エラーになって気付ける
      const unhandled: never = preset;
      throw new Error(`未知の期間プリセット: ${String(unhandled)}`);
    }
  }
}

/**
 * その月の 1 日を返す。
 *
 * @param date 基準の日付。
 * @returns `YYYY-MM-DD` 形式の月初。
 */
function startOfMonth(date: Temporal.PlainDate): string {
  return date.with({ day: 1 }).toString();
}

/**
 * その月の末日を返す。
 *
 * @param date 基準の日付。
 * @returns `YYYY-MM-DD` 形式の月末。
 */
function endOfMonth(date: Temporal.PlainDate): string {
  return date.with({ day: date.daysInMonth }).toString();
}

/**
 * 日付を今日以前に丸める。
 *
 * 「未来を隠す」の実装。ミラーには繰り返し登録の家賃が 2029-12 まで入っており、
 * 何も指定しないと一覧の先頭がそれで埋まる。
 *
 * 桁の揃った ISO 形式なので辞書順の比較が日付の比較になり、ここに演算は要らない。
 *
 * @param date 終了日（`YYYY-MM-DD`）。未指定なら null。
 * @param today JST の今日（`YYYY-MM-DD`）。
 * @returns 今日以前に丸めた終了日。
 */
export function clampToToday(date: string | null, today: string): string {
  return date !== null && date < today ? date : today;
}
