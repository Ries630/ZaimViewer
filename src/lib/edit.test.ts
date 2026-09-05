import { describe, expect, it } from "vitest";

import type { Transaction } from "../api/transactions";
import {
  ACTIVE_EDIT_PLAN_STORAGE_KEY,
  bulkEditableFields,
  changesFromBulk,
  changesFromDraft,
  draftOf,
  editableFields,
  isEditExecutionUncertain,
  isEditSendBlocked,
  previewSnapshot,
  readActivePlanId,
  snapshotOf,
  storeActivePlanId,
  type EditCapabilities,
} from "./edit";

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 42,
    mode: "payment",
    date: "2026-09-05",
    amount: 1200,
    category_id: 10,
    category: "食費",
    genre_id: 11,
    genre: "外食",
    from_account_id: 20,
    from_account: "口座",
    to_account_id: null,
    to_account: null,
    name: "定食",
    place: "食堂",
    comment: "メモ",
    currency_code: "JPY",
    receipt_id: 123,
    ...overrides,
  };
}

const capabilities: EditCapabilities = {
  enabled: true,
  modes: ["payment", "income", "transfer"],
  incomeName: false,
  transfer: false,
};

describe("編集値の組み立て", () => {
  it("snapshot は null の ID と文字列を契約の表現に正規化する", () => {
    expect(snapshotOf(transaction({ category_id: null, name: null }))).toMatchObject({
      category_id: 0,
      name: "",
    });
  });

  it("金額を変更しないときは amount を差分へ入れない", () => {
    const before = snapshotOf(transaction());
    const changes = changesFromDraft(before, draftOf(before));
    expect(changes).toEqual({});
    expect(changes).not.toHaveProperty("amount");
  });

  it("金額の変更とテキストの空文字を差分にする", () => {
    const before = snapshotOf(transaction());
    const draft = { ...draftOf(before), amount: "1300", comment: "" };
    expect(changesFromDraft(before, draft)).toEqual({ amount: 1300, comment: "" });
  });

  it("不正な金額は差分を作らず入力を止める", () => {
    const before = snapshotOf(transaction());
    expect(changesFromDraft(before, { ...draftOf(before), amount: "1.5" })).toBeNull();
    expect(changesFromDraft(before, { ...draftOf(before), amount: "" })).toBeNull();
    expect(changesFromDraft(before, { ...draftOf(before), amount: "1000000000" })).toBeNull();
  });

  it("確認画面の仮状態は変更後の値を表示する", () => {
    const before = snapshotOf(transaction());
    expect(previewSnapshot(before, { comment: "", place: "新しい店" })).toMatchObject({
      comment: "",
      place: "新しい店",
    });
  });

  it("payment の品名は receipt_id があるときだけ単体編集へ出す", () => {
    expect(editableFields("payment", capabilities, 123)).toContain("name");
    expect(editableFields("payment", capabilities, null)).not.toContain("name");
    expect(editableFields("payment", capabilities, 0)).not.toContain("name");
  });

  it("未確認の income の genre/place と transfer の自由文字列を出さない", () => {
    expect(editableFields("income", { ...capabilities, incomeName: true }, null)).toEqual([
      "date",
      "amount",
      "comment",
      "category_id",
      "to_account_id",
      "name",
    ]);
    expect(editableFields("transfer", { ...capabilities, transfer: true }, null)).toEqual([
      "date",
      "amount",
      "comment",
      "from_account_id",
      "to_account_id",
    ]);
  });

  it("一括編集では日付と金額を出さず、チェックした項目だけ送る", () => {
    const fields = bulkEditableFields("payment", capabilities, true);
    expect(fields).not.toContain("date");
    expect(fields).not.toContain("amount");
    const selected = new Set(fields.filter((field) => field === "comment"));
    expect(changesFromBulk(selected, { comment: "" })).toEqual({ comment: "" });
  });

  it("オフラインまたはバックグラウンドでは送信を止める", () => {
    expect(isEditSendBlocked(false, false)).toBe(true);
    expect(isEditSendBlocked(true, true)).toBe(true);
    expect(isEditSendBlocked(true, false)).toBe(false);
  });

  it("送信前に確定するAPIエラーは結果不明にしない", () => {
    expect(isEditExecutionUncertain({ code: "mutation_busy", status: 409 })).toBe(false);
    expect(isEditExecutionUncertain({ code: "plan_expired", status: 409 })).toBe(false);
    expect(isEditExecutionUncertain({ code: "invalid_snapshot", status: 400 })).toBe(false);
    expect(isEditExecutionUncertain({ code: "credentials_missing", status: 503 })).toBe(false);
    expect(isEditExecutionUncertain({ code: "network_error", status: 503 })).toBe(true);
    expect(isEditExecutionUncertain(null)).toBe(true);
  });
});

describe("編集中の計画 ID", () => {
  it("sessionStorage には計画 ID だけ保存し、消去できる", () => {
    const storage = new Map<string, string>();
    const fakeStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    } as Storage;

    storeActivePlanId(fakeStorage, "plan-id");
    expect(readActivePlanId(fakeStorage)).toBe("plan-id");
    expect([...storage.keys()]).toEqual([ACTIVE_EDIT_PLAN_STORAGE_KEY]);
    storeActivePlanId(fakeStorage, null);
    expect(readActivePlanId(fakeStorage)).toBeNull();
  });
});
