/** receipt_id 後付け処理の再開・canary・rollback を公開境界から検証する。 */

import { describe, expect, it } from "vitest";

import {
  applyReceiptIdBackfill,
  rollbackIncomeReceiptIdBackfill,
  rollbackReceiptIdBackfill,
  runReceiptIdBackfillCanary,
  type ReceiptIdBackfillClient,
} from "../src/receipt-id-backfill-runner";
import { createReceiptIdBackfillManifest } from "../src/receipt-id-backfill";
import type { ReceiptIdUpdateMode, ZaimMoney } from "../src/zaim";

/** 固定件数を満たす移行前明細を作る。 */
function createMoney(): ZaimMoney[] {
  return [
    ...Array.from({ length: 1080 }, (_, index) => ({
      id: 10_000 + index,
      mode: "payment",
      date: "2026-04-01",
      amount: 100 + index,
      name: `支出 ${index}`,
      receipt_id: 0,
    })),
    ...Array.from({ length: 60 }, (_, index) => ({
      id: 20_000 + index,
      mode: "income",
      date: "2026-03-01",
      amount: 10_000 + index,
      name: `収入 ${index}`,
      receipt_id: 0,
    })),
  ];
}

/** 配列の要素が存在することをテスト内で明示する。 */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("期待したテスト値がない");
  return value;
}

/** Zaim API の状態変更をメモリ上で再現する。 */
class MemoryClient implements ReceiptIdBackfillClient {
  readonly money: ZaimMoney[];
  readonly updates: { id: number; amount: number; receiptId: number }[] = [];
  failAtUpdate: number | undefined;
  throwAfterUpdate = false;
  mutatePlaceUid = false;
  mutatePlaceUidOnReset = false;
  amountOnNextLookup: number | undefined;
  dateOnNextLookup: string | undefined;

  /** @param money 初期状態。 */
  constructor(money: ZaimMoney[]) {
    this.money = structuredClone(money);
  }

  /** @yields 現在の全明細。 */
  async *iterMoney(): AsyncGenerator<ZaimMoney[]> {
    yield structuredClone(this.money);
  }

  /** ID と現在日で最新明細を取得する。 */
  async moneyById(
    mode: ReceiptIdUpdateMode,
    id: number,
    date: string,
  ): Promise<ZaimMoney | undefined> {
    const target = this.money.find((item) => item.id === id && item.mode === mode);
    if (target && this.dateOnNextLookup !== undefined) {
      target.date = this.dateOnNextLookup;
      this.dateOnNextLookup = undefined;
    }
    if (target && this.amountOnNextLookup !== undefined) {
      target.amount = this.amountOnNextLookup;
      this.amountOnNextLookup = undefined;
    }
    return target?.date === date ? structuredClone(target) : undefined;
  }

  /** メモリ上の receipt_id を更新する。 */
  async updateReceiptId(
    mode: ReceiptIdUpdateMode,
    id: number,
    amount: number,
    receiptId: number,
  ): Promise<void> {
    if (this.failAtUpdate === this.updates.length + 1) throw new Error("意図した途中失敗");
    const target = this.money.find((item) => item.id === id && item.mode === mode);
    if (!target) throw new Error("対象がない");
    if (target.amount !== amount) throw new Error("古い amount が送られた");
    target.receipt_id = receiptId;
    if (this.mutatePlaceUid && receiptId !== 0) target.place_uid = "changed";
    if (this.mutatePlaceUidOnReset && receiptId === 0) target.place_uid = "changed";
    this.updates.push({ id, amount, receiptId });
    if (this.throwAfterUpdate && receiptId !== 0) throw new Error("応答だけ失敗");
  }
}

const NO_WAIT = async (): Promise<void> => {};

describe("applyReceiptIdBackfill", () => {
  it("支出だけに計画値を適用し、収入は receipt_id 0 のままにする", async () => {
    const original = createMoney();
    const manifest = createReceiptIdBackfillManifest(original, "2026-09-02T00:00:00.000Z");
    const client = new MemoryClient(original);

    const result = await applyReceiptIdBackfill(client, manifest, { wait: NO_WAIT });

    expect(result).toEqual({ newlyApplied: 1080, alreadyApplied: 0 });
    expect(
      client.money
        .filter(({ mode }) => mode === "payment")
        .every(({ receipt_id }) => receipt_id !== 0),
    ).toBe(true);
    expect(
      client.money
        .filter(({ mode }) => mode === "income")
        .every(({ receipt_id }) => receipt_id === 0),
    ).toBe(true);
  });

  it("途中失敗後は適用済みを飛ばして残りから再開する", async () => {
    const original = createMoney();
    const manifest = createReceiptIdBackfillManifest(original, "2026-09-02T00:00:00.000Z");
    const client = new MemoryClient(original);
    client.failAtUpdate = 3;

    await expect(applyReceiptIdBackfill(client, manifest, { wait: NO_WAIT })).rejects.toThrow(
      "意図した途中失敗",
    );
    expect(client.updates).toHaveLength(2);

    client.failAtUpdate = undefined;
    const result = await applyReceiptIdBackfill(client, manifest, { wait: NO_WAIT });

    expect(result.newlyApplied).toBe(1078);
    expect(result.alreadyApplied).toBe(2);
    expect(client.updates).toHaveLength(1080);
  });

  it("更新直前に取り直した amount を送る", async () => {
    const original = createMoney();
    const manifest = createReceiptIdBackfillManifest(original, "2026-09-02T00:00:00.000Z");
    const client = new MemoryClient(original);
    client.amountOnNextLookup = 999_999;

    await applyReceiptIdBackfill(client, manifest, { wait: NO_WAIT });

    expect(required(client.updates[0]).amount).toBe(999_999);
  });

  it("直前取得で対象が見つからなければ古い amount を送らない", async () => {
    const original = createMoney();
    const manifest = createReceiptIdBackfillManifest(original, "2026-09-02T00:00:00.000Z");
    const client = new MemoryClient(original);
    client.dateOnNextLookup = "2026-04-02";

    await expect(applyReceiptIdBackfill(client, manifest, { wait: NO_WAIT })).rejects.toThrow(
      "更新直前の明細 10000 (payment) を取得できない",
    );
    expect(client.updates).toHaveLength(0);
  });
});

describe("runReceiptIdBackfillCanary", () => {
  it("支出 1 件を計画値へ更新して検証後に 0 へ戻す", async () => {
    const original = createMoney();
    const manifest = createReceiptIdBackfillManifest(original, "2026-09-02T00:00:00.000Z");
    const client = new MemoryClient(original);

    const entry = await runReceiptIdBackfillCanary(client, manifest);

    expect(entry.mode).toBe("payment");
    expect(client.updates).toEqual([
      { id: entry.id, amount: required(original[0]).amount, receiptId: entry.receiptId },
      { id: entry.id, amount: required(original[0]).amount, receiptId: 0 },
    ]);
    expect(required(client.money[0])).toEqual(required(original[0]));
  });

  it("別の列の変化を検出しても receipt_id は 0 へ戻す", async () => {
    const original = createMoney();
    const manifest = createReceiptIdBackfillManifest(original, "2026-09-02T00:00:00.000Z");
    const client = new MemoryClient(original);
    client.mutatePlaceUid = true;

    await expect(runReceiptIdBackfillCanary(client, manifest)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.some(
          (cause) =>
            cause instanceof Error && cause.message === "receipt_id 以外の列 place_uid も変化した",
        ),
    );
    expect(required(client.money[0]).receipt_id).toBe(0);
  });

  it("更新応答が失敗しても API 上で反映済みなら 0 へ戻す", async () => {
    const original = createMoney();
    const manifest = createReceiptIdBackfillManifest(original, "2026-09-02T00:00:00.000Z");
    const client = new MemoryClient(original);
    client.throwAfterUpdate = true;

    await expect(runReceiptIdBackfillCanary(client, manifest)).rejects.toThrow("応答だけ失敗");
    expect(required(client.money[0]).receipt_id).toBe(0);
    expect(client.updates.map(({ receiptId }) => receiptId)).toEqual([
      required(manifest.entries[0]).receiptId,
      0,
    ]);
  });

  it("計画値が既に残っていれば別の明細で続行しない", async () => {
    const original = createMoney();
    const manifest = createReceiptIdBackfillManifest(original, "2026-09-02T00:00:00.000Z");
    const client = new MemoryClient(original);
    required(client.money[0]).receipt_id = required(manifest.entries[0]).receiptId;

    await expect(runReceiptIdBackfillCanary(client, manifest)).rejects.toThrow(
      "canary 前に計画値が 1 件適用済み（先に rollback する）",
    );
    expect(client.updates).toHaveLength(0);
  });
});

describe("rollbackReceiptIdBackfill", () => {
  it("収入だけを 0 に戻し、支出の計画値は維持する", async () => {
    const original = createMoney();
    const manifest = createReceiptIdBackfillManifest(original, "2026-09-02T00:00:00.000Z");
    const client = new MemoryClient(original);
    for (const entry of manifest.entries) {
      const target = client.money.find(({ id, mode }) => id === entry.id && mode === entry.mode);
      if (!target) throw new Error("テストデータが不正");
      target.receipt_id = entry.receiptId;
    }

    const count = await rollbackIncomeReceiptIdBackfill(client, manifest, { wait: NO_WAIT });

    expect(count).toBe(60);
    expect(client.updates).toHaveLength(60);
    expect(client.updates.every(({ receiptId }) => receiptId === 0)).toBe(true);
    expect(
      client.money
        .filter(({ mode }) => mode === "payment")
        .every(({ receipt_id }) => receipt_id !== 0),
    ).toBe(true);
    expect(
      client.money
        .filter(({ mode }) => mode === "income")
        .every(({ receipt_id }) => receipt_id === 0),
    ).toBe(true);

    await expect(
      rollbackIncomeReceiptIdBackfill(client, manifest, { wait: NO_WAIT }),
    ).resolves.toBe(0);
    expect(client.updates).toHaveLength(60);
  });

  it("収入の復元時に receipt_id 以外の列も変われば中断する", async () => {
    const original = createMoney();
    const manifest = createReceiptIdBackfillManifest(original, "2026-09-02T00:00:00.000Z");
    const income = manifest.entries.find(({ mode }) => mode === "income");
    if (!income) throw new Error("テストデータが不正");
    const client = new MemoryClient(original);
    const target = client.money.find(({ id, mode }) => id === income.id && mode === income.mode);
    if (!target) throw new Error("テストデータが不正");
    target.receipt_id = income.receiptId;
    client.mutatePlaceUidOnReset = true;

    await expect(
      rollbackIncomeReceiptIdBackfill(client, manifest, { wait: NO_WAIT }),
    ).rejects.toThrow("receipt_id 以外の列 place_uid も変化した");
    expect(client.updates).toHaveLength(1);
  });

  it("計画値が付いた明細だけを 0 に戻す", async () => {
    const original = createMoney();
    const manifest = createReceiptIdBackfillManifest(original, "2026-09-02T00:00:00.000Z");
    const client = new MemoryClient(original);
    required(client.money[0]).receipt_id = required(manifest.entries[0]).receiptId;
    required(client.money[1]).receipt_id = required(manifest.entries[1]).receiptId;

    const count = await rollbackReceiptIdBackfill(client, manifest, { wait: NO_WAIT });

    expect(count).toBe(2);
    expect(client.updates.map(({ receiptId }) => receiptId)).toEqual([0, 0]);
    expect(client.money.every(({ receipt_id: receiptId }) => receiptId === 0)).toBe(true);
  });

  it("rollback も更新直前に取り直した amount を送る", async () => {
    const original = createMoney();
    const manifest = createReceiptIdBackfillManifest(original, "2026-09-02T00:00:00.000Z");
    const client = new MemoryClient(original);
    required(client.money[0]).receipt_id = required(manifest.entries[0]).receiptId;
    client.amountOnNextLookup = 777_777;

    await rollbackReceiptIdBackfill(client, manifest, { wait: NO_WAIT });

    expect(required(client.updates[0]).amount).toBe(777_777);
  });

  it("未適用項目が削除・変更されても適用済みだけを戻す", async () => {
    const original = createMoney();
    const manifest = createReceiptIdBackfillManifest(original, "2026-09-02T00:00:00.000Z");
    const client = new MemoryClient(original);
    required(client.money[0]).receipt_id = required(manifest.entries[0]).receiptId;
    client.money.splice(1, 1);
    required(client.money[1]).name = "dry-run 後に変更";

    const count = await rollbackReceiptIdBackfill(client, manifest, { wait: NO_WAIT });

    expect(count).toBe(1);
    expect(required(client.money[0]).receipt_id).toBe(0);
  });
});
