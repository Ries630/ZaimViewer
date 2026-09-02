/** receipt_id 後付け計画の対象選択と再開判定を検証する。 */

import { describe, expect, it } from "vitest";

import {
  BACKFILL_RECEIPT_ID_BASE,
  createReceiptIdBackfillManifest,
  parseReceiptIdBackfillManifest,
  reconcileReceiptIdBackfill,
  verifyOnlyReceiptIdChanged,
} from "../src/receipt-id-backfill";
import type { ZaimMoney } from "../src/zaim";

/** 固定件数を満たす本番相当のテスト明細を作る。 */
function createMoney(): ZaimMoney[] {
  const payments = Array.from({ length: 1080 }, (_, index) => ({
    id: 2_000 + index * 2,
    mode: "payment",
    date: "2026-04-01",
    amount: 100 + index,
    name: `支出 ${index}`,
    receipt_id: 0,
  }));
  const incomes = Array.from({ length: 60 }, (_, index) => ({
    id: 1_001 + index * 2,
    mode: "income",
    date: "2026-03-01",
    amount: 10_000 + index,
    name: `収入 ${index}`,
    receipt_id: 0,
  }));
  return [
    ...payments,
    ...incomes,
    {
      id: 1,
      mode: "transfer",
      date: "2026-03-12",
      amount: 4000,
      name: "Amazonギフトカード チャージタイプ",
      receipt_id: 0,
    },
    {
      id: 3,
      mode: "payment",
      date: "2026-05-01",
      amount: 300,
      name: "既に品目入力",
      receipt_id: 1_780_000_000,
    },
  ];
}

/** 配列の要素が存在することをテスト内で明示する。 */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("期待したテスト値がない");
  return value;
}

describe("createReceiptIdBackfillManifest", () => {
  it("支出 1,080 件と収入 60 件だけを ID 順に採番する", () => {
    const manifest = createReceiptIdBackfillManifest(createMoney(), "2026-09-02T00:00:00.000Z");

    expect(manifest.version).toBe(1);
    expect(manifest.entries).toHaveLength(1140);
    expect(manifest.entries[0]).toMatchObject({
      id: 1_001,
      mode: "income",
      receiptId: BACKFILL_RECEIPT_ID_BASE,
    });
    expect(manifest.entries.at(-1)).toMatchObject({
      id: 4_158,
      mode: "payment",
      receiptId: BACKFILL_RECEIPT_ID_BASE + 1139,
    });
    expect(manifest.entries.some(({ id }) => id === 1)).toBe(false);
  });

  it("対象件数が本番の固定集合と違えば中断する", () => {
    const money = createMoney().filter(({ id }) => id !== 2_000);

    expect(() => createReceiptIdBackfillManifest(money, "2026-09-02T00:00:00.000Z")).toThrow(
      "payment の対象件数が不一致: 期待 1080、実際 1079",
    );
  });

  it("採番予定域が既存明細に使われていれば中断する", () => {
    const money = createMoney();
    money.push({
      id: 9_999,
      mode: "payment",
      date: "2026-09-01",
      amount: 100,
      receipt_id: BACKFILL_RECEIPT_ID_BASE + 10,
    });

    expect(() => createReceiptIdBackfillManifest(money, "2026-09-02T00:00:00.000Z")).toThrow(
      `採番予定の receipt_id ${BACKFILL_RECEIPT_ID_BASE + 10} は明細 9999 で使用済み`,
    );
  });
});

describe("reconcileReceiptIdBackfill", () => {
  it("適用済みを飛ばし、未適用には API から取り直した amount を渡す", () => {
    const original = createMoney();
    const manifest = createReceiptIdBackfillManifest(original, "2026-09-02T00:00:00.000Z");
    const current = structuredClone(original);
    const first = required(manifest.entries[0]);
    const second = required(manifest.entries[1]);
    const applied = current.find(({ id, mode }) => id === first.id && mode === first.mode);
    const pending = current.find(({ id, mode }) => id === second.id && mode === second.mode);
    if (!applied || !pending) throw new Error("テストデータが不正");
    applied.receipt_id = first.receiptId;
    pending.amount = 98_765;

    const result = reconcileReceiptIdBackfill(manifest, current);

    expect(result.applied).toEqual([first]);
    expect(result.pending[0]).toMatchObject({ entry: second, amount: 98_765 });
    expect(result.pending).toHaveLength(1139);
  });

  it("確認後に対象の品名か日付が変わっていれば古い manifest として中断する", () => {
    const current = createMoney();
    const manifest = createReceiptIdBackfillManifest(current, "2026-09-02T00:00:00.000Z");
    const target = current.find(({ id }) => id === required(manifest.entries[0]).id);
    if (!target) throw new Error("テストデータが不正");
    target.name = "確認後に変更された品名";

    expect(() => reconcileReceiptIdBackfill(manifest, current)).toThrow(
      `明細 ${target.id} は dry-run 後に変更されているため中断`,
    );
  });

  it("計画外の receipt_id が付いていれば上書きせず中断する", () => {
    const current = createMoney();
    const manifest = createReceiptIdBackfillManifest(current, "2026-09-02T00:00:00.000Z");
    const target = current.find(({ id }) => id === required(manifest.entries[0]).id);
    if (!target) throw new Error("テストデータが不正");
    target.receipt_id = 123;

    expect(() => reconcileReceiptIdBackfill(manifest, current)).toThrow(
      `明細 ${target.id} の receipt_id は 0 でも計画値でもない: 123`,
    );
  });

  it("採番が書き換えられた manifest は中断する", () => {
    const current = createMoney();
    const manifest = createReceiptIdBackfillManifest(current, "2026-09-02T00:00:00.000Z");
    required(manifest.entries[10]).receiptId += 1;

    expect(() => reconcileReceiptIdBackfill(manifest, current)).toThrow(
      `manifest の 11 件目の receipt_id が不正`,
    );
  });
});

describe("parseReceiptIdBackfillManifest", () => {
  it("JSON 由来の正しい manifest を検証して返す", () => {
    const manifest = createReceiptIdBackfillManifest(createMoney(), "2026-09-02T00:00:00.000Z");

    expect(parseReceiptIdBackfillManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });

  it("mode などの形式が壊れた manifest を拒否する", () => {
    const manifest = createReceiptIdBackfillManifest(createMoney(), "2026-09-02T00:00:00.000Z");
    const invalid = { ...manifest, entries: [{ ...manifest.entries[0], mode: "transfer" }] };

    expect(() => parseReceiptIdBackfillManifest(invalid)).toThrow(
      "receipt_id backfill manifest の形式が不正",
    );
  });
});

describe("verifyOnlyReceiptIdChanged", () => {
  it("receipt_id だけが予定値なら通す", () => {
    const before = required(createMoney()[0]);
    const after = { ...before, receipt_id: BACKFILL_RECEIPT_ID_BASE };

    expect(() => verifyOnlyReceiptIdChanged(before, after, BACKFILL_RECEIPT_ID_BASE)).not.toThrow();
  });

  it("place_uid など別の列まで変われば中断する", () => {
    const before = { ...required(createMoney()[0]), place_uid: "before" };
    const after = { ...before, receipt_id: BACKFILL_RECEIPT_ID_BASE, place_uid: "after" };

    expect(() => verifyOnlyReceiptIdChanged(before, after, BACKFILL_RECEIPT_ID_BASE)).toThrow(
      "receipt_id 以外の列 place_uid も変化した",
    );
  });
});
