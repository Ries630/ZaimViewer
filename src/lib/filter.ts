/**
 * フィルタの状態と、API のクエリへの変換。
 *
 * API は「指定なし = 制限なし」に徹しており（ADR-0008）、既定値は PWA 側が持つ。
 * その既定値と、画面の状態から条件を組み立てる規則をここに集める（ADR-0026）。
 *
 * 画面の状態（`FilterState`）と API の引数（`TransactionFilter`）を別の型に
 * しているのは、両者が 1 対 1 でないため。「未来を隠す」は API には無く、
 * `date_to` を今日に丸める操作として畳み込まれる。
 */

import type { TransactionFilter } from "../api/transactions";
import { MAX_AMOUNT, withinQueryByteLimit } from "../../worker/src/limits";
import { type DateRange, type PeriodPreset, clampToToday, rangeOfPreset } from "./period";

/** 明細の種別。 */
export type Mode = "payment" | "income" | "transfer";

/** 種別の一覧と表示名。UI の並び順もこれに従う。 */
export const MODES: { value: Mode; label: string }[] = [
  { value: "payment", label: "支出" },
  { value: "income", label: "収入" },
  { value: "transfer", label: "振替" },
];

/** 画面が持つ絞り込みの状態。 */
export interface FilterState {
  /** 期間プリセット。`custom` なら `dateFrom` / `dateTo` を直接使う。 */
  period: PeriodPreset;
  /** 開始日（`YYYY-MM-DD`）。`custom` のときだけ意味を持つ。 */
  dateFrom: string | null;
  /** 終了日（`YYYY-MM-DD`）。`custom` のときだけ意味を持つ。 */
  dateTo: string | null;
  /** 今日より後の明細を隠すか。 */
  hideFuture: boolean;
  /** 含める種別。 */
  modes: Mode[];
  /** 含めるカテゴリ ID。 */
  categoryIds: number[];
  /** 含めるジャンル ID。 */
  genreIds: number[];
  /** 含める口座 ID。 */
  accountIds: number[];
  /** 金額の下限。 */
  amountMin: number | null;
  /** 金額の上限。 */
  amountMax: number | null;
  /** キーワード。 */
  q: string;
  /** 除外する店舗名。 */
  excludePlaces: string[];
  /** 除外するジャンル ID。 */
  excludeGenreIds: number[];
}

/**
 * 初期状態。
 *
 * 既定は「振替を除外」と「未来を隠す」の 2 段で、実データでは
 * 全 4,370 件 → 3,879 → 3,839 になる（ADR-0026）。金額の下限は既定に置かない。
 * 情報を落とす条件なので、いくらで切るかは画面で指定してもらう。
 */
export const DEFAULT_FILTER: FilterState = {
  period: "all",
  dateFrom: null,
  dateTo: null,
  hideFuture: true,
  modes: ["payment", "income"],
  categoryIds: [],
  genreIds: [],
  accountIds: [],
  amountMin: null,
  amountMax: null,
  q: "",
  excludePlaces: [],
  excludeGenreIds: [],
};

/**
 * 入力欄の文字列を金額に変換する。
 *
 * 受け付けないものは `"invalid"` を返し、呼び出し側は状態を更新しない
 * （`null` にすると入力途中の値が勝手に消える）。上限を UI で守るのは、
 * 超えた値を送ると API が 400 を返すため。`<input type="number">` は
 * 桁数を制限しないので、ここで止めないと 17 桁で到達する。
 *
 * @param value 入力欄の値。
 * @returns 金額。空欄なら null、受け付けられない値なら `"invalid"`。
 */
export function parseAmount(value: string): number | null | "invalid" {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_AMOUNT) return "invalid";
  return parsed;
}

/**
 * 状態が示す期間を返す。
 *
 * プリセットなら計算し、`custom` なら利用者の入力をそのまま使う。
 * 「未来を隠す」はまだ畳み込まない（日付欄には利用者が選んだ期間を出したいので、
 * 表示用にもこの関数を使う）。
 *
 * @param state 絞り込みの状態。
 * @param today JST の今日（`YYYY-MM-DD`）。
 * @returns 期間。
 */
export function rangeOf(state: FilterState, today: string): DateRange {
  if (state.period === "custom") return { from: state.dateFrom, to: state.dateTo };
  return rangeOfPreset(state.period, today);
}

/**
 * キーワードを API に送れるか判定する。
 *
 * 空文字は「指定なし」、上限超過は 400 になるので、どちらも送らない。
 *
 * @param q キーワード。
 * @returns 送れるなら true。
 */
function sendableQuery(q: string): boolean {
  return q.trim().length > 0 && withinQueryByteLimit(q.trim());
}

/**
 * 画面の状態を API のクエリに変換する。
 *
 * 空配列・null・空文字はキーごと落とす。hono のクライアントは `undefined` の
 * キーをクエリ文字列に出さないので、そのまま「指定なし = 制限なし」になる。
 *
 * @param state 絞り込みの状態。
 * @param today JST の今日（`YYYY-MM-DD`）。
 * @returns API のクエリパラメータ。
 */
export function toTransactionFilter(state: FilterState, today: string): TransactionFilter {
  const range = rangeOf(state, today);
  // 「未来を隠す」は期間プリセットと直交させる。今月を選んでいても未来分は隠れる
  const dateTo = state.hideFuture ? clampToToday(range.to, today) : range.to;
  const trimmed = state.q.trim();

  return {
    date_from: range.from ?? undefined,
    date_to: dateTo ?? undefined,
    // 3 つとも選ばれていれば条件を課さない（指定なしと同じ結果になる）
    mode: state.modes.length === MODES.length ? undefined : state.modes,
    category_id: ids(state.categoryIds),
    genre_id: ids(state.genreIds),
    account_id: ids(state.accountIds),
    amount_min: state.amountMin?.toString(),
    amount_max: state.amountMax?.toString(),
    q: sendableQuery(state.q) ? trimmed : undefined,
    exclude_place: optional(state.excludePlaces),
    exclude_genre_id: ids(state.excludeGenreIds),
  };
}

/**
 * 空配列を `undefined` にする。
 *
 * @param values 選択された値。
 * @returns 1 つ以上あればそのまま、無ければ undefined。
 */
function optional(values: string[]): string[] | undefined {
  return values.length > 0 ? values : undefined;
}

/**
 * ID の配列をクエリ文字列の形にする。
 *
 * RPC のクエリは文字列しか受け取らない（URL に載る値なので当然だが、
 * 数値のまま渡すと型で弾かれる）。
 *
 * @param values ID の配列。
 * @returns 文字列の配列。空なら undefined。
 */
function ids(values: number[]): string[] | undefined {
  return optional(values.map(String));
}

/** マスタ ID から表示名を引く。名前が要るのはラベルの組み立てだけなので、関数だけ受け取る。 */
export interface NameLookup {
  /** カテゴリ名。 */
  category: (id: number) => string | undefined;
  /** ジャンル名。 */
  genre: (id: number) => string | undefined;
  /** 口座名。 */
  account: (id: number) => string | undefined;
}

/** ヘッダに出す「適用中」の 1 つ。 */
export interface FilterBadge {
  /** React の key と、外すボタンのラベルに使う識別子。 */
  key: string;
  /** 表示するラベル。 */
  label: string;
  /** このバッジを外した状態。 */
  next: FilterState;
}

/**
 * ID のリストをラベルにする。
 *
 * 1 つだけなら名前、複数なら件数。小さい画面でヘッダが折り返さないようにするため。
 *
 * @param prefix 「カテゴリ」などの見出し。
 * @param selected 選択された ID。
 * @param nameOf 名前を引く関数。
 * @returns ラベル。
 */
function idsLabel(
  prefix: string,
  selected: number[],
  nameOf: (id: number) => string | undefined,
): string {
  const only = selected.length === 1 ? nameOf(selected[0]!) : undefined;
  return only ? `${prefix}: ${only}` : `${prefix} ${selected.length} 件`;
}

/**
 * 金額を桁区切りの円表記にする。
 *
 * @param value 金額。
 * @returns 「1,000 円」のような文字列。
 */
function yen(value: number): string {
  return `${value.toLocaleString("ja-JP")} 円`;
}

/**
 * 金額の範囲をラベルにする。
 *
 * @param min 下限。
 * @param max 上限。
 * @returns ラベル。両端とも未指定なら null。
 */
function amountLabel(min: number | null, max: number | null): string | null {
  if (min !== null && max !== null) return `${yen(min)} 〜 ${yen(max)}`;
  if (min !== null) return `${yen(min)} 以上`;
  if (max !== null) return `${yen(max)} 以下`;
  return null;
}

/**
 * 適用中の条件をバッジの一覧にする。
 *
 * 何が効いているかがシートを開かなくても分かるようにするためのもの。
 * 各バッジは「自分を外した状態」を持つので、× のタップで即座に戻せる。
 *
 * @param state 絞り込みの状態。
 * @param today JST の今日（`YYYY-MM-DD`）。
 * @param names マスタ ID から名前を引く関数。
 * @returns バッジの一覧。何も効いていなければ空。
 */
export function activeBadges(state: FilterState, today: string, names: NameLookup): FilterBadge[] {
  const badges: FilterBadge[] = [];

  if (state.period !== "all") {
    const range = rangeOf(state, today);
    const preset = state.period === "custom" ? null : state.period;
    const label = preset
      ? (PRESET_LABELS[preset] ?? preset)
      : `${range.from ?? ""} 〜 ${range.to ?? ""}`;
    badges.push({
      key: "period",
      label,
      next: { ...state, period: "all", dateFrom: null, dateTo: null },
    });
  }

  if (state.hideFuture) {
    badges.push({ key: "hideFuture", label: "未来を隠す", next: { ...state, hideFuture: false } });
  }

  if (state.modes.length !== MODES.length) {
    const label = MODES.filter((mode) => state.modes.includes(mode.value))
      .map((mode) => mode.label)
      .join("・");
    badges.push({
      key: "modes",
      label: label || "種別なし",
      next: { ...state, modes: MODES.map((mode) => mode.value) },
    });
  }

  if (state.categoryIds.length > 0) {
    badges.push({
      key: "categories",
      label: idsLabel("カテゴリ", state.categoryIds, names.category),
      // カテゴリを外すとジャンルの選択肢も変わるので、ジャンルの選択ごと落とす
      next: { ...state, categoryIds: [], genreIds: [] },
    });
  }

  if (state.genreIds.length > 0) {
    badges.push({
      key: "genres",
      label: idsLabel("ジャンル", state.genreIds, names.genre),
      next: { ...state, genreIds: [] },
    });
  }

  if (state.accountIds.length > 0) {
    badges.push({
      key: "accounts",
      label: idsLabel("口座", state.accountIds, names.account),
      next: { ...state, accountIds: [] },
    });
  }

  const amount = amountLabel(state.amountMin, state.amountMax);
  if (amount) {
    badges.push({
      key: "amount",
      label: amount,
      next: { ...state, amountMin: null, amountMax: null },
    });
  }

  if (state.q.trim()) {
    badges.push({ key: "q", label: `「${state.q.trim()}」`, next: { ...state, q: "" } });
  }

  if (state.excludePlaces.length > 0) {
    const only = state.excludePlaces.length === 1 ? state.excludePlaces[0] : undefined;
    badges.push({
      key: "excludePlaces",
      label: only ? `${only} を除外` : `店舗 ${state.excludePlaces.length} 件を除外`,
      next: { ...state, excludePlaces: [] },
    });
  }

  if (state.excludeGenreIds.length > 0) {
    badges.push({
      key: "excludeGenres",
      label: `${idsLabel("ジャンル", state.excludeGenreIds, names.genre)}を除外`,
      next: { ...state, excludeGenreIds: [] },
    });
  }

  return badges;
}

/** バッジに出すプリセットの表示名。 */
const PRESET_LABELS: Partial<Record<PeriodPreset, string>> = {
  "this-month": "今月",
  "last-month": "先月",
  "last-3-months": "過去 3 か月",
  "this-year": "今年",
};
