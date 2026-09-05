/** 編集 API と PWA が共有する入力・実行結果の契約。 */
import * as v from "valibot";
import { MAX_AMOUNT } from "./limits";

/** 初期版で一度に確認・実行できる明細数。実機測定後に再評価する。 */
export const MAX_EDIT_ITEMS = 50;
/** 計画を新規実行できる期間。結果照合には適用しない。 */
export const EDIT_PLAN_TTL_MS = 30 * 60 * 1000;
/** 外部更新間の最小待機時間。Zaim の保証値ではなく既存運用から引き継ぐ初期値。 */
export const EDIT_INTERVAL_MS = 300;
/** 編集欄の初期上限。既存の長文は変更しなければ送信しない。 */
export const MAX_EDIT_TEXT_LENGTH = 100;
/** 一要求で明細を検索する最大ページ数。超えた場合は未発見と区別して中断する。 */
export const MAX_EDIT_LOOKUP_PAGES = 10;
/** 外部 API の応答を待つ上限。更新時の期限超過は結果不明として扱う。 */
export const EDIT_REQUEST_TIMEOUT_MS = 15_000;

/** 編集対象の種別。 */
export const editModeSchema = v.picklist(["payment", "income", "transfer"]);
/** 編集対象の種別。 */
export type EditMode = v.InferOutput<typeof editModeSchema>;
/** 実在する暦日。 */
const dateSchema = v.pipe(
  v.string(),
  v.regex(/^\d{4}-\d{2}-\d{2}$/),
  v.check((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "実在する日付を指定してください"),
);
/** 金額の入力境界。 */
const amountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(MAX_AMOUNT));
/** 新しい選択先として受け付ける ID。 */
const idSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
/** 既存明細の未設定 ID も表現する。 */
const existingIdSchema = v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(0)));
/** 変更するテキスト。空文字は明示的な消去。 */
const textSchema = v.pipe(v.string(), v.maxLength(MAX_EDIT_TEXT_LENGTH));

/** 編集可能な欄だけを受け付け、未知のキーを拒否する。 */
export const editChangesSchema = v.pipe(
  v.strictObject({
    date: v.optional(dateSchema),
    amount: v.optional(amountSchema),
    category_id: v.optional(idSchema),
    genre_id: v.optional(idSchema),
    from_account_id: v.optional(idSchema),
    to_account_id: v.optional(idSchema),
    name: v.optional(textSchema),
    place: v.optional(textSchema),
    comment: v.optional(textSchema),
  }),
  v.check((value) => Object.keys(value).length > 0, "変更する項目を指定してください"),
);
/** 未指定の欄は保持する部分更新。 */
export type EditChanges = v.InferOutput<typeof editChangesSchema>;

/** 利用者が確認した明細の値。表示名は比較対象にしない。 */
export const editSnapshotSchema = v.strictObject({
  id: idSchema,
  mode: editModeSchema,
  date: dateSchema,
  amount: amountSchema,
  category_id: existingIdSchema,
  genre_id: existingIdSchema,
  from_account_id: existingIdSchema,
  to_account_id: existingIdSchema,
  name: v.nullable(v.string()),
  place: v.nullable(v.string()),
  comment: v.nullable(v.string()),
  currency_code: v.nullable(v.string()),
  receipt_id: existingIdSchema,
});
/** 利用者が確認した明細の値。 */
export type EditSnapshot = v.InferOutput<typeof editSnapshotSchema>;

/** ミラー行と Zaim 応答の両方から取得できる明細列。 */
export interface EditSource {
  id: number;
  mode: string;
  date: string;
  amount: number;
  category_id?: number | null;
  genre_id?: number | null;
  from_account_id?: number | null;
  to_account_id?: number | null;
  name?: string | null;
  place?: string | null;
  comment?: string | null;
  currency_code?: string | null;
  receipt_id?: number | null;
}

/**
 * 取得元による空欄の null/0/空文字の違いを正規化する。
 * @param source 明細の取得値。
 * @returns 比較と送信確認に使う明細。
 */
export function snapshotOf(source: EditSource): EditSnapshot {
  return v.parse(editSnapshotSchema, {
    id: source.id,
    mode: source.mode,
    date: source.date,
    amount: source.amount,
    category_id: source.category_id ?? 0,
    genre_id: source.genre_id ?? 0,
    from_account_id: source.from_account_id ?? 0,
    to_account_id: source.to_account_id ?? 0,
    name: source.name ?? "",
    place: source.place ?? "",
    comment: source.comment ?? "",
    currency_code: source.currency_code ?? "",
    receipt_id: source.receipt_id ?? 0,
  });
}

/**
 * 表示時と保存直前の明細が同じか比較する。
 * @param left 比較元。
 * @param right 比較先。
 * @returns 空欄表現を除いた一致。
 */
export function sameSnapshot(left: EditSource, right: EditSource): boolean {
  return JSON.stringify(snapshotOf(left)) === JSON.stringify(snapshotOf(right));
}

/** 実データで確認した編集能力。未確認項目は公開しない。 */
export interface EditCapabilities {
  enabled: boolean;
  modes: EditMode[];
  incomeName: boolean;
  transfer: boolean;
}

/** 一件の処理状態。 */
export const editItemStatusSchema = v.picklist([
  "pending",
  "sending",
  "succeeded",
  "failed",
  "unknown",
  "mirror_pending",
]);
/** 一件の処理結果。 */
export const editItemSchema = v.strictObject({
  before: editSnapshotSchema,
  status: editItemStatusSchema,
  message: v.optional(v.string()),
  after: v.optional(editSnapshotSchema),
});
/** 一件の処理結果。 */
export type EditItem = v.InferOutput<typeof editItemSchema>;
/** 対象と変更内容を固定した計画。 */
export const editPlanSchema = v.strictObject({
  id: v.pipe(v.string(), v.uuid()),
  created_at: v.string(),
  expires_at: v.string(),
  source: v.picklist(["single", "filter"]),
  changes: editChangesSchema,
  items: v.pipe(v.array(editItemSchema), v.minLength(1), v.maxLength(MAX_EDIT_ITEMS)),
});
/** 対象と変更内容を固定した計画。 */
export type EditPlan = v.InferOutput<typeof editPlanSchema>;

/** 編集の失敗を API と UI で区別する。 */
export class EditError extends Error {
  /**
   * @param code 機械判定用の理由。
   * @param message 利用者へ返す説明。
   * @param status HTTP ステータス。
   */
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 503 = 409,
  ) {
    super(message);
    this.name = "EditError";
  }
}

/**
 * 種別と検証済み能力から変更欄を検証する。
 * @param before 変更対象。
 * @param changes 指定された変更。
 * @param capabilities 公開する編集能力。
 * @param bulk 一括編集か。
 */
export function validateEditFields(
  before: EditSnapshot,
  changes: EditChanges,
  capabilities: EditCapabilities,
  bulk: boolean,
): void {
  if (!capabilities.enabled || !capabilities.modes.includes(before.mode)) {
    throw new EditError("edit_disabled", "この種別の編集はまだ利用できません", 503);
  }
  if (before.currency_code !== "JPY") {
    throw new EditError(
      "unsupported_currency",
      "円以外、または通貨を確認できない明細は編集できません",
      400,
    );
  }
  if (bulk && (changes.date !== undefined || changes.amount !== undefined)) {
    throw new EditError("bulk_field", "日付と金額は単体編集で変更してください", 400);
  }
  const forbidden =
    before.mode === "payment"
      ? ["to_account_id"]
      : before.mode === "income"
        ? ["from_account_id", "genre_id", "place"]
        : ["category_id", "genre_id", "name", "place"];
  if (forbidden.some((key) => key in changes)) {
    throw new EditError("unsupported_field", "この種別で変更できない項目が指定されています", 400);
  }
  if (
    changes.name !== undefined &&
    ((before.mode === "payment" && !before.receipt_id) ||
      (before.mode === "income" && !capabilities.incomeName))
  ) {
    throw new EditError("name_unavailable", "この明細の品名は編集できません", 400);
  }
  if (before.mode === "transfer" && !capabilities.transfer) {
    throw new EditError("transfer_unverified", "振替の編集は実機での確認待ちです", 503);
  }
}
