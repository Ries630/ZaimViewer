/** 編集処理をダイアログの寿命から切り離してアプリ全体で共有する。 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { createEditPlan, executeEditPlan, getEditPlan, reconcileEditPlan } from "../../api/edits";
import { readActivePlanId, storeActivePlanId } from "../../lib/edit";
import { isOnline, subscribeOnline } from "../../hooks/useOnline";
import { createEditPlanRunner } from "../../lib/edit-plan-runner";

const RunnerContext = createContext<ReturnType<typeof createEditPlanRunner> | null>(null);

/** 利用できる場合だけタブ単位の保存領域を返す。 */
function activeStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    // 保存領域を取得できなくても、起動中の Runner は追跡を続ける。
    return null;
  }
}

/** 次の要求を開始できない端末状態を、その場で読み取る。 */
function blockedReason(): string | null {
  if (document.hidden) return "バックグラウンドへ移ったため停止しました";
  if (!isOnline()) return "オフラインのため停止しました";
  return null;
}

/** アプリが起動している間、単一の実行管理と端末状態の監視を維持する。 */
export function EditPlanProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [runner] = useState(() =>
    createEditPlanRunner({
      create: createEditPlan,
      execute: executeEditPlan,
      get: getEditPlan,
      reconcile: reconcileEditPlan,
      wait: (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
      persist: (id) => {
        const storage = activeStorage();
        if (storage) storeActivePlanId(storage, id);
      },
      onUpdated: () => {
        void queryClient.invalidateQueries({ queryKey: ["transactions"] });
        void queryClient.invalidateQueries({ queryKey: ["masters"] });
      },
    }),
  );
  const restored = useRef(false);

  useEffect(() => {
    const updateActivity = () => runner.setActivity(blockedReason());
    const onPageHide = () => runner.setActivity("ページを離れたため停止しました");
    updateActivity();
    const unsubscribeOnline = subscribeOnline(updateActivity);
    document.addEventListener("visibilitychange", updateActivity);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", updateActivity);
    if (!restored.current) {
      restored.current = true;
      const storage = activeStorage();
      const id = storage ? readActivePlanId(storage) : null;
      if (id) void runner.restore(id);
    }
    return () => {
      document.removeEventListener("visibilitychange", updateActivity);
      unsubscribeOnline();
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", updateActivity);
      runner.stop();
    };
  }, [runner]);

  return <RunnerContext value={runner}>{children}</RunnerContext>;
}

/** どの表示からも同じ実行状態と操作を参照する。 */
export function useEditRunner() {
  const runner = useContext(RunnerContext);
  if (!runner) throw new Error("編集処理の共有領域がありません");
  const snapshot = useSyncExternalStore(runner.subscribe, runner.getSnapshot);
  return { runner, snapshot };
}
