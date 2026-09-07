import { describe, expect, it } from "vitest";

import type { CreateEditPlanInput } from "../api/edits";
import type { EditPlan } from "./edit";
import {
  createEditPlanRunner,
  isRunnerBusy,
  type EditPlanRunnerDeps,
  type RunnerSnapshot,
} from "./edit-plan-runner";

const PLAN_ID = "11111111-1111-4111-8111-111111111111";

function plan(statuses: readonly EditPlan["items"][number]["status"][] = ["pending"]): EditPlan {
  return {
    id: PLAN_ID,
    created_at: "2026-09-07T00:00:00.000Z",
    expires_at: "2026-09-07T01:00:00.000Z",
    source: "single",
    changes: { comment: "更新" },
    items: statuses.map((status, index) => ({
      before: {
        id: index + 1,
        mode: "payment",
        date: "2026-09-07",
        amount: 100 + index,
        category_id: 1,
        genre_id: 2,
        from_account_id: 3,
        to_account_id: null,
        name: "商品",
        place: "店舗",
        comment: "",
        currency_code: "JPY",
        receipt_id: 4,
      },
      status,
    })),
  };
}

function harness(initial = plan()) {
  const calls = {
    create: [] as CreateEditPlanInput[],
    execute: [] as Array<[string, number]>,
    get: [] as string[],
    reconcile: [] as Array<[string, number]>,
    persisted: [] as Array<string | null>,
    updated: 0,
  };
  const plans = new Map([[initial.id, initial]]);
  const deps: EditPlanRunnerDeps = {
    create: async (input) => {
      calls.create.push(input);
      plans.set(initial.id, initial);
      return initial;
    },
    execute: async (id, transactionId) => {
      calls.execute.push([id, transactionId]);
      return plans.get(id) ?? initial;
    },
    get: async (id) => {
      calls.get.push(id);
      return plans.get(id) ?? initial;
    },
    reconcile: async (id, transactionId) => {
      calls.reconcile.push([id, transactionId]);
      return plans.get(id) ?? initial;
    },
    wait: async () => {},
    persist: (id) => calls.persisted.push(id),
    onUpdated: () => {
      calls.updated += 1;
    },
  };
  return {
    calls,
    deps,
  };
}

describe("EditPlanRunner", () => {
  it("復元に失敗した追跡中の計画は新しい確認用計画の開始を許可しない", async () => {
    const h = harness();
    h.deps.get = async () => {
      throw new Error("通信失敗");
    };
    const runner = createEditPlanRunner(h.deps);

    await runner.restore(PLAN_ID);

    expect(runner.getSnapshot().plan).toBeNull();
    expect(runner.getSnapshot().canStart).toBe(false);
    expect(h.calls.persisted.at(-1)).toBe(PLAN_ID);
  });

  it("取得済みの未送信計画は再取得が失敗しても追跡を終了できる", async () => {
    const h = harness();
    const runner = createEditPlanRunner(h.deps);
    await runner.restore(PLAN_ID);
    h.deps.get = async () => {
      throw new Error("通信失敗");
    };
    await runner.refresh();

    runner.dismiss();

    expect(runner.getSnapshot().phase).toBe("idle");
    expect(runner.getSnapshot().plan).toBeNull();
    expect(h.calls.persisted.at(-1)).toBeNull();
    expect(h.calls.execute).toHaveLength(0);
  });

  it("購読解除後も送信を継続し、成功した計画を settled として保持する", async () => {
    const initial = plan(["pending", "pending"]);
    const h = harness(initial);
    let first = true;
    let resolveFirst!: (value: EditPlan) => void;
    h.deps.execute = async (id, transactionId) => {
      h.calls.execute.push([id, transactionId]);
      if (first) {
        first = false;
        return await new Promise<EditPlan>((resolve) => (resolveFirst = resolve));
      }
      return plan(["succeeded", "succeeded"]);
    };
    const runner = createEditPlanRunner(h.deps);
    const snapshots: RunnerSnapshot[] = [];
    const unsubscribe = runner.subscribe((snapshot) => snapshots.push(snapshot));

    const running = runner.startPlan(initial);
    unsubscribe();
    resolveFirst(plan(["succeeded", "pending"]));
    await running;

    expect(runner.getSnapshot().phase).toBe("settled");
    expect(h.calls.execute).toHaveLength(2);
    expect(runner.getSnapshot().plan?.items[1]?.status).toBe("succeeded");
    expect(snapshots.length).toBeGreaterThan(0);
    expect(h.calls.persisted.at(-1)).toBeNull();
  });

  it("同じタブの二重起動を拒否し、処理中の計画を上書きしない", async () => {
    const h = harness();
    let resolveExecute!: (value: EditPlan) => void;
    h.deps.execute = async (id, transactionId) => {
      h.calls.execute.push([id, transactionId]);
      return await new Promise<EditPlan>((resolve) => (resolveExecute = resolve));
    };
    const runner = createEditPlanRunner(h.deps);

    const first = runner.startPlan(plan());
    expect(isRunnerBusy(runner.getSnapshot())).toBe(true);
    await runner.startPlan(plan(["pending", "pending"]));
    expect(runner.getSnapshot().error).toContain("処理中");
    resolveExecute(plan(["succeeded"]));
    await first;
    expect(h.calls.execute).toHaveLength(1);
  });

  it("停止要求は通信中の応答を取り込み、次の対象を送信しない", async () => {
    const first = plan(["pending", "pending"]);
    const h = harness(first);
    let resolveExecute!: (value: EditPlan) => void;
    h.deps.execute = async (id, transactionId) => {
      h.calls.execute.push([id, transactionId]);
      return await new Promise<EditPlan>((resolve) => (resolveExecute = resolve));
    };
    const runner = createEditPlanRunner(h.deps);
    const running = runner.startPlan(first);
    runner.stop();
    resolveExecute(plan(["succeeded", "pending"]));
    await running;

    expect(h.calls.execute).toHaveLength(1);
    expect(runner.getSnapshot().phase).toBe("paused");
    expect(runner.getSnapshot().plan?.items[0]?.status).toBe("succeeded");
    expect(runner.getSnapshot().plan?.items[1]?.status).toBe("pending");
  });

  it("通信中断時は GET だけで結果を確認し、pending を unknown にして停止する", async () => {
    const h = harness();
    h.deps.execute = async () => {
      throw new Error("network failed");
    };
    h.deps.get = async () => plan(["pending"]);
    const runner = createEditPlanRunner(h.deps);

    await runner.startPlan(plan());

    expect(runner.getSnapshot().phase).toBe("paused");
    expect(h.calls.reconcile).toHaveLength(0);
    expect(runner.getSnapshot().plan?.items[0]?.status).toBe("unknown");
    expect(runner.getSnapshot().phase).toBe("paused");
  });

  it("既知の409は再送もGETもせず、pendingの計画を保持して停止する", async () => {
    const h = harness();
    h.deps.execute = async (id, transactionId) => {
      h.calls.execute.push([id, transactionId]);
      throw Object.assign(new Error("別の編集処理が実行中です"), {
        code: "mutation_busy",
        status: 409,
      });
    };
    const runner = createEditPlanRunner(h.deps);

    await runner.startPlan(plan());

    expect(h.calls.execute).toEqual([[PLAN_ID, 1]]);
    expect(h.calls.get).toHaveLength(0);
    expect(runner.getSnapshot().plan?.items[0]?.status).toBe("pending");
    expect(runner.getSnapshot().phase).toBe("paused");
    expect(runner.getSnapshot().error).toBe("別の編集処理が実行中です");
  });

  it("短時間の非表示は sticky に停止し、復帰だけでは自動再開しない", async () => {
    const first = plan(["pending", "pending"]);
    const h = harness(first);
    let resolveExecute!: (value: EditPlan) => void;
    h.deps.execute = async (id, transactionId) => {
      h.calls.execute.push([id, transactionId]);
      return await new Promise<EditPlan>((resolve) => (resolveExecute = resolve));
    };
    const runner = createEditPlanRunner(h.deps);
    const running = runner.startPlan(first);
    runner.setActivity("画面を離れたため停止しました");
    runner.setActivity(null);
    resolveExecute(plan(["succeeded", "pending"]));
    await running;

    expect(h.calls.execute).toHaveLength(1);
    expect(runner.getSnapshot().phase).toBe("paused");
    expect(runner.getSnapshot().stopReason).toContain("画面を離れた");
    expect(h.calls.execute).toHaveLength(1);
  });

  it("restore は GET のみ実行し、読み込み失敗時も ID を保持する", async () => {
    const h = harness();
    h.deps.get = async (id) => {
      h.calls.get.push(id);
      throw new Error("offline");
    };
    const runner = createEditPlanRunner(h.deps);

    await runner.restore(PLAN_ID);

    expect(runner.getSnapshot().error).toBe("offline");
    expect(h.calls.execute).toHaveLength(0);
    expect(h.calls.persisted.at(-1)).toBe(PLAN_ID);
    runner.dismiss();
    expect(h.calls.persisted.at(-1)).toBe(PLAN_ID);
  });

  it("読み込み失敗中は別の計画で追跡対象を上書きしない", async () => {
    const h = harness();
    h.deps.get = async (id) => {
      h.calls.get.push(id);
      throw new Error("offline");
    };
    const runner = createEditPlanRunner(h.deps);

    await runner.restore(PLAN_ID);
    await runner.restore("22222222-2222-4222-8222-222222222222");

    expect(h.calls.get).toEqual([PLAN_ID]);
    expect(h.calls.persisted.at(-1)).toBe(PLAN_ID);
    expect(runner.getSnapshot().error).toContain("未完了");
  });

  it("startSingle は計画作成から所有し、実行前に計画 ID を永続化する", async () => {
    const h = harness();
    const runner = createEditPlanRunner(h.deps);
    const input = {
      source: "single" as const,
      expected: plan().items[0]!.before,
      changes: { comment: "更新" },
    };

    await runner.startSingle(input);

    expect(h.calls.create).toEqual([input]);
    expect(h.calls.persisted[0]).toBe(PLAN_ID);
  });

  it("resume は結果未確認の項目を再送せず照合要求で停止する", async () => {
    const uncertain = plan(["unknown"]);
    const h = harness(uncertain);
    h.deps.get = async () => uncertain;
    const runner = createEditPlanRunner(h.deps);

    await runner.restore(PLAN_ID);
    await runner.resume();

    expect(h.calls.execute).toHaveLength(0);
    expect(h.calls.reconcile).toHaveLength(0);
    expect(runner.getSnapshot().phase).toBe("paused");
    expect(runner.getSnapshot().stopReason).toContain("照合");
  });

  it("reconcile は GET 後に結果未確認の項目だけを照合し、送信を再開しない", async () => {
    const uncertain = plan(["unknown", "pending"]);
    const reconciled = plan(["succeeded", "pending"]);
    const h = harness(uncertain);
    h.deps.get = async () => uncertain;
    h.deps.reconcile = async (id, transactionId) => {
      h.calls.reconcile.push([id, transactionId]);
      return reconciled;
    };
    const runner = createEditPlanRunner(h.deps);

    await runner.restore(PLAN_ID);
    await runner.reconcile();

    expect(h.calls.execute).toHaveLength(0);
    expect(h.calls.reconcile).toEqual([[PLAN_ID, 1]]);
    expect(h.calls.updated).toBe(1);
    expect(runner.getSnapshot().phase).toBe("paused");
    expect(runner.getSnapshot().plan?.items[1]?.status).toBe("pending");
  });

  it("GET で全件確定した計画は settled として追跡を終了し、一覧更新を通知する", async () => {
    const completed = plan(["succeeded"]);
    const h = harness(completed);
    const runner = createEditPlanRunner(h.deps);

    await runner.restore(PLAN_ID);

    expect(runner.getSnapshot().phase).toBe("settled");
    expect(runner.getSnapshot().plan?.items[0]?.status).toBe("succeeded");
    expect(h.calls.updated).toBe(1);
    expect(h.calls.persisted.at(-1)).toBeNull();
  });

  it("同じ Runner が unknown を保持していると GET の pending で再送可能に戻さない", async () => {
    const uncertain = plan(["unknown"]);
    const h = harness(uncertain);
    const runner = createEditPlanRunner(h.deps);
    await runner.restore(PLAN_ID);
    h.deps.get = async () => plan(["pending"]);
    await runner.refresh();

    expect(runner.getSnapshot().plan?.items[0]?.status).toBe("unknown");
    expect(runner.getSnapshot().phase).toBe("paused");
  });

  it("pending-only の停止計画は dismiss でローカル追跡を終了できる", async () => {
    const h = harness();
    const runner = createEditPlanRunner(h.deps);
    const running = runner.startPlan(plan());
    runner.stop();
    await running;

    runner.dismiss();

    expect(runner.getSnapshot()).toMatchObject({ plan: null, phase: "idle" });
    expect(h.calls.persisted.at(-1)).toBeNull();
  });

  it("結果未確認の計画は dismiss で追跡を解除しない", async () => {
    const uncertain = plan(["unknown"]);
    const h = harness(uncertain);
    const runner = createEditPlanRunner(h.deps);
    await runner.restore(PLAN_ID);

    runner.dismiss();

    expect(runner.getSnapshot().plan?.items[0]?.status).toBe("unknown");
    expect(h.calls.persisted.at(-1)).toBe(PLAN_ID);
  });

  it("新しい単体計画の作成中は、直前の settled 結果を表示しない", async () => {
    const h = harness();
    await createEditPlanRunner(h.deps).startPlan(plan(["succeeded"]));
    let rejectCreate!: (error: Error) => void;
    h.deps.create = async () => await new Promise<EditPlan>((_, reject) => (rejectCreate = reject));
    const runner = createEditPlanRunner(h.deps);
    await runner.startPlan(plan(["succeeded"]));
    const input = {
      source: "single" as const,
      expected: plan().items[0]!.before,
      changes: { comment: "更新" },
    };
    const creation = runner.startSingle(input);
    expect(runner.getSnapshot()).toMatchObject({ plan: null, phase: "creating" });
    rejectCreate(new Error("作成失敗"));
    await creation;
    expect(runner.getSnapshot()).toMatchObject({ plan: null, phase: "idle", error: "作成失敗" });
  });

  it("snapshot と計画を外部から変更できない", async () => {
    const h = harness();
    const runner = createEditPlanRunner(h.deps);
    await runner.startPlan(plan(["succeeded"]));
    const snapshot = runner.getSnapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.plan)).toBe(true);
    expect(Object.isFrozen(snapshot.plan?.items)).toBe(true);
    expect(() => {
      (snapshot as { error: string | null }).error = "改変";
    }).toThrow();
  });
});
