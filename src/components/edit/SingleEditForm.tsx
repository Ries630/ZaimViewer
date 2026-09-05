/** 明細 1 件の編集フォーム。 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  createEditPlan,
  EditApiError,
  executeEditPlan,
  getEditPlan,
  reconcileEditPlan,
} from "../../api/edits";
import type { Masters } from "../../api/masters";
import type { Transaction } from "../../api/transactions";
import {
  changesFromDraft,
  draftOf,
  editableFields,
  isEditExecutionUncertain,
  previewSnapshot,
  snapshotOf,
  type EditCapabilities,
  type EditChanges,
  type EditPlan,
} from "../../lib/edit";
import { EditFields } from "./EditFields";
import { EditReview } from "./EditReview";
import { setActivePlan } from "./EditPlanStatus";
import { useEditActivity } from "./useEditActivity";

interface SingleEditFormProps {
  /** 編集対象。詳細シートで選択された値。 */
  transaction: Transaction;
  /** フィルタ UI と共通のマスタ。 */
  masters: Masters | undefined;
  /** Worker が確認済みの編集能力。 */
  capabilities: EditCapabilities | undefined;
  /** フォームを閉じる。 */
  onCancel: () => void;
  /** 更新成功時に一覧キャッシュを取り直す。 */
  onUpdated: () => void;
}

type Step = "form" | "review" | "result";

/** 編集計画の状態を日本語で出す。 */
function resultLabel(plan: EditPlan, id: number): string {
  const item = plan.items.find((candidate) => candidate.before.id === id);
  if (!item) return "計画の対象を確認できません";
  if (item.status === "succeeded") return "保存しました";
  if (item.status === "mirror_pending") return "Zaim は更新済みですが、ミラー反映待ちです";
  if (item.status === "unknown") return "結果を確認できません。再送せず照合してください";
  if (item.status === "failed") return item.message ?? "保存に失敗しました";
  if (item.status === "pending") return "未実行です。再開するまで保存しません";
  return "保存処理を確認しています";
}

/** 外部送信が不確かなとき、同じ計画を再送せず照合対象として表示する。 */
function asUnknown(plan: EditPlan, id: number, message: string): EditPlan {
  return {
    ...plan,
    items: plan.items.map((item) =>
      item.before.id === id && item.status === "pending"
        ? { ...item, status: "unknown", message }
        : item,
    ),
  };
}

/**
 * 単体編集の入力・確認・保存を段階的に表示する。
 *
 * @param props 編集対象と API 能力。
 * @returns 単体編集フォーム。
 */
export function SingleEditForm({
  transaction,
  masters,
  capabilities,
  onCancel,
  onUpdated,
}: SingleEditFormProps) {
  const before = useMemo(() => snapshotOf(transaction), [transaction]);
  const [draft, setDraft] = useState(() => draftOf(before));
  const [step, setStep] = useState<Step>("form");
  const [changes, setChanges] = useState<EditChanges | null>(null);
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activity = useEditActivity();
  const activityRef = useRef(activity);
  const stoppedRef = useRef(false);
  useEffect(() => {
    activityRef.current = activity;
  }, [activity]);
  useEffect(() => {
    stoppedRef.current = false;
    return () => {
      // 詳細シートが閉じたら、作成直後の execute を開始しない。
      stoppedRef.current = true;
    };
  }, []);

  // 詳細シートを閉じずに別行へ移った場合だけ入力を初期化する。
  useEffect(() => {
    setDraft(draftOf(before));
    setStep("form");
    setChanges(null);
    setPlan(null);
    setError(null);
  }, [before.id]);

  const fields =
    capabilities && before.currency_code === "JPY"
      ? editableFields(before.mode, capabilities, before.receipt_id || null)
      : [];
  const canEdit = fields.length > 0;

  const handleReview = () => {
    setError(null);
    const next = changesFromDraft(before, draft);
    if (before.currency_code !== "JPY") {
      setError("円以外、または通貨を確認できない明細は編集できません");
      return;
    }
    if (!next) {
      setError("金額は 0 以上の整数で入力してください");
      return;
    }
    if (Object.keys(next).length === 0) {
      setError("変更する項目がありません");
      return;
    }
    // カテゴリを変えると既存ジャンルとの組み合わせが崩れるため、支出では
    // 変更先カテゴリに属するジャンルも同時に選ばせる。
    if (
      before.mode === "payment" &&
      next.category_id !== undefined &&
      before.genre_id !== 0 &&
      next.genre_id === undefined
    ) {
      setError("カテゴリを変えるときは、変更先のジャンルも選択してください");
      return;
    }
    setChanges(next);
    setStep("review");
  };

  const handleSave = async () => {
    if (!changes || busy) return;
    setError(null);
    if (activity.blocked) {
      setError(
        activity.hidden ? "画面を表示してから保存してください" : "オフラインのため保存できません",
      );
      return;
    }
    setBusy(true);
    activity.resetInterruption();
    let planId: string | null = null;
    let createdPlan: EditPlan | null = null;
    try {
      const created = await createEditPlan({ source: "single", expected: before, changes });
      createdPlan = created;
      planId = created.id;
      setActivePlan(created.id, created);
      if (stoppedRef.current) return;
      if (activityRef.current.blocked || activity.wasInterrupted()) {
        setPlan(created);
        setStep("result");
        setError(
          activityRef.current.hidden
            ? "画面を表示してから保存を再開してください"
            : "オフラインのため保存を停止しました",
        );
        return;
      }
      // 作成直後の同じ計画 ID を使う。別の計画を作り直して結果を追跡しない。
      setActivePlan(created.id, created, true);
      const executed = await executeEditPlan(created.id, before.id);
      setPlan(executed);
      setActivePlan(executed.id, executed, false);
      setStep("result");
      const item = executed.items.find((candidate) => candidate.before.id === before.id);
      if (item?.status === "succeeded") {
        setActivePlan(null);
        onUpdated();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存できませんでした");
      // POST が届いた可能性があるため、同じ計画の状態だけ照会する。再実行はしない。
      if (planId !== null) {
        if (
          !isEditExecutionUncertain(caught instanceof EditApiError ? caught : null) &&
          createdPlan
        ) {
          setPlan(createdPlan);
          setActivePlan(createdPlan.id, createdPlan, false);
          setStep("result");
          return;
        }
        try {
          const recovered = asUnknown(
            await getEditPlan(planId),
            before.id,
            "保存結果を確認できませんでした",
          );
          setPlan(recovered);
          setStep("result");
          const recoveredItem = recovered.items.find(
            (candidate) => candidate.before.id === before.id,
          );
          if (recoveredItem?.status === "succeeded") {
            setActivePlan(null);
            setError(null);
            onUpdated();
          } else {
            setActivePlan(recovered.id, recovered, false);
          }
        } catch {
          // GET も失敗した場合は、作成時の計画を結果不明として表示し再送を止める。
          if (createdPlan) {
            const uncertain = asUnknown(createdPlan, before.id, "保存結果を確認できませんでした");
            setPlan(uncertain);
            setActivePlan(uncertain.id, uncertain, false);
            setStep("result");
          }
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const handleReconcile = async () => {
    if (!plan || busy) return;
    if (activityRef.current.blocked) {
      setError(
        activityRef.current.hidden
          ? "画面を表示してから照合してください"
          : "オフラインのため照合できません",
      );
      return;
    }
    const item = plan.items.find((candidate) => candidate.before.id === before.id);
    if (
      item?.status !== "sending" &&
      item?.status !== "unknown" &&
      item?.status !== "mirror_pending"
    )
      return;
    setBusy(true);
    setError(null);
    setActivePlan(plan.id, plan, true);
    try {
      const reconciled = await reconcileEditPlan(plan.id, before.id);
      setPlan(reconciled);
      setActivePlan(reconciled.id, reconciled, false);
      const result = reconciled.items.find((candidate) => candidate.before.id === before.id);
      if (result?.status === "succeeded") {
        setActivePlan(null);
        onUpdated();
      }
    } catch (caught) {
      setActivePlan(plan.id, plan, false);
      setError(caught instanceof Error ? caught.message : "照合できませんでした");
    } finally {
      setBusy(false);
    }
  };

  const handleResume = async () => {
    if (!plan || busy || activityRef.current.blocked) return;
    const item = plan.items.find((candidate) => candidate.before.id === before.id);
    if (item?.status !== "pending") return;
    setBusy(true);
    setError(null);
    setActivePlan(plan.id, plan, true);
    try {
      const executed = await executeEditPlan(plan.id, before.id);
      setPlan(executed);
      setActivePlan(executed.id, executed, false);
      const result = executed.items.find((candidate) => candidate.before.id === before.id);
      if (result?.status === "succeeded") {
        setActivePlan(null);
        onUpdated();
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "保存結果を確認できませんでした";
      const recovered = isEditExecutionUncertain(caught instanceof EditApiError ? caught : null)
        ? await getOrMarkUnknown(plan, before.id, message)
        : plan;
      setPlan(recovered);
      const recoveredItem = recovered.items.find((candidate) => candidate.before.id === before.id);
      if (recoveredItem?.status === "succeeded") {
        setActivePlan(null);
        setError(null);
        onUpdated();
      } else {
        setActivePlan(recovered.id, recovered, false);
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  if (!canEdit && step === "form") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-base-content/70">
          この明細は、現在の編集能力では変更できません。
        </p>
        {before.currency_code !== "JPY" && (
          <p className="text-sm text-warning">円以外、または通貨を確認できない明細です。</p>
        )}
        <button type="button" className="btn" onClick={onCancel}>
          戻る
        </button>
      </div>
    );
  }

  if (step === "result" && plan) {
    const item = plan.items.find((candidate) => candidate.before.id === before.id);
    const canReconcile =
      item?.status === "sending" || item?.status === "unknown" || item?.status === "mirror_pending";
    const canResume = item?.status === "pending" && !activity.blocked;
    return (
      <div className="flex flex-col gap-3">
        <div
          className={item?.status === "succeeded" ? "alert alert-success" : "alert alert-warning"}
        >
          <span>{resultLabel(plan, before.id)}</span>
        </div>
        {item?.message && item.status !== "succeeded" && (
          <p className="text-sm text-error">{item.message}</p>
        )}
        {error && <p className="text-sm text-error">{error}</p>}
        {canReconcile && (
          <button
            type="button"
            className="btn"
            onClick={() => void handleReconcile()}
            disabled={busy}
          >
            {busy ? "照合中…" : "結果を照合"}
          </button>
        )}
        {canResume && (
          <button type="button" className="btn" onClick={() => void handleResume()} disabled={busy}>
            {busy ? "保存中…" : "保存を再開"}
          </button>
        )}
        <button type="button" className="btn" onClick={onCancel}>
          閉じる
        </button>
      </div>
    );
  }

  if (step === "review" && changes) {
    const after = previewSnapshot(before, changes);
    return (
      <div className="flex flex-col gap-3">
        <EditReview before={before} after={after} changes={changes} masters={masters} />
        {error && <p className="text-sm text-error">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            className="btn flex-1"
            onClick={() => setStep("form")}
            disabled={busy}
          >
            戻って修正
          </button>
          <button
            type="button"
            className="btn btn-primary flex-1"
            onClick={() => void handleSave()}
            disabled={busy}
          >
            {busy ? "保存中…" : "この内容で保存"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <EditFields
        mode={before.mode}
        masters={masters}
        draft={draft}
        onChange={setDraft}
        fields={fields}
      />
      {error && <p className="text-sm text-error">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className="btn flex-1" onClick={onCancel}>
          キャンセル
        </button>
        <button type="button" className="btn btn-primary flex-1" onClick={handleReview}>
          変更を確認
        </button>
      </div>
    </div>
  );
}

/** 実行結果が不明なとき、同じ計画を取得して再送せず状態を確定する。 */
async function getOrMarkUnknown(plan: EditPlan, id: number, message: string): Promise<EditPlan> {
  try {
    return asUnknown(await getEditPlan(plan.id), id, message);
  } catch {
    return asUnknown(plan, id, message);
  }
}
