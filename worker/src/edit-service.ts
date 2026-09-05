/** 編集計画の保存、Zaim 更新、結果照合を行う保存エンジン。 */

import * as v from "valibot";

import type { Database } from "./db";
import {
  acquireMutation,
  hasUnresolvedEditPlans,
  insertEditPlan,
  readEditPlan,
  releaseMutation,
  saveEditPlan,
} from "./edit-store";
import {
  EDIT_INTERVAL_MS,
  EDIT_PLAN_TTL_MS,
  MAX_EDIT_ITEMS,
  type EditCapabilities,
  type EditChanges,
  type EditItem,
  type EditMode,
  type EditPlan,
  type EditSnapshot,
  EditError,
  editChangesSchema,
  editItemStatusSchema,
  editSnapshotSchema,
  editPlanSchema,
  sameSnapshot,
  snapshotOf,
  validateEditFields,
} from "./edit-contract";
import { replaceMirrorMoney } from "./mirror-write";
import type { ZaimMoney } from "./zaim";

/** Zaim 更新と明細再取得だけを担当する外部境界。 */
export interface EditClient {
  /** 指定日の明細を再取得する。 */
  moneyById(mode: EditMode, id: number, date: string): Promise<ZaimMoney | undefined>;
  /** amount を必ず含めた部分更新を行う。 */
  updateMoney(mode: EditMode, id: number, changes: EditChanges & { amount: number }): Promise<void>;
}

/** D1 に保存する編集項目。raw は公開契約から除外する内部情報。 */
const storedEditItemSchema = v.object({
  before: editSnapshotSchema,
  status: editItemStatusSchema,
  message: v.optional(v.string()),
  after: v.optional(editSnapshotSchema),
  beforeRaw: v.optional(v.string()),
  confirmedRaw: v.optional(v.string()),
});

/** D1 に保存する編集計画。 */
const storedEditPlanSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
  created_at: v.string(),
  expires_at: v.string(),
  source: v.picklist(["single", "filter"]),
  changes: editChangesSchema,
  items: v.pipe(v.array(storedEditItemSchema), v.minLength(1), v.maxLength(MAX_EDIT_ITEMS)),
});

type StoredEditItem = v.InferOutput<typeof storedEditItemSchema>;
type StoredEditPlan = v.InferOutput<typeof storedEditPlanSchema>;

/** SQL から得た明細行。 */
interface MirrorRow {
  id: number;
  mode: string;
  date: string;
  amount: number;
  category_id: number | null;
  genre_id: number | null;
  from_account_id: number | null;
  to_account_id: number | null;
  name: string | null;
  place: string | null;
  comment: string | null;
  currency_code: string | null;
  receipt_id: number | null;
  raw: string | null;
}

/** 変更キーと API の raw キーは同名なので、amount だけを必ず比較対象から外す。 */
const RAW_MUTABLE_KEYS = new Set<string>(["amount"]);

/** 失敗時に外部 API の生本文を漏らさない固定メッセージ。 */
const UNKNOWN_MESSAGE = "Zaimへの反映結果を確認できません。再送せず照合してください";
const MIRROR_MESSAGE = "Zaimへの反映は確認できましたが、ミラーへの反映を完了できませんでした";

/** 外部更新間隔を共有ゲート保持中に待つ。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 外部・D1 のエラーを利用者向けの安全な文へ変換する。 */
function safeExternalMessage(): string {
  return UNKNOWN_MESSAGE;
}

/** 値をキー順に並べた JSON へ変換し、API のキー順差を除いて比較する。 */
function canonicalJson(value: Record<string, unknown>): string {
  const ordered = Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, value[key]]),
  );
  return JSON.stringify(ordered);
}

/** raw の保存値をオブジェクトへ変換する。読み取れない値は照合不能とする。 */
function parseRaw(raw: string | undefined | null): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null || raw === "" || raw === "{}") return undefined;
  try {
    const result = v.safeParse(v.record(v.string(), v.unknown()), JSON.parse(raw));
    return result.success && Object.keys(result.output).length > 0 ? result.output : undefined;
  } catch {
    return undefined;
  }
}

/** 指定された変更欄を raw の比較から除く。 */
function removeMutableKeys(value: Record<string, unknown>, changes: EditChanges): string {
  const copy = { ...value };
  for (const key of Object.keys(changes)) delete copy[key];
  for (const key of RAW_MUTABLE_KEYS) delete copy[key];
  return canonicalJson(copy);
}

/** 更新前後で、利用者が変更していない raw の値が変化していないか調べる。 */
function rawUnchanged(
  beforeRaw: string | undefined,
  after: ZaimMoney,
  changes: EditChanges,
): boolean {
  const before = parseRaw(beforeRaw);
  const afterRecord = parseRaw(JSON.stringify(after));
  if (before === undefined || afterRecord === undefined) return false;
  return removeMutableKeys(before, changes) === removeMutableKeys(afterRecord, changes);
}

/** ミラー行を編集契約の入力へ変換する。 */
function sourceFromMirror(row: MirrorRow): EditSnapshot {
  return snapshotOf({
    id: row.id,
    mode: row.mode,
    date: row.date,
    amount: row.amount,
    category_id: row.category_id,
    genre_id: row.genre_id,
    from_account_id: row.from_account_id,
    to_account_id: row.to_account_id,
    name: row.name ?? "",
    place: row.place ?? "",
    comment: row.comment ?? "",
    currency_code: row.currency_code ?? "",
    receipt_id: row.receipt_id,
  });
}

/** 変更値を比較用に正規化する。空欄の null と空文字を同じ値として扱う。 */
type ComparableValue = string | number | null | undefined;
function normalizedChangeValue(key: string, value: ComparableValue): ComparableValue {
  if (value === undefined) return undefined;
  if (["name", "place", "comment"].includes(key) && (value === null || value === "")) return "";
  if (["category_id", "genre_id", "from_account_id", "to_account_id"].includes(key)) {
    return value === null || value === 0 ? 0 : value;
  }
  return value;
}

/** 変更が少なくとも一つの明細で実際に値を変えるか調べる。 */
function hasEffectiveChange(before: EditSnapshot, changes: EditChanges): boolean {
  return Object.entries(changes).some(([key, value]) => {
    const current = snapshotValue(before, key);
    return normalizedChangeValue(key, value) !== normalizedChangeValue(key, current);
  });
}

/** 動的な変更キーを編集契約の既知の値へ対応付ける。 */
function snapshotValue(before: EditSnapshot, key: string): ComparableValue {
  switch (key) {
    case "date":
      return before.date;
    case "amount":
      return before.amount;
    case "category_id":
      return before.category_id;
    case "genre_id":
      return before.genre_id;
    case "from_account_id":
      return before.from_account_id;
    case "to_account_id":
      return before.to_account_id;
    case "name":
      return before.name;
    case "place":
      return before.place;
    case "comment":
      return before.comment;
    default:
      return undefined;
  }
}

/** 明細 ID を一回の D1 クエリで取得する。 */
async function readMirrorRows(
  db: Database,
  ids: readonly number[],
): Promise<Map<number, MirrorRow>> {
  const placeholders = ids.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT id, mode, date, amount, category_id, genre_id, from_account_id, to_account_id,
              name, place, comment, currency_code, receipt_id, raw
       FROM transactions WHERE id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<MirrorRow>();
  return new Map(results.map((row) => [row.id, row]));
}

/** 新しい選択先のマスタと親カテゴリを D1 で再検証する。 */
async function validateMasters(
  db: Database,
  items: readonly EditSnapshot[],
  changes: EditChanges,
): Promise<void> {
  const categoriesToRead = new Set<number>();
  const genresToRead = new Set<number>();
  const accountsToRead = new Set<number>();
  const changed = new Set(Object.keys(changes));

  for (const item of items) {
    const category = valueAsId(item.category_id);
    const genre = valueAsId(item.genre_id);
    if (category !== undefined) categoriesToRead.add(category);
    if (genre !== undefined) genresToRead.add(genre);
    if (changed.has("category_id")) {
      const selected = valueAsId(changes.category_id);
      if (selected !== undefined) categoriesToRead.add(selected);
    }
    if (changed.has("genre_id")) {
      const selected = valueAsId(changes.genre_id);
      if (selected !== undefined) genresToRead.add(selected);
    }
    if (changed.has("from_account_id")) {
      const selected = valueAsId(changes.from_account_id);
      if (selected !== undefined) accountsToRead.add(selected);
    }
    if (changed.has("to_account_id")) {
      const selected = valueAsId(changes.to_account_id);
      if (selected !== undefined) accountsToRead.add(selected);
    }
  }

  const readRows = async <T>(table: string, ids: Set<number>): Promise<T[]> => {
    if (ids.size === 0) return [];
    const placeholders = [...ids].map(() => "?").join(", ");
    const { results } = await db
      .prepare(`SELECT * FROM ${table} WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<T>();
    return results;
  };
  const [categoryRows, genreRows, accountRows] = await Promise.all([
    readRows<{ id: number; mode: string | null; active: number | null }>(
      "categories",
      categoriesToRead,
    ),
    readRows<{ id: number; category_id: number | null; active: number | null }>(
      "genres",
      genresToRead,
    ),
    readRows<{ id: number; active: number | null }>("accounts", accountsToRead),
  ]);
  const categories = new Map(categoryRows.map((row) => [row.id, row]));
  const genres = new Map(genreRows.map((row) => [row.id, row]));
  const accounts = new Map(accountRows.map((row) => [row.id, row]));

  for (const item of items) {
    const categoryId = valueAsId(changes.category_id) ?? valueAsId(item.category_id);
    const genreId = valueAsId(changes.genre_id) ?? valueAsId(item.genre_id);
    if (changed.has("category_id") && valueAsId(changes.category_id) !== undefined) {
      const row = categories.get(valueAsId(changes.category_id)!);
      if (row === undefined || row.active !== 1 || row.mode !== item.mode) {
        throw new EditError("invalid_category", "有効な種別のカテゴリを指定してください", 400);
      }
    }
    if (changed.has("genre_id") && valueAsId(changes.genre_id) !== undefined) {
      const row = genres.get(valueAsId(changes.genre_id)!);
      if (row === undefined || row.active !== 1 || row.category_id !== categoryId) {
        throw new EditError(
          "invalid_genre",
          "カテゴリに属する有効なジャンルを指定してください",
          400,
        );
      }
    } else if (item.mode === "payment" && changed.has("category_id") && genreId !== undefined) {
      const row = genres.get(genreId);
      if (row !== undefined && row.category_id !== categoryId) {
        throw new EditError(
          "invalid_genre",
          "変更先カテゴリと既存ジャンルの組み合わせが不正です",
          400,
        );
      }
    }

    for (const key of ["from_account_id", "to_account_id"] as const) {
      if (!changed.has(key) || valueAsId(changes[key]) === undefined) continue;
      const row = accounts.get(valueAsId(changes[key])!);
      if (row === undefined || row.active !== 1) {
        throw new EditError("invalid_account", "有効な口座を指定してください", 400);
      }
    }
  }
}

/** ID を空欄表現を除いて正規化する。 */
type IdValue = number | null | undefined;
function valueAsId(value: IdValue): number | undefined {
  if (value === undefined || value === null || value === 0) return undefined;
  return value;
}

/** 外部値を保存用の expected snapshot へ適用する。 */
function expectedSnapshot(
  before: EditSnapshot,
  changes: EditChanges,
  amount: number,
): EditSnapshot {
  return snapshotOf({
    ...before,
    ...changes,
    id: before.id,
    mode: before.mode,
    amount,
  });
}

/** 保存済み項目から公開項目だけを取り出す。 */
function publicItem(item: StoredEditItem): EditItem {
  return {
    before: item.before,
    status: item.status,
    ...(item.message === undefined ? {} : { message: item.message }),
    ...(item.after === undefined ? {} : { after: item.after }),
  };
}

/** 保存済み計画を公開契約へ変換し、raw を漏らさない。 */
function publicPlan(stored: StoredEditPlan): EditPlan {
  return v.parse(editPlanSchema, {
    id: stored.id,
    created_at: stored.created_at,
    expires_at: stored.expires_at,
    source: stored.source,
    changes: stored.changes,
    items: stored.items.map(publicItem),
  });
}

/** D1 から保存済み計画を読み、壊れた payload を安全なエラーへ変換する。 */
async function readStoredPlan(db: Database, id: string): Promise<StoredEditPlan> {
  const payload = await readEditPlan(db, id);
  if (payload === null) throw new EditError("plan_not_found", "編集計画が見つかりません", 404);
  try {
    const result = v.safeParse(storedEditPlanSchema, JSON.parse(payload));
    if (!result.success) throw new Error("invalid payload");
    return result.output;
  } catch {
    throw new EditError("invalid_plan", "編集計画を読み取れません", 409);
  }
}

/** 保存済み計画を D1 へ書き込む。 */
async function saveStoredPlan(db: Database, plan: StoredEditPlan): Promise<void> {
  await saveEditPlan(db, plan.id, JSON.stringify(plan));
}

/** 計画のゲートを取得し、必ず解放する。 */
async function withMutation<T>(
  db: Database,
  kind: "edit" | "plan" | "reconcile",
  callback: () => Promise<T>,
): Promise<T> {
  const owner = `${kind}:${crypto.randomUUID()}`;
  if (!(await acquireMutation(db, owner, kind))) {
    throw new EditError("mutation_busy", "同期または別の編集処理が実行中です", 409);
  }
  try {
    return await callback();
  } finally {
    await releaseMutation(db, owner);
  }
}

/** 編集計画を作成する。 */
export async function createEditPlan(
  db: Database,
  items: EditSnapshot[],
  changes: EditChanges,
  source: "single" | "filter",
  capabilities: EditCapabilities,
): Promise<EditPlan> {
  if (items.length < 1 || items.length > MAX_EDIT_ITEMS) {
    throw new EditError("too_many_items", `編集対象は1〜${MAX_EDIT_ITEMS}件にしてください`, 400);
  }
  if (source === "single" && items.length !== 1) {
    throw new EditError("single_item", "単体編集の対象は1件にしてください", 400);
  }
  if (source === "filter" && new Set(items.map((item) => item.mode)).size !== 1) {
    throw new EditError("mixed_modes", "一括編集の種別を一つに絞ってください", 400);
  }
  let validatedChanges: EditChanges;
  try {
    validatedChanges = v.parse(editChangesSchema, changes);
  } catch {
    throw new EditError("invalid_changes", "変更内容が不正です", 400);
  }
  const validatedItems = items.map((item) => {
    try {
      return v.parse(editSnapshotSchema, item);
    } catch {
      throw new EditError("invalid_snapshot", "編集対象の値が不正です", 400);
    }
  });
  for (const item of validatedItems) {
    validateEditFields(item, validatedChanges, capabilities, source === "filter");
    if (!hasEffectiveChange(item, validatedChanges)) {
      throw new EditError("no_op", "変更内容が現在の値と同じです", 400);
    }
  }

  return await withMutation(db, "plan", async () => {
    if (await hasUnresolvedEditPlans(db)) {
      throw new EditError(
        "unresolved_plan",
        "未照合の編集結果があります。保存済み計画の結果を照合してください",
        409,
      );
    }
    const rows = await readMirrorRows(
      db,
      validatedItems.map((item) => item.id),
    );
    const seen = new Set<number>();
    const storedItems: StoredEditItem[] = [];
    for (const item of validatedItems) {
      if (seen.has(item.id))
        throw new EditError("duplicate_item", "同じ明細を複数指定できません", 400);
      seen.add(item.id);
      const row = rows.get(item.id);
      if (row === undefined)
        throw new EditError("item_not_found", "対象明細がミラーにありません", 404);
      const current = sourceFromMirror(row);
      if (!sameSnapshot(item, current)) {
        throw new EditError(
          "stale_snapshot",
          "表示後に明細が変更されたため、再読み込みしてください",
          409,
        );
      }
      storedItems.push({
        before: item,
        status: "pending",
        beforeRaw: row.raw ?? undefined,
      });
    }
    await validateMasters(db, validatedItems, validatedChanges);

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const plan: StoredEditPlan = {
      id,
      created_at: createdAt,
      expires_at: new Date(Date.parse(createdAt) + EDIT_PLAN_TTL_MS).toISOString(),
      source,
      changes: validatedChanges,
      items: storedItems,
    };
    await insertEditPlan(db, id, JSON.stringify(plan), plan.expires_at);
    return publicPlan(plan);
  });
}

/** 保存済み編集計画を取得する。 */
export async function getEditPlan(db: Database, id: string): Promise<EditPlan> {
  return publicPlan(await readStoredPlan(db, id));
}

/** 指定日を優先して明細を再取得し、日付変更時は元の日付も照合する。 */
async function readAfterDate(
  client: EditClient,
  item: EditItem,
  date: string,
): Promise<ZaimMoney | undefined> {
  const first = await client.moneyById(item.before.mode, item.before.id, date);
  if (first !== undefined || date === item.before.date) return first;
  return await client.moneyById(item.before.mode, item.before.id, item.before.date);
}

/** Zaim 応答が編集対象として安全か確認する。 */
function validateLatest(latest: ZaimMoney, before: EditSnapshot): EditSnapshot {
  if (latest.active !== 1) {
    throw new EditError("inactive_item", "無効化された明細は編集できません", 409);
  }
  if (latest.currency_code !== "JPY") {
    throw new EditError(
      "unsupported_currency",
      "円以外、または通貨を確認できない明細は編集できません",
      400,
    );
  }
  const latestSnapshot = snapshotOf(latest);
  if (!sameSnapshot(before, latest)) {
    throw new EditError("conflict", "確認後に明細が変更されたため更新を中止しました", 409);
  }
  return latestSnapshot;
}

/** 送信失敗後に status と安全なメッセージを保存する。 */
async function markStatus(
  db: Database,
  plan: StoredEditPlan,
  index: number,
  status: StoredEditItem["status"],
  message: string,
  after?: EditSnapshot,
  confirmedRaw?: string,
): Promise<void> {
  const item = plan.items[index];
  if (item === undefined) return;
  plan.items[index] = {
    ...item,
    status,
    message,
    ...(after === undefined ? {} : { after }),
    ...(confirmedRaw === undefined ? {} : { confirmedRaw }),
  };
  await saveStoredPlan(db, plan);
}

/** 編集計画の一件を外部更新し、再取得結果をミラーへ反映する。 */
export async function executeEditItem(
  db: Database,
  client: EditClient,
  planId: string,
  transactionId: number,
  capabilities: EditCapabilities,
): Promise<EditPlan> {
  return await withMutation(db, "edit", async () => {
    const plan = await readStoredPlan(db, planId);
    const index = plan.items.findIndex((item) => item.before.id === transactionId);
    if (index < 0) throw new EditError("item_not_found", "編集計画に対象明細がありません", 404);
    const item = plan.items[index]!;
    if (item.status === "succeeded" || item.status === "failed") return publicPlan(plan);
    if (["sending", "unknown", "mirror_pending"].includes(item.status)) {
      throw new EditError(
        "reconcile_required",
        "先行処理の結果を照合してから続行してください",
        409,
      );
    }
    if (Date.parse(plan.expires_at) <= Date.now()) {
      throw new EditError("plan_expired", "編集計画の有効期限が切れています", 409);
    }
    if (await hasUnresolvedEditPlans(db)) {
      throw new EditError(
        "unresolved_plan",
        "未照合の編集結果があるため新しい更新を停止しています",
        409,
      );
    }

    validateEditFields(item.before, plan.changes, capabilities, plan.source === "filter");
    await validateMasters(db, [item.before], plan.changes);
    const latest = await client.moneyById(item.before.mode, item.before.id, item.before.date);
    if (latest === undefined) {
      await markStatus(db, plan, index, "failed", "Zaimから対象明細を取得できませんでした");
      return publicPlan(plan);
    }
    try {
      validateLatest(latest, item.before);
    } catch (error) {
      if (error instanceof EditError && error.code === "conflict") {
        await markStatus(db, plan, index, "failed", error.message);
        return publicPlan(plan);
      }
      throw error;
    }
    const amount = plan.changes.amount ?? latest.amount;
    const expected = expectedSnapshot(item.before, plan.changes, amount);
    // 実行直前に得た全列を、更新後の副作用比較の基準として保存する。
    // 計画作成時のミラー raw を使うと、非表示列の正当な変更を誤検出する。
    plan.items[index] = {
      ...item,
      status: "sending",
      message: undefined,
      beforeRaw: JSON.stringify(latest),
    };
    await saveStoredPlan(db, plan);

    try {
      await client.updateMoney(item.before.mode, item.before.id, { ...plan.changes, amount });
    } catch {
      await sleep(EDIT_INTERVAL_MS);
      await markStatus(db, plan, index, "unknown", safeExternalMessage());
      return publicPlan(plan);
    }
    await sleep(EDIT_INTERVAL_MS);

    let readback: ZaimMoney | undefined;
    try {
      readback = await readAfterDate(client, item, expected.date);
    } catch {
      await markStatus(db, plan, index, "unknown", safeExternalMessage());
      return publicPlan(plan);
    }
    if (readback === undefined) {
      await markStatus(db, plan, index, "unknown", UNKNOWN_MESSAGE);
      return publicPlan(plan);
    }
    const readbackSnapshot = snapshotOf(readback);
    if (readback.active !== 1) {
      await markStatus(db, plan, index, "unknown", UNKNOWN_MESSAGE, readbackSnapshot);
      return publicPlan(plan);
    }
    if (
      !sameSnapshot(expected, readback) ||
      !rawUnchanged(plan.items[index].beforeRaw, readback, plan.changes)
    ) {
      await markStatus(db, plan, index, "unknown", UNKNOWN_MESSAGE, readbackSnapshot);
      return publicPlan(plan);
    }
    try {
      await replaceMirrorMoney(db, readback);
    } catch {
      await markStatus(
        db,
        plan,
        index,
        "mirror_pending",
        MIRROR_MESSAGE,
        readbackSnapshot,
        JSON.stringify(readback),
      );
      return publicPlan(plan);
    }
    await markStatus(
      db,
      plan,
      index,
      "succeeded",
      "保存しました",
      readbackSnapshot,
      JSON.stringify(readback),
    );
    return publicPlan(plan);
  });
}

/** 結果不明の明細を読み取りだけで照合し、成功時だけミラーを修復する。 */
export async function reconcileEditItem(
  db: Database,
  client: EditClient,
  planId: string,
  transactionId: number,
): Promise<EditPlan> {
  return await withMutation(db, "reconcile", async () => {
    const plan = await readStoredPlan(db, planId);
    const index = plan.items.findIndex((item) => item.before.id === transactionId);
    if (index < 0) throw new EditError("item_not_found", "編集計画に対象明細がありません", 404);
    const item = plan.items[index]!;
    if (!["sending", "unknown", "mirror_pending"].includes(item.status)) return publicPlan(plan);
    const amount = plan.changes.amount ?? item.before.amount;
    const expected = expectedSnapshot(item.before, plan.changes, amount);
    let readback: ZaimMoney | undefined;
    try {
      readback = await readAfterDate(client, item, expected.date);
    } catch {
      return publicPlan(plan);
    }
    if (readback === undefined) return publicPlan(plan);
    const after = snapshotOf(readback);
    if (readback.active !== 1 || readback.currency_code !== "JPY") return publicPlan(plan);
    if (
      !sameSnapshot(expected, readback) ||
      !rawUnchanged(item.beforeRaw, readback, plan.changes)
    ) {
      return publicPlan(plan);
    }
    try {
      await replaceMirrorMoney(db, readback);
    } catch {
      await markStatus(
        db,
        plan,
        index,
        "mirror_pending",
        MIRROR_MESSAGE,
        after,
        JSON.stringify(readback),
      );
      return publicPlan(plan);
    }
    await markStatus(db, plan, index, "succeeded", "保存しました", after, JSON.stringify(readback));
    return publicPlan(plan);
  });
}
