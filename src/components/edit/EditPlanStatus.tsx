/** 画面再読込後も編集計画を追跡する表示。 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  EditApiError,
  executeEditPlan,
  getEditPlan,
  reconcileEditPlan,
  useEditPlan,
} from "../../api/edits";
import {
  EDIT_INTERVAL_MS,
  isEditExecutionUncertain,
  readActivePlanId,
  storeActivePlanId,
  type EditChanges,
  type EditField,
  type EditPlan,
} from "../../lib/edit";
import { formatAmount } from "../../lib/format";
import { useEditActivity } from "./useEditActivity";

/** 計画作成・更新を同一タブ内の表示へ知らせるイベント名。 */
export const EDIT_PLAN_EVENT = "zaimviewer:edit-plan";

/** 計画の変更キーを確認画面で読むための表示名。 */
const CHANGE_LABELS = {
  date: "日付",
  amount: "金額",
  category_id: "カテゴリ ID",
  genre_id: "ジャンル ID",
  from_account_id: "出金元 ID",
  to_account_id: "入金先 ID",
  name: "品名",
  place: "店舗",
  comment: "メモ",
} satisfies Record<EditField, string>;

/**
 * 現在の計画 ID を画面へ通知する。
 *
 * @param id 計画 ID。null なら表示を消す。
 * @param plan 更新済みの計画。指定時は GET キャッシュも同じ内容にする。
 * @param executing 同じタブの別UIが実行中なら true。
 */
export function announceEditPlan(id: string | null, plan?: EditPlan, executing = false): void {
  window.dispatchEvent(new CustomEvent(EDIT_PLAN_EVENT, { detail: { id, plan, executing } }));
}

/** sessionStorage が使える環境なら返す。 */
function activeStorage(): Storage | null {
  return window.sessionStorage;
}

/**
 * 計画 ID を保存し、同じタブの計画表示を更新する。
 *
 * @param id 計画 ID。null なら削除する。
 * @param plan 更新済みの計画。指定時は GET キャッシュも同じ内容にする。
 * @param executing 同じタブの別UIが実行中なら true。
 */
export function setActivePlan(id: string | null, plan?: EditPlan, executing = false): void {
  const storage = activeStorage();
  if (storage) storeActivePlanId(storage, id);
  announceEditPlan(id, plan, executing);
}

function statusText(plan: EditPlan): string {
  const counts = new Map<string, number>();
  for (const item of plan.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  return [
    ["succeeded", "完了"],
    ["pending", "未実行"],
    ["sending", "送信中"],
    ["failed", "失敗"],
    ["unknown", "結果未確認"],
    ["mirror_pending", "ミラー反映待ち"],
  ]
    .filter(([key]) => key !== undefined && counts.has(key))
    .map(([key, label]) => `${label ?? ""} ${counts.get(key ?? "") ?? 0}`)
    .join("・");
}

/** 送信結果が不確かな対象を再送せず照合対象へ移す。 */
function withUnknown(plan: EditPlan, id: number, message: string): EditPlan {
  const target = plan.items.find((item) => item.before.id === id);
  // GET が送信中を返した場合は、その状態を保ったまま reconcile へ回す。
  if (!target || target.status !== "pending") return plan;
  return {
    ...plan,
    items: plan.items.map((item) =>
      item.before.id === id ? { ...item, status: "unknown", message } : item,
    ),
  };
}

/** 手動停止要求を非同期ループから読み取る。 */
function stopRequested(ref: { requested: boolean }): boolean {
  return ref.requested;
}

/** 計画の変更値を再開前の確認欄へ表示する。 */
function changeValueText(field: EditField, value: EditChanges[EditField]): string {
  if (value === "") return "（空文字にする）";
  if (value === undefined) return "（未指定）";
  if (field === "amount") return formatAmount(Number(value), "JPY");
  return value.toString();
}

/** pending 対象の変更前スナップショットを表示する。 */
function pendingItemLabel(item: EditPlan["items"][number]): string {
  return `#${item.before.id} ${item.before.date}・${formatAmount(item.before.amount, item.before.currency_code)}`;
}

/**
 * 保存済み計画を GET で復元し、未実行の対象を手動再開できるようにする。
 *
 * @param onSettled ミラーの読み取りキャッシュを更新する通知。
 * @returns 計画状態表示。
 */
export function EditPlanStatus({ onSettled }: { onSettled: () => void }) {
  const [id, setId] = useState<string | null>(() => {
    const storage = activeStorage();
    return storage ? readActivePlanId(storage) : null;
  });
  const [reconciling, setReconciling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const planQuery = useEditPlan(id);
  const activity = useEditActivity();
  const activityRef = useRef(activity);
  const stopRef = useRef({ requested: false });
  const plan = planQuery.data;
  const reconcileItems = useMemo(
    () =>
      plan?.items.filter(
        (item) =>
          item.status === "sending" ||
          item.status === "unknown" ||
          item.status === "mirror_pending",
      ) ?? [],
    [plan],
  );
  const pendingItems = useMemo(
    () => plan?.items.filter((item) => item.status === "pending") ?? [],
    [plan],
  );

  useEffect(() => {
    activityRef.current = activity;
  }, [activity]);

  useEffect(() => {
    const onPlanEvent = (event: Event) => {
      // SAFETY: このイベントは setActivePlan が同じタブ内で発行したものに限る。
      const detail = (
        event as CustomEvent<{ id: string | null; plan?: EditPlan; executing?: boolean }>
      ).detail;
      setId(detail.id);
      setExecuting(detail.executing ?? false);
      setError(null);
      if (detail.plan) {
        queryClient.setQueryData(["edit-plan", detail.plan.id], detail.plan);
      }
    };
    window.addEventListener(EDIT_PLAN_EVENT, onPlanEvent);
    return () => window.removeEventListener(EDIT_PLAN_EVENT, onPlanEvent);
  }, [queryClient]);

  // 通信失敗でも ID は sessionStorage に残す。オフラインから復帰したときに
  // 同じ計画を GET し直し、結果を追跡できるようにする。
  useEffect(() => {
    if (planQuery.isError && id !== null) {
      setError("保存計画を読み込めませんでした");
    }
  }, [id, planQuery.isError]);

  const refresh = async () => {
    if (!id || refreshing || executing || resuming || reconciling || activity.blocked) return;
    setRefreshing(true);
    setError(null);
    try {
      const result = await planQuery.refetch();
      if (result.error) throw result.error;
      if (result.data) {
        queryClient.setQueryData(["edit-plan", result.data.id], result.data);
        if (result.data.items.every((item) => item.status === "succeeded")) {
          setActivePlan(null);
          onSettled();
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存計画を再取得できませんでした");
    } finally {
      setRefreshing(false);
    }
  };

  const resume = async () => {
    if (!plan || pendingItems.length === 0 || executing || resuming || activity.blocked) return;
    setResuming(true);
    activity.resetInterruption();
    setExecuting(true);
    setStopped(false);
    stopRef.current.requested = false;
    setError(null);
    let current = plan;
    let touched = false;
    try {
      for (;;) {
        if (
          stopRequested(stopRef.current) ||
          activityRef.current.blocked ||
          activity.wasInterrupted()
        ) {
          if (activityRef.current.blocked) stopRef.current.requested = true;
          setStopped(true);
          break;
        }
        if (
          current.items.some(
            (item) =>
              item.status === "sending" ||
              item.status === "unknown" ||
              item.status === "mirror_pending",
          )
        ) {
          setError("送信中または結果不明の項目を先に照合してください");
          setStopped(true);
          break;
        }
        const next = current.items.find((item) => item.status === "pending");
        if (!next) break;
        try {
          current = await executeEditPlan(current.id, next.before.id);
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : "結果を確認できませんでした";
          if (!isEditExecutionUncertain(caught instanceof EditApiError ? caught : null)) {
            setError(message);
            setStopped(true);
            touched = true;
            queryClient.setQueryData(["edit-plan", current.id], current);
            setActivePlan(current.id, current, true);
            break;
          }
          // POST が届いた可能性があるため、同じ計画の GET だけを行い再送しない。
          try {
            current = withUnknown(await getEditPlan(current.id), next.before.id, message);
          } catch {
            current = withUnknown(current, next.before.id, message);
          }
          const confirmed =
            current.items.find((item) => item.before.id === next.before.id)?.status === "succeeded";
          setError(confirmed ? null : message);
          setStopped(
            current.items.some((item) => item.status !== "succeeded" && item.status !== "failed"),
          );
          touched = true;
          queryClient.setQueryData(["edit-plan", current.id], current);
          setActivePlan(current.id, current, true);
          break;
        }
        touched = true;
        queryClient.setQueryData(["edit-plan", current.id], current);
        setActivePlan(current.id, current, true);
        const result = current.items.find((item) => item.before.id === next.before.id);
        if (
          result?.status === "sending" ||
          result?.status === "unknown" ||
          result?.status === "mirror_pending"
        ) {
          setStopped(true);
          break;
        }
        // 外部 API へ連続要求を詰めず、一件ずつ間隔を空ける。
        await new Promise((resolve) => window.setTimeout(resolve, EDIT_INTERVAL_MS));
      }
      if (current.items.every((item) => item.status === "succeeded" || item.status === "failed")) {
        setActivePlan(null);
      } else {
        setActivePlan(current.id, current, false);
      }
      if (touched) onSettled();
    } finally {
      setExecuting(false);
      setResuming(false);
    }
  };

  const stop = () => {
    stopRef.current.requested = true;
    setStopped(true);
  };

  const reconcile = async () => {
    if (!plan || reconcileItems.length === 0 || executing || reconciling || resuming) return;
    if (activity.blocked) {
      setError(
        activity.hidden ? "画面を表示してから照合してください" : "オフラインのため照合できません",
      );
      return;
    }
    setReconciling(true);
    setExecuting(true);
    setError(null);
    let current = plan;
    let cleared = false;
    try {
      setActivePlan(current.id, current, true);
      for (const item of reconcileItems) {
        current = await reconcileEditPlan(current.id, item.before.id);
        queryClient.setQueryData(["edit-plan", current.id], current);
        setActivePlan(current.id, current, true);
      }
      if (current.items.every((item) => item.status === "succeeded")) {
        cleared = true;
        setActivePlan(null);
      } else {
        setActivePlan(current.id, current, false);
      }
      onSettled();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "照合できませんでした");
    } finally {
      if (!cleared) setActivePlan(current.id, current, false);
      setExecuting(false);
      setReconciling(false);
    }
  };

  if (!id || !plan) {
    return error ? <p className="px-4 py-2 text-sm text-error">{error}</p> : null;
  }
  // SAFETY: changes は editChangesSchema で検証済みなのでキーは EditField に限る。
  const changeFields = Object.keys(plan.changes) as EditField[];

  return (
    <div className="border-b border-base-300 px-4 py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <p>
          編集計画: <span className="font-medium">{statusText(plan)}</span>
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void refresh()}
            disabled={refreshing || executing || resuming || reconciling || activity.blocked}
          >
            {refreshing ? "取得中…" : "最新状態を取得"}
          </button>
          {reconcileItems.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void reconcile()}
              disabled={executing || reconciling || resuming || activity.blocked}
            >
              {reconciling ? "照合中…" : "送信結果を照合"}
            </button>
          )}
          {pendingItems.length > 0 && !executing && !resuming && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void resume()}
              disabled={activity.blocked}
            >
              残りを手動再開
            </button>
          )}
          {resuming && executing && (
            <button type="button" className="btn btn-ghost" onClick={stop}>
              ここで停止
            </button>
          )}
        </div>
      </div>
      {stopped && pendingItems.length > 0 && (
        <p className="mt-1 text-warning">新しい送信を停止しました。再開するまで送信しません。</p>
      )}
      {activity.blocked && pendingItems.length > 0 && (
        <p className="mt-1 text-warning">オフラインまたはバックグラウンドのため停止中です。</p>
      )}
      {pendingItems.length > 0 && (
        <details className="mt-2 rounded-box border border-base-300 p-3">
          <summary className="cursor-pointer font-medium">再開前に保存内容と対象を確認</summary>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {changeFields.map((field) => (
              <div key={field} className="contents">
                <dt className="text-base-content/60">{CHANGE_LABELS[field]}</dt>
                <dd className="break-words">{changeValueText(field, plan.changes[field])}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-sm font-medium">未実行の対象</p>
          <ul className="mt-1 text-sm text-base-content/70">
            {pendingItems.map((item) => (
              <li key={item.before.id}>{pendingItemLabel(item)}</li>
            ))}
          </ul>
        </details>
      )}
      {error && <p className="mt-1 text-error">{error}</p>}
    </div>
  );
}
