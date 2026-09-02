/** Issue #37 の canary・本実行・rollback を共通化する。 */

import {
  reconcileReceiptIdBackfill,
  selectAppliedReceiptIdBackfill,
  verifyOnlyReceiptIdChanged,
  type ReceiptIdBackfillEntry,
  type ReceiptIdBackfillManifest,
  type ReceiptIdBackfillUpdateTarget,
} from "./receipt-id-backfill";
import type { ReceiptIdUpdateMode, ZaimMoney } from "./zaim";

/** ZaimClient から移行処理に必要な境界だけを抜き出した型。 */
export interface ReceiptIdBackfillClient {
  /** @returns 全明細をページ単位で返す非同期反復子。 */
  iterMoney(): AsyncGenerator<ZaimMoney[]>;
  /**
   * @param mode 支出または収入。
   * @param id 明細 ID。
   * @param date 現在の明細日。
   * @returns 指定明細の最新値。見つからなければ undefined。
   */
  moneyById(mode: ReceiptIdUpdateMode, id: number, date: string): Promise<ZaimMoney | undefined>;
  /**
   * @param mode 支出または収入。
   * @param id 明細 ID。
   * @param amount Zaim API から直前に取得した金額。
   * @param receiptId 設定する receipt_id。
   */
  updateReceiptId(
    mode: ReceiptIdUpdateMode,
    id: number,
    amount: number,
    receiptId: number,
  ): Promise<void>;
}

/** 1 件の更新完了後に記録するイベント。 */
export interface ReceiptIdBackfillUpdateEvent {
  /** 実行した操作。 */
  action: "apply" | "rollback";
  /** 固定計画上の項目。 */
  entry: ReceiptIdBackfillEntry;
}

/** 一括処理の待機と記録を差し替えるオプション。 */
export interface ReceiptIdBackfillRunOptions {
  /** リクエスト間隔を空ける関数。 */
  wait?: (milliseconds: number) => Promise<void>;
  /** 1 件の更新成功直後に呼ぶ記録処理。 */
  onUpdated?: (event: ReceiptIdBackfillUpdateEvent) => Promise<void> | void;
}

/** 本実行の処理件数。 */
export interface ReceiptIdBackfillApplyResult {
  /** この実行で新たに適用した件数。 */
  newlyApplied: number;
  /** 実行開始時に既に適用済みだった件数。 */
  alreadyApplied: number;
}

/** Zaim への連続更新間隔。 */
const UPDATE_INTERVAL_MS = 300;

/**
 * 指定ミリ秒だけ待つ。
 *
 * @param milliseconds 待機ミリ秒。
 */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Zaim API から全明細を取得する。
 *
 * @param client Zaim API 境界。
 * @returns 全ページを結合した明細。
 */
export async function fetchAllMoney(client: ReceiptIdBackfillClient): Promise<ZaimMoney[]> {
  const money: ZaimMoney[] = [];
  for await (const page of client.iterMoney()) money.push(...page);
  return money;
}

/**
 * 全明細から計画項目に対応する 1 件を取得する。
 *
 * @param money 全明細。
 * @param entry 固定計画上の項目。
 * @returns 対応する明細。
 * @throws 対応する明細が無い場合。
 */
function findMoney(money: readonly ZaimMoney[], entry: ReceiptIdBackfillEntry): ZaimMoney {
  const found = money.find(({ id, mode }) => id === entry.id && mode === entry.mode);
  if (!found) throw new Error(`計画した明細 ${entry.id} (${entry.mode}) が Zaim API に存在しない`);
  return found;
}

/**
 * 1 件ずつ更新し、成功直後にログ用コールバックを呼ぶ。
 *
 * @param client Zaim API 境界。
 * @param updates 更新対象と直前取得に使う現在日。
 * @param action 適用または rollback。
 * @param options 待機と記録の差し替え。
 */
async function updateSequentially(
  client: ReceiptIdBackfillClient,
  updates: readonly ReceiptIdBackfillUpdateTarget[],
  action: ReceiptIdBackfillUpdateEvent["action"],
  options: ReceiptIdBackfillRunOptions,
): Promise<number> {
  const wait = options.wait ?? sleep;
  let updatedCount = 0;
  for (const { entry, lookupDate } of updates) {
    const latest = await client.moneyById(entry.mode, entry.id, lookupDate);
    if (!latest) {
      throw new Error(`更新直前の明細 ${entry.id} (${entry.mode}) を取得できない`);
    }
    const receiptId = action === "apply" ? entry.receiptId : 0;
    if (action === "apply") {
      if (latest.receipt_id === entry.receiptId) continue;
      if (latest.receipt_id !== 0) {
        throw new Error(
          `明細 ${entry.id} の receipt_id は 0 でも計画値でもない: ${String(latest.receipt_id)}`,
        );
      }
      if (latest.date !== entry.observedDate || latest.name !== entry.observedName) {
        throw new Error(`明細 ${entry.id} は更新直前に変更されているため中断`);
      }
    } else {
      if (latest.receipt_id === 0) continue;
      if (latest.receipt_id !== entry.receiptId) {
        throw new Error(
          `明細 ${entry.id} の receipt_id は 0 でも計画値でもない: ${String(latest.receipt_id)}`,
        );
      }
    }
    await client.updateReceiptId(entry.mode, entry.id, latest.amount, receiptId);
    await options.onUpdated?.({ action, entry });
    updatedCount += 1;
    await wait(UPDATE_INTERVAL_MS);
  }
  return updatedCount;
}

/**
 * dry-run 済み manifest を Zaim の最新状態へ適用する。
 *
 * 適用済みの項目は API 状態から判定して飛ばすため、途中失敗後も同じ manifest で再開できる。
 *
 * @param client Zaim API 境界。
 * @param manifest 確認済みの固定計画。
 * @param options 待機と記録の差し替え。
 * @returns 新規適用件数と開始時の適用済み件数。
 */
export async function applyReceiptIdBackfill(
  client: ReceiptIdBackfillClient,
  manifest: ReceiptIdBackfillManifest,
  options: ReceiptIdBackfillRunOptions = {},
): Promise<ReceiptIdBackfillApplyResult> {
  const before = await fetchAllMoney(client);
  const reconciliation = reconcileReceiptIdBackfill(manifest, before);
  const newlyApplied = await updateSequentially(client, reconciliation.pending, "apply", options);

  const after = reconcileReceiptIdBackfill(manifest, await fetchAllMoney(client));
  if (after.pending.length > 0) {
    throw new Error(`適用後も receipt_id が 0 の明細が ${after.pending.length} 件残っている`);
  }
  return {
    newlyApplied,
    alreadyApplied: reconciliation.applied.length,
  };
}

/**
 * manifest の先頭の未適用 1 件を計画値へ更新し、検証後に 0 へ戻す。
 *
 * receipt_id 以外の列が変化した場合も rollback を試みた後で失敗を返す。
 *
 * @param client Zaim API 境界。
 * @param manifest 確認済みの固定計画。
 * @returns 往復確認した計画項目。
 * @throws 未適用項目が無い、更新差分が不正、または rollback に失敗した場合。
 */
export async function runReceiptIdBackfillCanary(
  client: ReceiptIdBackfillClient,
  manifest: ReceiptIdBackfillManifest,
): Promise<ReceiptIdBackfillEntry> {
  const current = await fetchAllMoney(client);
  const reconciliation = reconcileReceiptIdBackfill(manifest, current);
  if (reconciliation.applied.length > 0) {
    throw new Error(
      `canary 前に計画値が ${reconciliation.applied.length} 件適用済み（先に rollback する）`,
    );
  }
  const candidate = reconciliation.pending[0];
  if (!candidate) throw new Error("canary に使える未適用明細がない");

  const { entry } = candidate;
  const before = findMoney(current, entry);
  let primaryError: unknown;
  try {
    await client.updateReceiptId(entry.mode, entry.id, before.amount, entry.receiptId);
  } catch (error) {
    // 応答が途切れてもサーバー側では反映済みの場合があるため、必ず再取得して判定する
    primaryError = error;
  }

  let afterSet: ZaimMoney | undefined;
  try {
    afterSet = findMoney(await fetchAllMoney(client), entry);
    verifyOnlyReceiptIdChanged(before, afterSet, entry.receiptId);
  } catch (error) {
    primaryError = primaryError
      ? new AggregateError([primaryError, error], `明細 ${entry.id} の canary 更新確認が失敗`, {
          cause: error,
        })
      : error;
  }

  try {
    const latest = afterSet ?? findMoney(await fetchAllMoney(client), entry);
    if (latest.receipt_id === entry.receiptId) {
      await client.updateReceiptId(entry.mode, entry.id, latest.amount, 0);
    } else if (latest.receipt_id !== 0) {
      throw new Error(
        `明細 ${entry.id} の receipt_id は canary 計画値でも 0 でもない: ${String(latest.receipt_id)}`,
      );
    }
    const afterReset = findMoney(await fetchAllMoney(client), entry);
    verifyOnlyReceiptIdChanged(before, afterReset, 0);
  } catch (rollbackError) {
    if (primaryError) {
      throw new AggregateError(
        [primaryError, rollbackError],
        `明細 ${entry.id} の canary と rollback が失敗`,
        { cause: rollbackError },
      );
    }
    throw rollbackError;
  }

  if (primaryError) throw primaryError;
  return entry;
}

/**
 * manifest の計画値が付いた明細だけを receipt_id 0 へ戻す。
 *
 * @param client Zaim API 境界。
 * @param manifest 適用時と同じ固定計画。
 * @param options 待機と記録の差し替え。
 * @returns この実行で 0 へ戻した件数。
 */
export async function rollbackReceiptIdBackfill(
  client: ReceiptIdBackfillClient,
  manifest: ReceiptIdBackfillManifest,
  options: ReceiptIdBackfillRunOptions = {},
): Promise<number> {
  const current = await fetchAllMoney(client);
  const updates = selectAppliedReceiptIdBackfill(manifest, current);
  const updatedCount = await updateSequentially(client, updates, "rollback", options);

  const remaining = selectAppliedReceiptIdBackfill(manifest, await fetchAllMoney(client));
  if (remaining.length > 0) {
    throw new Error(`rollback 後も計画値の receipt_id が ${remaining.length} 件残っている`);
  }
  return updatedCount;
}
