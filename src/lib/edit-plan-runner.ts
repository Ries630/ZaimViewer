/** 編集計画の逐次実行を UI のライフサイクルから分離する。 */

import type { CreateEditPlanInput } from "../api/edits";
import {
  EDIT_INTERVAL_MS,
  isEditExecutionUncertain,
  isEditPlanSettled,
  type EditExecutionError,
  type EditPlan,
} from "./edit";

/** 編集処理の表示段階。 */
export type RunnerPhase =
  | "idle"
  | "loading"
  | "creating"
  | "running"
  | "stopping"
  | "paused"
  | "reconciling"
  | "settled";

/** Runner が公開するスナップショット。 */
export interface RunnerSnapshot {
  /** 未完了の追跡を上書きせず、新しい確認・保存を始められるか。 */
  readonly canStart: boolean;
  /** 現在追跡している計画。 */
  readonly plan: EditPlan | null;
  /** 現在の処理段階。 */
  readonly phase: RunnerPhase;
  /** 利用者へ表示するエラー。 */
  readonly error: string | null;
  /** 停止理由。明示停止・端末状態による停止を区別する。 */
  readonly stopReason: string | null;
}

/** Runner の API 境界。 */
export interface EditPlanRunner {
  getSnapshot(this: void): RunnerSnapshot;
  subscribe(this: void, listener: (snapshot: RunnerSnapshot) => void): () => void;
  startPlan(this: void, plan: EditPlan): Promise<void>;
  startSingle(this: void, input: CreateEditPlanInput): Promise<void>;
  resume(this: void): Promise<void>;
  reconcile(this: void): Promise<void>;
  refresh(this: void): Promise<void>;
  restore(this: void, id: string): Promise<void>;
  stop(this: void): void;
  setActivity(this: void, reason: string | null): void;
  dismiss(this: void): void;
}

/** Worker/API 境界を差し替えるための依存。 */
export interface EditPlanRunnerDeps {
  create(input: CreateEditPlanInput): Promise<EditPlan>;
  execute(id: string, transactionId: number): Promise<EditPlan>;
  get(id: string): Promise<EditPlan>;
  reconcile(id: string, transactionId: number): Promise<EditPlan>;
  wait(ms: number): Promise<void>;
  persist(id: string | null): void;
  onUpdated(): void;
}

/** 実行中か判定する。 */
export function isRunnerBusy(snapshot: Pick<RunnerSnapshot, "phase">): boolean {
  return (
    snapshot.phase === "creating" ||
    snapshot.phase === "loading" ||
    snapshot.phase === "running" ||
    snapshot.phase === "stopping" ||
    snapshot.phase === "reconciling"
  );
}

type UncertainStatus = "sending" | "unknown" | "mirror_pending";

const UNCERTAIN_STATUSES: readonly UncertainStatus[] = ["sending", "unknown", "mirror_pending"];

const EMPTY_SNAPSHOT: RunnerSnapshot = Object.freeze({
  canStart: true,
  plan: null,
  phase: "idle",
  error: null,
  stopReason: null,
});

function isUncertainStatus(status: EditPlan["items"][number]["status"]): status is UncertainStatus {
  return UNCERTAIN_STATUSES.some((candidate) => candidate === status);
}

function hasUncertainItems(plan: EditPlan): boolean {
  return plan.items.some((item) => isUncertainStatus(item.status));
}

function hasPendingItems(plan: EditPlan): boolean {
  return plan.items.some((item) => item.status === "pending");
}

function isPendingOnly(plan: EditPlan): boolean {
  return plan.items.every(
    (item) => item.status === "pending" || item.status === "succeeded" || item.status === "failed",
  );
}

function clonePlan(plan: EditPlan): EditPlan {
  return {
    ...plan,
    changes: { ...plan.changes },
    items: plan.items.map((item) => ({
      ...item,
      before: { ...item.before },
      ...(item.after ? { after: { ...item.after } } : {}),
    })),
  };
}

function immutablePlan(plan: EditPlan): EditPlan {
  const copy = clonePlan(plan);
  Object.freeze(copy.changes);
  for (const item of copy.items) {
    Object.freeze(item.before);
    if (item.after) Object.freeze(item.after);
    Object.freeze(item);
  }
  Object.freeze(copy.items);
  return Object.freeze(copy);
}

/** 同じ Runner が把握していた不確かな状態を、GET の pending で上書きしない。 */
function mergeLoadedPlan(previous: EditPlan | null, loaded: EditPlan): EditPlan {
  if (previous?.id !== loaded.id) return loaded;
  return {
    ...loaded,
    items: loaded.items.map((item) => {
      const previousItem = previous.items.find(
        (candidate) => candidate.before.id === item.before.id,
      );
      if (!previousItem || item.status !== "pending" || !isUncertainStatus(previousItem.status)) {
        return item;
      }
      return {
        ...item,
        status: previousItem.status,
        ...(previousItem.message ? { message: previousItem.message } : {}),
        ...(previousItem.after ? { after: previousItem.after } : {}),
      };
    }),
  };
}

function messageOf(error: Error | null, fallback: string): string {
  return error !== null && error.message !== "" ? error.message : fallback;
}

function executionErrorOf(error: Error | null): EditExecutionError | null {
  if (error === null || !("code" in error) || !("status" in error)) return null;
  // SAFETY: API のエラー型だけが持つ code/status を、Error であることを確認して参照する。
  const apiError = error as Error & { code: string; status: number };
  return { code: apiError.code, status: apiError.status };
}

function markUnknown(plan: EditPlan, transactionId: number, message: string): EditPlan {
  const target = plan.items.find((item) => item.before.id === transactionId);
  if (!target || target.status !== "pending") return plan;
  return {
    ...plan,
    items: plan.items.map((item) =>
      item.before.id === transactionId ? { ...item, status: "unknown", message } : item,
    ),
  };
}

/** 編集計画 Runner を作成する。 */
export function createEditPlanRunner(deps: EditPlanRunnerDeps): EditPlanRunner {
  let snapshot: RunnerSnapshot = EMPTY_SNAPSHOT;
  const listeners = new Set<(next: RunnerSnapshot) => void>();
  let generation = 0;
  let activeRun: number | null = null;
  let trackedId: string | null = null;
  let loadFailed = false;
  let stopRequested = false;
  let activityReason: string | null = null;
  let lastStopReason: string | null = null;

  function notify(next: RunnerSnapshot): void {
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        // 表示側の購読者の例外で、送信処理まで止めない。
      }
    }
  }

  function update(next: Partial<RunnerSnapshot>): void {
    const nextPlan =
      next.plan === undefined
        ? snapshot.plan
        : next.plan === null
          ? null
          : immutablePlan(next.plan);
    const phase = next.phase ?? snapshot.phase;
    snapshot = Object.freeze({
      canStart:
        !isRunnerBusy({ phase }) &&
        trackedId === null &&
        (nextPlan === null || isEditPlanSettled(nextPlan)),
      plan: nextPlan,
      phase,
      error: next.error === undefined ? snapshot.error : next.error,
      stopReason: next.stopReason === undefined ? snapshot.stopReason : next.stopReason,
    });
    notify(snapshot);
  }

  function safePersist(id: string | null): void {
    try {
      deps.persist(id);
    } catch {
      // 保存先が使えなくても、同じタブ内の Runner は処理を継続する。
    }
  }

  function safeUpdated(): void {
    try {
      deps.onUpdated();
    } catch {
      // 一覧の再取得に失敗しても、編集計画の状態は保持する。
    }
  }

  function notifyNewSucceeded(previous: EditPlan | null, loaded: EditPlan): void {
    for (const item of loaded.items) {
      if (item.status !== "succeeded") continue;
      const before = previous?.items.find((candidate) => candidate.before.id === item.before.id);
      if (before?.status !== "succeeded") safeUpdated();
    }
  }

  function isRunCurrent(token: number): boolean {
    return activeRun === token && generation === token;
  }

  function release(token: number): void {
    if (isRunCurrent(token)) activeRun = null;
  }

  function setSettled(token: number, plan: EditPlan): void {
    if (!isRunCurrent(token)) return;
    trackedId = null;
    loadFailed = false;
    stopRequested = false;
    safePersist(null);
    update({ plan, phase: "settled", error: null, stopReason: null });
    release(token);
  }

  function setPaused(
    token: number,
    plan: EditPlan | null,
    reason: string | null = null,
    error: string | null = null,
  ): void {
    if (!isRunCurrent(token)) return;
    update({ plan, phase: "paused", error, stopReason: reason });
    release(token);
  }

  function planFromSnapshot(): EditPlan | null {
    return snapshot.plan;
  }

  function rejectBusy(): void {
    update({ error: "別の編集計画を処理中です" });
  }

  function rejectUnresolved(): void {
    update({ error: "未完了の編集計画があります。先に再開または照合してください" });
  }

  function canStartNewPlan(): boolean {
    if (isRunnerBusy(snapshot)) {
      rejectBusy();
      return false;
    }
    if (snapshot.plan !== null && !isEditPlanSettled(snapshot.plan)) {
      rejectUnresolved();
      return false;
    }
    if (loadFailed && trackedId !== null) {
      rejectUnresolved();
      return false;
    }
    if (activityReason !== null) {
      update({ error: activityReason });
      return false;
    }
    return true;
  }

  function begin(tokenPhase: RunnerPhase, clearPlan = false): number {
    const token = generation + 1;
    generation = token;
    activeRun = token;
    stopRequested = false;
    lastStopReason = null;
    loadFailed = false;
    update({
      phase: tokenPhase,
      plan: clearPlan ? null : undefined,
      error: null,
      stopReason: null,
    });
    return token;
  }

  function stopForCurrentActivity(): boolean {
    return stopRequested || activityReason !== null;
  }

  function reasonForStop(): string {
    return activityReason ?? lastStopReason ?? "利用者が送信を停止しました";
  }

  function adoptPlan(plan: EditPlan): EditPlan {
    const copy = immutablePlan(plan);
    trackedId = copy.id;
    loadFailed = false;
    update({ plan: copy });
    return copy;
  }

  async function getCurrent(token: number, id: string): Promise<EditPlan | null> {
    try {
      const previous = planFromSnapshot();
      const loaded = mergeLoadedPlan(previous, await deps.get(id));
      if (!isRunCurrent(token)) return null;
      notifyNewSucceeded(previous, loaded);
      return adoptPlan(loaded);
    } catch (error) {
      if (!isRunCurrent(token)) return null;
      loadFailed = true;
      trackedId = id;
      safePersist(id);
      setPaused(
        token,
        planFromSnapshot(),
        null,
        messageOf(error instanceof Error ? error : null, "編集計画を読み込めませんでした"),
      );
      return null;
    }
  }

  async function reconcileUncertain(token: number, source: EditPlan): Promise<EditPlan | null> {
    let current = source;
    const targets = current.items.filter((item) => isUncertainStatus(item.status));
    if (targets.length === 0) return current;
    safePersist(current.id);
    for (const target of targets) {
      if (!isRunCurrent(token)) return null;
      if (stopForCurrentActivity()) {
        setPaused(token, current, reasonForStop());
        return null;
      }
      try {
        current = await deps.reconcile(current.id, target.before.id);
      } catch (error) {
        if (!isRunCurrent(token)) return null;
        setPaused(
          token,
          current,
          null,
          messageOf(error instanceof Error ? error : null, "編集結果を照合できませんでした"),
        );
        return null;
      }
      if (!isRunCurrent(token)) return null;
      current = adoptPlan(current);
      const result = current.items.find((item) => item.before.id === target.before.id);
      if (result?.status === "succeeded") safeUpdated();
      if (result && isUncertainStatus(result.status)) {
        setPaused(token, current, "結果を照合できない項目が残っています");
        return null;
      }
    }
    if (isEditPlanSettled(current)) {
      setSettled(token, current);
      return null;
    }
    return current;
  }

  async function executePending(token: number, source: EditPlan): Promise<void> {
    let current = source;
    safePersist(current.id);
    for (;;) {
      if (!isRunCurrent(token)) return;
      if (stopForCurrentActivity()) {
        setPaused(token, current, reasonForStop());
        return;
      }
      if (hasUncertainItems(current)) {
        setPaused(token, current, "結果を先に照合してください");
        return;
      }
      const next = current.items.find((item) => item.status === "pending");
      if (!next) {
        if (isEditPlanSettled(current)) setSettled(token, current);
        else setPaused(token, current);
        return;
      }
      update({ plan: current, phase: "running", error: null, stopReason: null });
      try {
        const result = await deps.execute(current.id, next.before.id);
        if (!isRunCurrent(token)) return;
        current = adoptPlan(result);
        const executed = current.items.find((item) => item.before.id === next.before.id);
        if (executed?.status === "succeeded") safeUpdated();
        if (isEditPlanSettled(current)) {
          setSettled(token, current);
          return;
        }
        if (!executed || executed.status === "pending" || isUncertainStatus(executed.status)) {
          setPaused(token, current, "送信結果を確認してから再開してください");
          return;
        }
      } catch (error) {
        if (!isRunCurrent(token)) return;
        const caught = error instanceof Error ? error : null;
        const message = messageOf(caught, "編集結果を確認できませんでした");
        const executionError = executionErrorOf(caught);
        if (!isEditExecutionUncertain(executionError)) {
          setPaused(token, current, "送信を停止しました", message);
          return;
        }
        let recovered: EditPlan;
        try {
          recovered = await deps.get(current.id);
          if (!isRunCurrent(token)) return;
          notifyNewSucceeded(current, recovered);
        } catch {
          recovered = markUnknown(current, next.before.id, message);
        }
        if (!isRunCurrent(token)) return;
        current = adoptPlan(recovered);
        const recoveredItem = current.items.find((item) => item.before.id === next.before.id);
        if (isEditPlanSettled(current)) {
          setSettled(token, current);
        } else if (recoveredItem?.status === "pending") {
          current = markUnknown(current, next.before.id, message);
          setPaused(token, current, "送信結果を確認できないため停止しました", message);
        } else {
          setPaused(token, current, "送信結果を確認してから再開してください", message);
        }
        return;
      }
      await deps.wait(EDIT_INTERVAL_MS);
      if (!isRunCurrent(token)) return;
    }
  }

  async function loadAndMaybeRun(token: number, id: string, run: boolean): Promise<void> {
    let loaded = await getCurrent(token, id);
    if (!loaded || !isRunCurrent(token)) return;
    if (isEditPlanSettled(loaded)) {
      setSettled(token, loaded);
      return;
    }
    if (hasUncertainItems(loaded)) {
      setPaused(token, loaded, "結果を照合してから再開してください");
      return;
    }
    if (!run || !hasPendingItems(loaded)) {
      setPaused(token, loaded);
      return;
    }
    await executePending(token, loaded);
  }

  function startPlan(plan: EditPlan): Promise<void> {
    if (!canStartNewPlan()) return Promise.resolve();
    const token = begin("running");
    trackedId = plan.id;
    safePersist(plan.id);
    const adopted = adoptPlan(plan);
    if (isEditPlanSettled(adopted)) {
      setSettled(token, adopted);
      return Promise.resolve();
    }
    if (activityReason !== null) {
      setPaused(token, adopted, activityReason);
      return Promise.resolve();
    }
    return executePending(token, adopted).catch((error) => {
      if (isRunCurrent(token)) {
        setPaused(
          token,
          adopted,
          null,
          messageOf(error instanceof Error ? error : null, "編集を実行できませんでした"),
        );
      }
    });
  }

  function startSingle(input: CreateEditPlanInput): Promise<void> {
    if (!canStartNewPlan()) return Promise.resolve();
    const token = begin("creating", true);
    trackedId = null;
    const run = (async () => {
      try {
        const created = await deps.create(input);
        if (!isRunCurrent(token)) return;
        trackedId = created.id;
        safePersist(created.id);
        const adopted = adoptPlan(created);
        if (isEditPlanSettled(adopted)) {
          setSettled(token, adopted);
          return;
        }
        if (stopForCurrentActivity()) {
          setPaused(token, adopted, reasonForStop());
          return;
        }
        await executePending(token, adopted);
      } catch (error) {
        if (!isRunCurrent(token)) return;
        update({
          phase: "idle",
          error: messageOf(error instanceof Error ? error : null, "編集計画を作成できませんでした"),
        });
        release(token);
      }
    })();
    return run.catch((error) => {
      if (isRunCurrent(token)) {
        update({
          phase: "idle",
          error: messageOf(error instanceof Error ? error : null, "編集を開始できませんでした"),
        });
        release(token);
      }
    });
  }

  function resume(): Promise<void> {
    if (isRunnerBusy(snapshot)) {
      rejectBusy();
      return Promise.resolve();
    }
    const id = trackedId ?? planFromSnapshot()?.id ?? null;
    if (id === null) return Promise.resolve();
    if (activityReason !== null) {
      update({ error: activityReason });
      return Promise.resolve();
    }
    stopRequested = false;
    lastStopReason = null;
    const token = begin("loading");
    return loadAndMaybeRun(token, id, true).catch((error) => {
      if (isRunCurrent(token)) {
        setPaused(
          token,
          planFromSnapshot(),
          null,
          messageOf(error instanceof Error ? error : null, "編集を再開できませんでした"),
        );
      }
    });
  }

  function reconcile(): Promise<void> {
    if (isRunnerBusy(snapshot)) {
      rejectBusy();
      return Promise.resolve();
    }
    const id = trackedId ?? planFromSnapshot()?.id ?? null;
    if (id === null) return Promise.resolve();
    if (activityReason !== null) {
      update({ error: activityReason });
      return Promise.resolve();
    }
    stopRequested = false;
    lastStopReason = null;
    const token = begin("reconciling");
    return (async () => {
      const loaded = await getCurrent(token, id);
      if (!loaded || !isRunCurrent(token)) return;
      if (isEditPlanSettled(loaded)) {
        setSettled(token, loaded);
        return;
      }
      const result = await reconcileUncertain(token, loaded);
      if (result && isRunCurrent(token)) setPaused(token, result);
      else if (!hasUncertainItems(loaded) && isRunCurrent(token)) setPaused(token, loaded);
    })().catch((error) => {
      if (isRunCurrent(token)) {
        setPaused(
          token,
          planFromSnapshot(),
          null,
          messageOf(error instanceof Error ? error : null, "編集結果を照合できませんでした"),
        );
      }
    });
  }

  function refresh(): Promise<void> {
    if (isRunnerBusy(snapshot)) {
      rejectBusy();
      return Promise.resolve();
    }
    const id = trackedId ?? planFromSnapshot()?.id ?? null;
    if (id === null) return Promise.resolve();
    const token = begin("loading");
    return loadAndMaybeRun(token, id, false).catch((error) => {
      if (isRunCurrent(token)) {
        setPaused(
          token,
          planFromSnapshot(),
          null,
          messageOf(error instanceof Error ? error : null, "編集計画を再取得できませんでした"),
        );
      }
    });
  }

  function restore(id: string): Promise<void> {
    if (isRunnerBusy(snapshot)) {
      rejectBusy();
      return Promise.resolve();
    }
    if (snapshot.plan !== null && !isEditPlanSettled(snapshot.plan)) {
      rejectUnresolved();
      return Promise.resolve();
    }
    if (loadFailed && trackedId !== null && trackedId !== id) {
      rejectUnresolved();
      return Promise.resolve();
    }
    const token = begin("loading");
    trackedId = id;
    loadFailed = false;
    safePersist(id);
    return (async () => {
      try {
        const loaded = await deps.get(id);
        if (!isRunCurrent(token)) return;
        notifyNewSucceeded(snapshot.plan, loaded);
        const adopted = adoptPlan(loaded);
        if (isEditPlanSettled(adopted)) setSettled(token, adopted);
        else
          setPaused(token, adopted, hasUncertainItems(adopted) ? "結果を照合してください" : null);
      } catch (error) {
        if (!isRunCurrent(token)) return;
        loadFailed = true;
        trackedId = id;
        safePersist(id);
        setPaused(
          token,
          null,
          null,
          messageOf(error instanceof Error ? error : null, "編集計画を読み込めませんでした"),
        );
      }
    })().catch((error) => {
      if (isRunCurrent(token)) {
        setPaused(
          token,
          null,
          null,
          messageOf(error instanceof Error ? error : null, "編集計画を読み込めませんでした"),
        );
      }
    });
  }

  function stop(): void {
    stopRequested = true;
    const reason = "利用者が送信を停止しました";
    lastStopReason = reason;
    if (isRunnerBusy(snapshot)) update({ phase: "stopping", stopReason: reason });
    else if (snapshot.plan !== null && !isEditPlanSettled(snapshot.plan)) {
      update({ phase: "paused", stopReason: reason });
    }
  }

  function setActivity(reason: string | null): void {
    activityReason = reason;
    if (reason !== null) {
      stopRequested = true;
      lastStopReason = reason;
      if (isRunnerBusy(snapshot)) update({ phase: "stopping", stopReason: reason });
      else if (snapshot.plan !== null && !isEditPlanSettled(snapshot.plan)) {
        update({ phase: "paused", stopReason: reason });
      }
    }
    // null は停止要求を解除せず、利用者による resume を要求する。
  }

  function dismiss(): void {
    if (isRunnerBusy(snapshot)) {
      update({ error: "処理中は編集計画を閉じられません" });
      return;
    }
    if (trackedId !== null && snapshot.plan === null) return;
    const current = snapshot.plan;
    if (current === null) return;
    if (!isEditPlanSettled(current) && !(snapshot.phase === "paused" && isPendingOnly(current))) {
      update({ error: "結果未確認の編集計画は閉じられません" });
      return;
    }
    generation += 1;
    activeRun = null;
    trackedId = null;
    loadFailed = false;
    stopRequested = false;
    safePersist(null);
    snapshot = EMPTY_SNAPSHOT;
    notify(snapshot);
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: (next: RunnerSnapshot) => void) => {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    startPlan,
    startSingle,
    resume,
    reconcile,
    refresh,
    restore,
    stop,
    setActivity,
    dismiss,
  };
}
