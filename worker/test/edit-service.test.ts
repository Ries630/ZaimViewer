/** 編集計画の保存エンジンを外部境界から検証する。 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../src/db";
import { type EditCapabilities, type EditChanges, type EditSnapshot } from "../src/edit-contract";
import { initializeOperations } from "../src/edit-store";
import {
  createEditPlan,
  executeEditItem,
  getEditPlan,
  reconcileEditItem,
  type EditClient,
} from "../src/edit-service";
import { seedDatabase } from "./fixtures";
import type { ZaimMoney } from "../src/zaim";

const CAPABILITIES: EditCapabilities = {
  enabled: true,
  modes: ["payment", "income"],
  incomeName: false,
  transfer: false,
};

/** 支出明細の fixture。ミラーと Zaim の比較対象になる列を全て含める。 */
function paymentSnapshot(): EditSnapshot {
  return {
    id: 1,
    mode: "payment",
    date: "2026-08-01",
    amount: 320,
    category_id: 101,
    genre_id: 1001,
    from_account_id: 12,
    to_account_id: null,
    name: "おにぎり",
    place: "セブンイレブン",
    comment: null,
    currency_code: "JPY",
    receipt_id: 4_200_000_001,
  };
}

/** 実際の Zaim 応答に近い raw を作る。 */
function money(comment: string | null = null): ZaimMoney {
  const result: ZaimMoney = {
    id: 1,
    mode: "payment",
    date: "2026-08-01",
    amount: 320,
    category_id: 101,
    genre_id: 1001,
    from_account_id: 12,
    name: "おにぎり",
    place: "セブンイレブン",
    currency_code: "JPY",
    receipt_id: 4_200_000_001,
    active: 1,
    created: "2026-08-01 09:00:00",
  };
  if (comment !== null) result.comment = comment;
  return result;
}

/** D1 の fixture 行にも同じ snapshot/raw を設定する。 */
async function preparePayment(db: Database): Promise<void> {
  const before = money();
  await db
    .prepare(
      "UPDATE transactions SET currency_code = ?, active = ?, receipt_id = ?, raw = ? WHERE id = 1",
    )
    .bind("JPY", 1, 4_200_000_001, JSON.stringify(before))
    .run();
}

/** 外部通信を行わない固定 Zaim クライアント。 */
class StubClient implements EditClient {
  readonly reads: (ZaimMoney | undefined)[];
  readonly updates: { mode: string; id: number; changes: EditChanges & { amount: number } }[] = [];
  updateError: Error | undefined;

  constructor(...reads: (ZaimMoney | undefined)[]) {
    this.reads = [...reads];
  }

  async moneyById(): Promise<ZaimMoney | undefined> {
    return this.reads.length > 1 ? this.reads.shift() : this.reads[0];
  }

  async updateMoney(
    mode: "payment" | "income" | "transfer",
    id: number,
    changes: EditChanges & { amount: number },
  ): Promise<void> {
    this.updates.push({ mode, id, changes });
    if (this.updateError !== undefined) throw this.updateError;
  }
}

beforeEach(async () => {
  await seedDatabase(env.DB);
  await preparePayment(env.DB);
  await initializeOperations(env.DB);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mutation_gate"),
    env.DB.prepare("DELETE FROM edit_plans"),
  ]);
});

describe("createEditPlan", () => {
  it("ミラーと snapshot が一致した対象を pending 計画として保存する", async () => {
    const plan = await createEditPlan(
      env.DB,
      [paymentSnapshot()],
      { comment: "更新メモ" },
      "single",
      CAPABILITIES,
    );

    expect(plan.id).toMatch(/[0-9a-f-]{36}/);
    expect(plan.items[0]).toMatchObject({ before: paymentSnapshot(), status: "pending" });
    const loaded = await getEditPlan(env.DB, plan.id);
    expect(JSON.stringify(loaded)).not.toContain("beforeRaw");
  });

  it("表示時 snapshot が古ければ計画を保存しない", async () => {
    const stale = { ...paymentSnapshot(), amount: 321 };

    await expect(
      createEditPlan(env.DB, [stale], { comment: "更新" }, "single", CAPABILITIES),
    ).rejects.toMatchObject({ code: "stale_snapshot" });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM edit_plans").first<{ count: number }>(),
    ).resolves.toMatchObject({ count: 0 });
  });

  it("一括編集で種別を混ぜず、空の変更を拒否する", async () => {
    await expect(
      createEditPlan(
        env.DB,
        [paymentSnapshot(), { ...paymentSnapshot(), id: 6, mode: "income" }],
        { comment: "更新" },
        "filter",
        CAPABILITIES,
      ),
    ).rejects.toMatchObject({ code: "mixed_modes" });
    await expect(
      createEditPlan(env.DB, [paymentSnapshot()], {}, "single", CAPABILITIES),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe("executeEditItem", () => {
  it("未変更の非表示列が更新後に変われば結果不明でミラーを保つ", async () => {
    const plan = await createEditPlan(
      env.DB,
      [paymentSnapshot()],
      { comment: "更新メモ" },
      "single",
      CAPABILITIES,
    );
    const client = new StubClient(
      { ...money(), place_uid: "before" },
      { ...money("更新メモ"), place_uid: "after" },
    );
    const result = await executeEditItem(env.DB, client, plan.id, 1, CAPABILITIES);
    expect(result.items[0]?.status).toBe("unknown");
    expect(
      await env.DB.prepare("SELECT comment FROM transactions WHERE id = 1").first(),
    ).toMatchObject({ comment: null });
    await expect(executeEditItem(env.DB, client, plan.id, 1, CAPABILITIES)).rejects.toMatchObject({
      code: "reconcile_required",
    });
    expect(client.updates).toHaveLength(1);
  });

  it("Zaim確認後のD1失敗を照合だけで修復し更新を再送しない", async () => {
    const plan = await createEditPlan(
      env.DB,
      [paymentSnapshot()],
      { comment: "更新メモ" },
      "single",
      CAPABILITIES,
    );
    await env.DB.prepare(
      "CREATE TRIGGER reject_edit BEFORE UPDATE ON transactions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    ).run();
    const client = new StubClient(money(), money("更新メモ"));
    try {
      const result = await executeEditItem(env.DB, client, plan.id, 1, CAPABILITIES);
      expect(result.items[0]?.status).toBe("mirror_pending");
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_edit").run();
    }
    const reader = new StubClient(money("更新メモ"));
    expect((await reconcileEditItem(env.DB, reader, plan.id, 1)).items[0]?.status).toBe(
      "succeeded",
    );
    expect(reader.updates).toHaveLength(0);
    expect(client.updates).toHaveLength(1);
  });

  it("照合元rawを失った計画は成功扱いにしない", async () => {
    const plan = await createEditPlan(
      env.DB,
      [paymentSnapshot()],
      { comment: "更新メモ" },
      "single",
      CAPABILITIES,
    );
    const client = new StubClient(money());
    client.updateError = new Error("fixture failure");
    await executeEditItem(env.DB, client, plan.id, 1, CAPABILITIES);
    await env.DB.prepare(
      "UPDATE edit_plans SET payload = json_remove(payload, '$.items[0].beforeRaw') WHERE id = ?",
    )
      .bind(plan.id)
      .run();
    const reader = new StubClient(money("更新メモ"));
    expect((await reconcileEditItem(env.DB, reader, plan.id, 1)).items[0]?.status).toBe("unknown");
    expect(reader.updates).toHaveLength(0);
  });

  it("最新値を比較して amount を必ず含め、readback をミラーへ反映する", async () => {
    const plan = await createEditPlan(
      env.DB,
      [paymentSnapshot()],
      { comment: "更新メモ" },
      "single",
      CAPABILITIES,
    );
    const client = new StubClient(money(), money("更新メモ"));

    const result = await executeEditItem(env.DB, client, plan.id, 1, CAPABILITIES);

    expect(result.items[0]).toMatchObject({ status: "succeeded", after: { comment: "更新メモ" } });
    expect(client.updates).toEqual([
      {
        mode: "payment",
        id: 1,
        changes: { comment: "更新メモ", amount: 320 },
      },
    ]);
    await expect(
      env.DB.prepare("SELECT comment, raw FROM transactions WHERE id = 1").first(),
    ).resolves.toMatchObject({ comment: "更新メモ", raw: JSON.stringify(money("更新メモ")) });

    const retry = await executeEditItem(env.DB, client, plan.id, 1, CAPABILITIES);
    expect(retry.items[0]?.status).toBe("succeeded");
    expect(client.updates).toHaveLength(1);
  });

  it("外部更新の結果不明を unknown にして、再送せず照合を要求する", async () => {
    const plan = await createEditPlan(
      env.DB,
      [paymentSnapshot()],
      { comment: "更新メモ" },
      "single",
      CAPABILITIES,
    );
    const client = new StubClient(money());
    client.updateError = new Error("private API body");

    const unknown = await executeEditItem(env.DB, client, plan.id, 1, CAPABILITIES);
    expect(unknown.items[0]).toMatchObject({ status: "unknown" });
    expect(JSON.stringify(unknown)).not.toContain("private API body");
    await expect(
      createEditPlan(env.DB, [paymentSnapshot()], { comment: "別の変更" }, "single", CAPABILITIES),
    ).rejects.toMatchObject({ code: "unresolved_plan" });

    const reconciledClient = new StubClient(money("更新メモ"));
    const reconciled = await reconcileEditItem(env.DB, reconciledClient, plan.id, 1);
    expect(reconciled.items[0]?.status).toBe("succeeded");
    expect(reconciledClient.updates).toHaveLength(0);
  });

  it("確認後に Zaim 側で値が変わっていれば failed として更新しない", async () => {
    const plan = await createEditPlan(
      env.DB,
      [paymentSnapshot()],
      { comment: "更新メモ" },
      "single",
      CAPABILITIES,
    );
    const changed = { ...money(), amount: 999 };
    const client = new StubClient(changed);

    const result = await executeEditItem(env.DB, client, plan.id, 1, CAPABILITIES);
    expect(result.items[0]).toMatchObject({
      status: "failed",
      message: expect.stringContaining("変更"),
    });
    expect(client.updates).toHaveLength(0);
  });
});
