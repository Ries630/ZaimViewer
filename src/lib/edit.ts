/**
 * 明細編集で使う値の組み立て。
 *
 * 編集 API の入力は、表示用の `Transaction` と違い、変更した項目だけを
 * 送る。ここで差分を作ることで、空文字による消去と未指定による保持を
 * 区別し、表示用の金額をそのまま API に送り込まないようにする。
 */

import type { Transaction } from "../api/transactions";
import {
  MAX_EDIT_ITEMS as CONTRACT_MAX_EDIT_ITEMS,
  EDIT_INTERVAL_MS as CONTRACT_EDIT_INTERVAL_MS,
  snapshotOf as contractSnapshotOf,
  type EditCapabilities,
  type EditChanges,
  type EditMode,
  type EditPlan,
  type EditSnapshot,
} from "../../worker/src/edit-contract";
import { MAX_AMOUNT } from "../../worker/src/limits";

/** 編集契約の型をクライアント側から再利用する。 */
export type { EditCapabilities, EditChanges, EditMode, EditPlan, EditSnapshot };

/** 編集計画内の明細 1 件。 */
export type EditPlanItem = EditPlan["items"][number];
/** 一件の処理状態。 */
export type EditItemStatus = EditPlanItem["status"];

/** UI の入力値。空文字は明示的に消す値として扱う。 */
export interface EditDraft {
  /** 日付。 */
  date: string;
  /** 金額欄の文字列。 */
  amount: string;
  /** カテゴリ ID。 */
  category_id: number | null;
  /** ジャンル ID。 */
  genre_id: number | null;
  /** 出金元口座 ID。 */
  from_account_id: number | null;
  /** 入金先口座 ID。 */
  to_account_id: number | null;
  /** 品名。 */
  name: string;
  /** 店舗。 */
  place: string;
  /** メモ。 */
  comment: string;
}

/** 差分に含められるキー。 */
export type EditField = keyof EditChanges;

/**
 * 明細を編集用のスナップショットへ変換する。
 *
 * @param transaction 一覧 API が返した明細。
 * @returns 更新競合判定に使う値。
 */
export function snapshotOf(transaction: Transaction): EditSnapshot {
  // API の mode は現在 string だが、契約側で未知の種別は拒否する。
  return contractSnapshotOf({
    id: transaction.id,
    mode: transaction.mode,
    date: transaction.date,
    amount: transaction.amount,
    category_id: transaction.category_id,
    genre_id: transaction.genre_id,
    from_account_id: transaction.from_account_id,
    to_account_id: transaction.to_account_id,
    name: transaction.name,
    place: transaction.place,
    comment: transaction.comment,
    currency_code: transaction.currency_code,
    receipt_id: transaction.receipt_id,
  });
}

/**
 * スナップショットを入力欄の値にする。
 *
 * @param snapshot 編集対象の現在値。
 * @returns controlled input に渡す値。
 */
export function draftOf(snapshot: EditSnapshot): EditDraft {
  return {
    date: snapshot.date,
    amount: String(snapshot.amount),
    category_id: snapshot.category_id || null,
    genre_id: snapshot.genre_id || null,
    from_account_id: snapshot.from_account_id || null,
    to_account_id: snapshot.to_account_id || null,
    name: snapshot.name ?? "",
    place: snapshot.place ?? "",
    comment: snapshot.comment ?? "",
  };
}

/**
 * 金額欄を安全な整数へ変換する。
 *
 * @param value 入力欄の値。
 * @returns 金額。空欄・小数・負数・安全でない値は null。
 */
export function parseEditAmount(value: string): number | null {
  if (value.trim() === "") return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 && amount <= MAX_AMOUNT ? amount : null;
}

/**
 * スナップショットと入力値の差分を作る。
 *
 * amount は変更したときだけ返す。変更しない場合に UI が保持していた金額を
 * 送ると、サーバーが直前の最新値を採用する安全策を迂回するためである。
 * テキスト欄の空文字は「消す」という明示的な変更なので、未指定と区別する。
 *
 * @param before 編集開始時の値。
 * @param draft フォームの入力値。
 * @returns 変更された項目だけの値。入力が不正なら null。
 */
export function changesFromDraft(before: EditSnapshot, draft: EditDraft): EditChanges | null {
  const amount = parseEditAmount(draft.amount);
  if (amount === null) return null;

  const changes: EditChanges = {};
  if (draft.date !== before.date) changes.date = draft.date;
  if (amount !== before.amount) changes.amount = amount;
  if (draft.category_id !== (before.category_id || null) && draft.category_id !== null) {
    changes.category_id = draft.category_id;
  }
  if (draft.genre_id !== (before.genre_id || null) && draft.genre_id !== null) {
    changes.genre_id = draft.genre_id;
  }
  if (
    draft.from_account_id !== (before.from_account_id || null) &&
    draft.from_account_id !== null
  ) {
    changes.from_account_id = draft.from_account_id;
  }
  if (draft.to_account_id !== (before.to_account_id || null) && draft.to_account_id !== null) {
    changes.to_account_id = draft.to_account_id;
  }
  if (draft.name !== before.name) changes.name = draft.name;
  if (draft.place !== before.place) changes.place = draft.place;
  if (draft.comment !== before.comment) changes.comment = draft.comment;
  return changes;
}

/**
 * 変更を適用した表示用スナップショットを作る。
 *
 * API に送る直前の確認画面だけで使う。サーバーの結果を表すものではないため、
 * 保存後の表示更新には使わない。
 *
 * @param before 更新前の値。
 * @param changes 適用する差分。
 * @returns 確認画面用の仮の更新後状態。
 */
export function previewSnapshot(before: EditSnapshot, changes: EditChanges): EditSnapshot {
  return {
    ...before,
    ...changes,
    name: changes.name ?? before.name,
    place: changes.place ?? before.place,
    comment: changes.comment ?? before.comment,
  };
}

/**
 * 種別と capability から単体編集で出す項目を返す。
 *
 * @param mode 明細の種別。
 * @param capabilities API が返した capability。
 * @param receiptId 支出の品名編集判定に使う値。
 * @returns 入力可能な項目。
 */
export function editableFields(
  mode: EditMode,
  capabilities: EditCapabilities,
  receiptId: number | null,
): EditField[] {
  if (!capabilities.enabled || !capabilities.modes.includes(mode)) return [];
  if (mode === "transfer" && !capabilities.transfer) return [];

  const fields: EditField[] = ["date", "amount", "comment"];
  // 実機で確認できた欄だけを出す。収入の genre/place と振替の自由文字列は
  // API 契約でも未対応としているため、画面からも選べないようにする。
  if (mode === "payment") fields.push("place", "category_id", "genre_id");
  if (mode === "income") fields.push("category_id");
  if (mode === "payment") fields.push("from_account_id");
  if (mode === "income") fields.push("to_account_id");
  if (mode === "transfer") fields.push("from_account_id", "to_account_id");
  if (mode === "payment" && receiptId !== null && receiptId > 0) fields.push("name");
  if (mode === "income" && capabilities.incomeName) fields.push("name");
  return fields;
}

/**
 * 一括編集で使う項目を返す。日付と金額は一括編集には含めない。
 *
 * @param mode 対象を同一種別に絞った種別。
 * @param capabilities API が返した capability。
 * @param allHaveReceipt 支出の全対象が品目化されているか。
 * @returns 一括編集の入力可能な項目。
 */
export function bulkEditableFields(
  mode: EditMode,
  capabilities: EditCapabilities,
  allHaveReceipt: boolean,
): EditField[] {
  return editableFields(mode, capabilities, allHaveReceipt ? 1 : null).filter(
    (field) => field !== "date" && field !== "amount",
  );
}

/**
 * 一括編集でチェックされた項目だけを API 用の差分にする。
 *
 * @param selected 明示的にチェックされた項目。
 * @param values 各項目の入力値。
 * @returns 選択された項目だけの差分。入力が不正なら null。
 */
export function changesFromBulk(
  selected: ReadonlySet<EditField>,
  values: Partial<EditDraft>,
): EditChanges | null {
  const changes: EditChanges = {};
  for (const field of selected) {
    switch (field) {
      case "date":
      case "amount":
        return null;
      case "category_id":
      case "genre_id": {
        const value = values[field];
        if (value !== null && value !== undefined) changes[field] = value;
        break;
      }
      case "from_account_id":
      case "to_account_id": {
        const value = values[field];
        if (value !== null && value !== undefined) changes[field] = value;
        break;
      }
      case "name":
      case "place":
      case "comment":
        changes[field] = values[field] ?? "";
        break;
    }
  }
  return changes;
}

/** 一括編集の最大対象件数。契約側の上限を画面でも共有する。 */
export const MAX_EDIT_ITEMS = CONTRACT_MAX_EDIT_ITEMS;
/** 編集計画の外部更新間隔。Worker と同じ値で要求を間引く。 */
export const EDIT_INTERVAL_MS = CONTRACT_EDIT_INTERVAL_MS;

/** 編集中の新規送信を止めるべき状態か判定する。 */
export function isEditSendBlocked(online: boolean, hidden: boolean): boolean {
  return !online || hidden;
}

/** 編集 API が返す送信前エラーの機械情報。 */
export interface EditExecutionError {
  /** API のエラーコード。 */
  code: string;
  /** API の HTTP ステータス。 */
  status: number;
}

/**
 * 実行要求の失敗を結果不明として扱うべきか判定する。
 *
 * HTTP 4xx と既知の計画検証エラーは外部更新前に返るため、再送ではなく
 * pending のまま手動再開へ戻す。通信失敗や未知の応答は POST 到達の可能性を
 * 否定できないので、結果不明として照合へ回す。
 *
 * @param error API エラーまたは通信例外。
 * @returns 外部更新の結果が不明なら true。
 */
export function isEditExecutionUncertain(error: EditExecutionError | null): boolean {
  if (error === null) return true;
  const { code, status } = error;
  if (status >= 400 && status < 500) return false;
  if (code.startsWith("invalid") || code === "credentials_missing" || code === "edit_disabled") {
    return false;
  }
  if (code === "mutation_busy" || code === "plan_expired" || code === "reconcile_required") {
    return false;
  }
  return true;
}

/** sessionStorage に保存するのは計画 ID だけに限定する。 */
export const ACTIVE_EDIT_PLAN_STORAGE_KEY = "zaimviewer.active-edit-plan-id";

/**
 * 編集計画 ID を保存する。
 *
 * @param storage 保存先。テストではメモリ上の Storage を渡す。
 * @param id 計画 ID。null なら保存値を消す。
 */
export function storeActivePlanId(storage: Storage, id: string | null): void {
  if (id === null) storage.removeItem(ACTIVE_EDIT_PLAN_STORAGE_KEY);
  else storage.setItem(ACTIVE_EDIT_PLAN_STORAGE_KEY, id);
}

/**
 * 保存済みの編集計画 ID を読む。
 *
 * @param storage 保存先。
 * @returns 計画 ID。未保存なら null。
 */
export function readActivePlanId(storage: Storage): string | null {
  return storage.getItem(ACTIVE_EDIT_PLAN_STORAGE_KEY);
}
