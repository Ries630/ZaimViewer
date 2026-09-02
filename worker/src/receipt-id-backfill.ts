/** Issue #37 の receipt_id 後付け計画と安全検証。 */

import * as v from "valibot";

import type { ReceiptIdUpdateMode, ZaimMoney } from "./zaim";

/** 後付け用に確保した receipt_id の先頭。 */
export const BACKFILL_RECEIPT_ID_BASE = 4_200_000_000;

/** 移行対象として確定した支出件数。 */
const EXPECTED_PAYMENT_COUNT = 1080;

/** 移行対象として確定した収入件数。 */
const EXPECTED_INCOME_COUNT = 60;

/** 移行対象の合計件数。 */
const EXPECTED_TOTAL_COUNT = EXPECTED_PAYMENT_COUNT + EXPECTED_INCOME_COUNT;

/** dry-run で確認する移行対象 1 件。 */
export interface ReceiptIdBackfillEntry {
  /** Zaim 明細 ID。 */
  id: number;
  /** 支出または収入。 */
  mode: ReceiptIdUpdateMode;
  /** 割り当てる receipt_id。 */
  receiptId: number;
  /** dry-run 時点の日付。 */
  observedDate: string;
  /** dry-run 時点の品名。 */
  observedName: string;
  /** dry-run の目視確認に使う金額。更新時には使わない。 */
  observedAmount: number;
}

/** dry-run で生成し、canary・本実行・rollback で共有する固定計画。 */
export interface ReceiptIdBackfillManifest {
  /** manifest 形式のバージョン。 */
  version: 1;
  /** dry-run の実行時刻。 */
  createdAt: string;
  /** 採番域の先頭。 */
  baseReceiptId: number;
  /** ID 順に固定した移行対象。 */
  entries: ReceiptIdBackfillEntry[];
}

/** 更新直前の再取得へ渡す対象。 */
export interface ReceiptIdBackfillUpdateTarget {
  /** 固定計画上の項目。 */
  entry: ReceiptIdBackfillEntry;
  /** 現在の明細を 1 件に絞る日付。 */
  lookupDate: string;
}

/** 現在の Zaim 明細と固定計画を照合した結果。 */
export interface ReceiptIdBackfillReconciliation {
  /** まだ receipt_id が 0 の項目。 */
  pending: ReceiptIdBackfillUpdateTarget[];
  /** 既に計画値が設定され、再実行時に飛ばせる項目。 */
  applied: ReceiptIdBackfillEntry[];
}

/** JSON から読む manifest 1 件のスキーマ。 */
const ReceiptIdBackfillEntrySchema = v.object({
  id: v.pipe(v.number(), v.safeInteger()),
  mode: v.picklist(["payment", "income"]),
  receiptId: v.pipe(v.number(), v.safeInteger()),
  observedDate: v.string(),
  observedName: v.string(),
  observedAmount: v.pipe(v.number(), v.safeInteger()),
});

/** JSON から読む manifest 全体のスキーマ。 */
const ReceiptIdBackfillManifestSchema = v.object({
  version: v.literal(1),
  createdAt: v.string(),
  baseReceiptId: v.pipe(v.number(), v.safeInteger()),
  entries: v.array(ReceiptIdBackfillEntrySchema),
});

/**
 * 更新対象として許可された mode かを判定する。
 *
 * @param mode Zaim の明細種別。
 * @returns 支出または収入なら true。
 */
function isUpdateMode(mode: string): mode is ReceiptIdUpdateMode {
  return mode === "payment" || mode === "income";
}

/**
 * Issue #37 の後付け対象かを型付きで判定する。
 *
 * @param item Zaim 明細。
 * @returns receipt_id が 0 で品名を持つ支出・収入なら true。
 */
function isBackfillTarget(
  item: ZaimMoney,
): item is ZaimMoney & { mode: ReceiptIdUpdateMode; name: string; receipt_id: 0 } {
  return (
    isUpdateMode(item.mode) &&
    item.receipt_id === 0 &&
    item.name !== undefined &&
    item.name.trim().length > 0
  );
}

/**
 * 明細を mode と ID で一意に識別する。
 *
 * @param mode 明細種別。
 * @param id 明細 ID。
 * @returns Map 用のキー。
 */
function moneyKey(mode: string, id: number): string {
  return `${mode}:${id}`;
}

/**
 * mode ごとの対象件数を確定値と照合する。
 *
 * @param entries 対象候補。
 * @throws 件数が確定値と違う場合。
 */
function verifyTargetCounts(entries: readonly ReceiptIdBackfillEntry[]): void {
  const paymentCount = entries.filter(({ mode }) => mode === "payment").length;
  const incomeCount = entries.filter(({ mode }) => mode === "income").length;
  if (paymentCount !== EXPECTED_PAYMENT_COUNT) {
    throw new Error(
      `payment の対象件数が不一致: 期待 ${EXPECTED_PAYMENT_COUNT}、実際 ${paymentCount}`,
    );
  }
  if (incomeCount !== EXPECTED_INCOME_COUNT) {
    throw new Error(
      `income の対象件数が不一致: 期待 ${EXPECTED_INCOME_COUNT}、実際 ${incomeCount}`,
    );
  }
}

/**
 * manifest の採番順と一意性を検証する。
 *
 * @param manifest 検証する固定計画。
 * @throws 形式バージョン、採番順、対象の一意性が不正な場合。
 */
function verifyManifest(manifest: ReceiptIdBackfillManifest): void {
  if (manifest.baseReceiptId !== BACKFILL_RECEIPT_ID_BASE) {
    throw new Error("未対応の receipt_id backfill manifest");
  }
  verifyTargetCounts(manifest.entries);

  const keys = new Set<string>();
  for (const [index, entry] of manifest.entries.entries()) {
    if (entry.receiptId !== BACKFILL_RECEIPT_ID_BASE + index) {
      throw new Error(`manifest の ${index + 1} 件目の receipt_id が不正`);
    }
    const key = moneyKey(entry.mode, entry.id);
    if (keys.has(key)) throw new Error(`manifest に明細 ${entry.id} (${entry.mode}) が重複`);
    keys.add(key);
  }
}

/**
 * 採番予定値が計画外の明細に使われていないことを確認する。
 *
 * @param manifest 固定計画。
 * @param money Zaim API の現在値。
 * @throws 計画値を別の明細が使っている場合。
 */
function verifyReceiptIdOwnership(
  manifest: ReceiptIdBackfillManifest,
  money: readonly ZaimMoney[],
): void {
  const plannedByReceiptId = new Map(
    manifest.entries.map((entry) => [entry.receiptId, moneyKey(entry.mode, entry.id)]),
  );
  for (const item of money) {
    if (item.receipt_id === undefined) continue;
    const plannedKey = plannedByReceiptId.get(item.receipt_id);
    if (plannedKey && plannedKey !== moneyKey(item.mode, item.id)) {
      throw new Error(
        `採番予定の receipt_id ${item.receipt_id} は計画外の明細 ${item.id} で使用済み`,
      );
    }
  }
}

/**
 * JSON から得た値を receipt_id 後付け manifest として検証する。
 *
 * @param input JSON.parse 後のオブジェクト。
 * @returns 型を検証した manifest。
 * @throws 必須項目または型が不正な場合。
 */
export function parseReceiptIdBackfillManifest(
  input: Record<string, unknown>,
): ReceiptIdBackfillManifest {
  const result = v.safeParse(ReceiptIdBackfillManifestSchema, input);
  if (!result.success) throw new Error("receipt_id backfill manifest の形式が不正");
  return result.output;
}

/**
 * Zaim API の全明細から固定採番の manifest を作る。
 *
 * 対象は receipt_id が 0 で品名を持つ支出・収入だけ。振替は ADR-0030 に従い除外する。
 *
 * @param money Zaim API から取得した全明細。
 * @param createdAt dry-run の ISO 8601 時刻。
 * @returns ID 順に採番した manifest。
 * @throws 対象件数または採番域が前提と違う場合。
 */
export function createReceiptIdBackfillManifest(
  money: readonly ZaimMoney[],
  createdAt: string,
): ReceiptIdBackfillManifest {
  const targets = money
    .filter(isBackfillTarget)
    .toSorted((left, right) => left.id - right.id || left.mode.localeCompare(right.mode));

  const entries = targets.map<ReceiptIdBackfillEntry>((item, index) => ({
    id: item.id,
    mode: item.mode,
    receiptId: BACKFILL_RECEIPT_ID_BASE + index,
    observedDate: item.date,
    observedName: item.name,
    observedAmount: item.amount,
  }));
  verifyTargetCounts(entries);

  const lastReceiptId = BACKFILL_RECEIPT_ID_BASE + EXPECTED_TOTAL_COUNT - 1;
  const collision = money.find(
    ({ receipt_id: receiptId }) =>
      receiptId !== undefined &&
      receiptId >= BACKFILL_RECEIPT_ID_BASE &&
      receiptId <= lastReceiptId,
  );
  if (collision) {
    throw new Error(
      `採番予定の receipt_id ${collision.receipt_id} は明細 ${collision.id} で使用済み`,
    );
  }

  return {
    version: 1,
    createdAt,
    baseReceiptId: BACKFILL_RECEIPT_ID_BASE,
    entries,
  };
}

/**
 * manifest と Zaim API の最新状態を照合し、未適用と適用済みに分ける。
 *
 * @param manifest dry-run で確認済みの固定計画。
 * @param money Zaim API から取り直した全明細。
 * @returns 再開可能な適用状態。
 * @throws 対象の欠落、確認後の変更、計画外 receipt_id、採番衝突がある場合。
 */
export function reconcileReceiptIdBackfill(
  manifest: ReceiptIdBackfillManifest,
  money: readonly ZaimMoney[],
): ReceiptIdBackfillReconciliation {
  verifyManifest(manifest);
  verifyReceiptIdOwnership(manifest, money);

  const byKey = new Map(money.map((item) => [moneyKey(item.mode, item.id), item]));

  const pending: ReceiptIdBackfillUpdateTarget[] = [];
  const applied: ReceiptIdBackfillEntry[] = [];
  for (const entry of manifest.entries) {
    const current = byKey.get(moneyKey(entry.mode, entry.id));
    if (!current) {
      throw new Error(`計画した明細 ${entry.id} (${entry.mode}) が Zaim API に存在しない`);
    }
    if (current.receipt_id === entry.receiptId) {
      applied.push(entry);
      continue;
    }
    if (current.receipt_id !== 0) {
      throw new Error(
        `明細 ${entry.id} の receipt_id は 0 でも計画値でもない: ${String(current.receipt_id)}`,
      );
    }
    if (current.date !== entry.observedDate || current.name !== entry.observedName) {
      throw new Error(`明細 ${entry.id} は dry-run 後に変更されているため中断`);
    }
    pending.push({ entry, lookupDate: current.date });
  }

  return { pending, applied };
}

/**
 * 現在計画値が付いている明細だけを rollback 候補として抽出する。
 *
 * 未適用項目の欠落や変更は緊急復元を妨げない。計画値が別の明細に付く衝突だけは、
 * 所有者を誤って更新しないため中断する。
 *
 * @param manifest 適用時と同じ固定計画。
 * @param money Zaim API の現在値。
 * @returns 計画値が付いている明細と現在日。
 * @throws manifest が不正、または計画値が別の明細に使われている場合。
 */
export function selectAppliedReceiptIdBackfill(
  manifest: ReceiptIdBackfillManifest,
  money: readonly ZaimMoney[],
): ReceiptIdBackfillUpdateTarget[] {
  verifyManifest(manifest);
  verifyReceiptIdOwnership(manifest, money);
  const byKey = new Map(money.map((item) => [moneyKey(item.mode, item.id), item]));

  return manifest.entries.flatMap((entry) => {
    const current = byKey.get(moneyKey(entry.mode, entry.id));
    return current?.receipt_id === entry.receiptId ? [{ entry, lookupDate: current.date }] : [];
  });
}

/**
 * 更新前後で receipt_id 以外の列が変化していないことを確認する。
 *
 * @param before 更新直前の明細。
 * @param after 更新後に Zaim API から取り直した明細。
 * @param expectedReceiptId 更新後に期待する receipt_id。
 * @throws receipt_id が期待値でない、または別の列も変化した場合。
 */
export function verifyOnlyReceiptIdChanged(
  before: ZaimMoney,
  after: ZaimMoney,
  expectedReceiptId: number,
): void {
  if (after.receipt_id !== expectedReceiptId) {
    throw new Error(
      `明細 ${before.id} の receipt_id が不一致: 期待 ${expectedReceiptId}、実際 ${String(after.receipt_id)}`,
    );
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete("receipt_id");
  for (const key of keys) {
    const samePresence = Object.hasOwn(before, key) === Object.hasOwn(after, key);
    const sameValue = JSON.stringify(before[key]) === JSON.stringify(after[key]);
    if (!samePresence || !sameValue) {
      throw new Error(`receipt_id 以外の列 ${key} も変化した`);
    }
  }
}
