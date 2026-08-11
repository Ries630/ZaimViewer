/**
 * 表示用の整形。
 *
 * すべて純関数で、DOM も React も要らない。「今」を引数で受け取るのは
 * テストのためで、既定値は持たせない（暗黙に `new Date()` を読むと
 * 結果が実行時刻に左右され、テストが書けなくなる）。
 *
 * `Intl` のフォーマッタはモジュール定数として使い回す。生成は安くなく、
 * 一覧は数千行を描くため。
 */

/** ミラーが古いと見なすまでの時間。 */
const STALE_MS = 36 * 60 * 60 * 1000;

/** 1 日のミリ秒。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 通貨ごとのフォーマッタ。実データは JPY が 4,369 件に対し USD が 1 件で、ほぼ JPY に当たる。 */
const amountFormatters = new Map<string, Intl.NumberFormat>();

/** 日付見出し。日付だけの文字列を扱うので UTC で解釈する（ローカル時刻に寄せると 1 日ずれる）。 */
const dateHeadingFormat = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
  timeZone: "UTC",
});

/** 同期時刻の絶対表記。API が返すのは UTC なので、JST への変換はここでやる。 */
const absoluteTimeFormat = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Tokyo",
});

/** 同期時刻の相対表記。`numeric: "auto"` で -1 日が「昨日」になる。 */
const relativeTimeFormat = new Intl.RelativeTimeFormat("ja", { numeric: "auto" });

/** 「今日」の判定用。ロケールに依存しないよう、組み立ては formatToParts でやる。 */
const tokyoDateFormat = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Asia/Tokyo",
});

/**
 * 通貨コードに対応するフォーマッタを返す。
 *
 * @param currency ISO 4217 の通貨コード。
 * @returns 通貨表示のフォーマッタ。
 */
function amountFormatter(currency: string): Intl.NumberFormat {
  const cached = amountFormatters.get(currency);
  if (cached) return cached;
  // currencyDisplay は既定の "symbol" のまま。ja-JP の JPY は CLDR 上
  // 全角の ￥ なので、"narrowSymbol" を指定しても結果は変わらない
  const created = new Intl.NumberFormat("ja-JP", { style: "currency", currency });
  amountFormatters.set(currency, created);
  return created;
}

/**
 * 金額を通貨付きで整形する。
 *
 * 負の金額（返金など）もそのまま符号付きで出す。
 *
 * @param amount 金額。
 * @param currencyCode 通貨コード。null なら JPY と見なす。
 * @returns 「¥2,375」のような文字列。
 * @throws {RangeError} 通貨コードが ISO 4217 として不正なとき。
 */
export function formatAmount(amount: number, currencyCode: string | null): string {
  return amountFormatter(currencyCode ?? "JPY").format(amount);
}

/**
 * 件数を桁区切りで整形する。
 *
 * @param count 件数。
 * @returns 「4,370」のような文字列。
 */
export function formatCount(count: number): string {
  return count.toLocaleString("ja-JP");
}

/**
 * 日付見出しを整形する。
 *
 * @param date `YYYY-MM-DD` 形式の日付。
 * @returns 「2026年8月8日(土)」のような文字列。
 */
export function formatDateHeading(date: string): string {
  return dateHeadingFormat.format(new Date(`${date}T00:00:00Z`));
}

/**
 * 同期時刻を JST の絶対表記に整形する。
 *
 * @param iso API が返す UTC の ISO 8601 文字列。
 * @returns 「2026年8月11日 15:40」のような文字列。
 */
export function formatAbsoluteTime(iso: string): string {
  return absoluteTimeFormat.format(new Date(iso));
}

/**
 * 同期時刻を相対表記に整形する。
 *
 * 同期は毎日 06:00 の 1 回なので、分単位の精度は要らない。
 * 「3 日前」のような表記が出ること自体が、同期が止まっているサインになる。
 *
 * @param iso API が返す UTC の ISO 8601 文字列。
 * @param now 現在時刻。
 * @returns 「3 時間前」「昨日」のような文字列。
 */
export function formatRelativeTime(iso: string, now: Date): string {
  const diffMs = new Date(iso).getTime() - now.getTime();
  const absMs = Math.abs(diffMs);

  if (absMs < 60_000) return "たった今";
  if (absMs < 60 * 60_000) return relativeTimeFormat.format(Math.round(diffMs / 60_000), "minute");
  if (absMs < DAY_MS) return relativeTimeFormat.format(Math.round(diffMs / (60 * 60_000)), "hour");
  if (absMs < 30 * DAY_MS) return relativeTimeFormat.format(Math.round(diffMs / DAY_MS), "day");
  return relativeTimeFormat.format(Math.round(diffMs / (30 * DAY_MS)), "month");
}

/**
 * ミラーが古くなっているか判定する。
 *
 * 同期は毎日 1 回なので、36 時間空いていれば 1 回分飛んでいる。
 *
 * @param iso API が返す UTC の ISO 8601 文字列。
 * @param now 現在時刻。
 * @returns 古ければ true。
 */
export function isStale(iso: string, now: Date): boolean {
  return now.getTime() - new Date(iso).getTime() > STALE_MS;
}

/**
 * JST における「今日」の日付を返す。
 *
 * 明細の日付は JST の暦日なので、UTC の日付と比べると 9 時間ぶんずれる。
 *
 * @param now 現在時刻。
 * @returns `YYYY-MM-DD` 形式の日付。
 */
export function todayInTokyo(now: Date): string {
  const parts = tokyoDateFormat.formatToParts(now);
  const valueOf = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${valueOf("year")}-${valueOf("month")}-${valueOf("day")}`;
}

/**
 * 明細の日付が未来かどうか。
 *
 * ミラーには繰り返し登録の家賃が 2029-12 まで入っており、既定では一覧の
 * 先頭がそれで埋まる。壊れたデータに見えないよう印を付けるために使う。
 *
 * @param date 明細の日付（`YYYY-MM-DD`）。
 * @param today JST の今日（`YYYY-MM-DD`）。
 * @returns 未来なら true。
 */
export function isFutureDate(date: string, today: string): boolean {
  // 桁が揃った ISO 形式なので辞書順の比較が日付の比較になる
  return date > today;
}
