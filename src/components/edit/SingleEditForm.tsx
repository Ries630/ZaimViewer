/** 明細 1 件の編集フォーム。 */

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { Masters } from "../../api/masters";
import type { Transaction } from "../../api/transactions";
import {
  changesFromDraft,
  editDateError,
  draftOf,
  editableFields,
  previewSnapshot,
  snapshotOf,
  type EditCapabilities,
  type EditChanges,
  type EditPlan,
} from "../../lib/edit";
import { isRunnerBusy } from "../../lib/edit-plan-runner";
import { EditFields } from "./EditFields";
import { EditReview } from "./EditReview";
import { useEditRunner } from "./EditPlanProvider";
import { useEditActivity } from "./useEditActivity";
import { SheetCloseButton } from "../SheetCloseButton";

interface SingleEditFormProps {
  /** 編集対象。詳細シートで選択された値。 */
  transaction: Transaction;
  /** フィルタ UI と共通のマスタ。 */
  masters: Masters | undefined;
  /** Worker が確認済みの編集能力。 */
  capabilities: EditCapabilities | undefined;
  /** フォームを閉じる。 */
  onCancel: () => void;
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
}: SingleEditFormProps) {
  const { runner, snapshot } = useEditRunner();
  // 一覧が再取得されても、編集中の競合判定は開始時の値を使う。
  const [before] = useState(() => snapshotOf(transaction));
  const [draft, setDraft] = useState(() => draftOf(before));
  const [step, setStep] = useState<Step>("form");
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 画面を切り替えたときは、確認内容を先頭から表示する。
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [step]);
  const [changes, setChanges] = useState<EditChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activity = useEditActivity();
  const runnerBusy = isRunnerBusy(snapshot);
  const hasUnfinishedRunnerPlan = !snapshot.canStart;
  const plan = snapshot.plan;

  const fields =
    capabilities && before.currency_code === "JPY"
      ? editableFields(before.mode, capabilities, before.receipt_id || null)
      : [];
  const canEdit = fields.length > 0;

  const dateError = editDateError(draft.date);

  const handleReview = () => {
    setError(null);
    if (dateError) {
      setError(dateError);
      return;
    }
    if (runnerBusy || hasUnfinishedRunnerPlan) {
      setError("未完了の編集計画があります。先に一覧の編集計画を解決してください");
      return;
    }
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

  const handleSave = () => {
    if (!changes || runnerBusy || hasUnfinishedRunnerPlan) return;
    setError(null);
    if (activity.blocked) {
      setError(
        activity.hidden ? "画面を表示してから保存してください" : "オフラインのため保存できません",
      );
      return;
    }
    setStep("result");
    void runner.startSingle({ source: "single", expected: before, changes });
  };

  const handleReconcile = () => {
    if (!plan || runnerBusy) return;
    if (activity.blocked) {
      setError(
        activity.hidden ? "画面を表示してから照合してください" : "オフラインのため照合できません",
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
    setError(null);
    void runner.reconcile();
  };

  const handleResume = () => {
    if (!plan || runnerBusy || activity.blocked) return;
    const item = plan.items.find((candidate) => candidate.before.id === before.id);
    if (item?.status !== "pending") return;
    setError(null);
    void runner.resume();
  };

  let body: ReactNode;
  let footer: ReactNode;

  if (!canEdit && step === "form") {
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-base-content/70">
          この明細は、現在の編集能力では変更できません。
        </p>
        {before.currency_code !== "JPY" && (
          <p className="text-sm text-warning">円以外、または通貨を確認できない明細です。</p>
        )}
      </div>
    );
    footer = (
      <button type="button" className="btn btn-block" onClick={onCancel}>
        詳細に戻る
      </button>
    );
  } else if (step === "result") {
    const item = plan?.items.find((candidate) => candidate.before.id === before.id);
    const canReconcile =
      plan !== null &&
      (item?.status === "sending" ||
        item?.status === "unknown" ||
        item?.status === "mirror_pending");
    const canResume = plan !== null && item?.status === "pending" && !activity.blocked;
    body = (
      <div className="flex flex-col gap-3">
        {plan ? (
          <div
            className={item?.status === "succeeded" ? "alert alert-success" : "alert alert-warning"}
          >
            <span>
              {runnerBusy && item?.status === "pending"
                ? "保存処理を確認しています"
                : resultLabel(plan, before.id)}
            </span>
          </div>
        ) : (
          <p className="text-sm text-base-content/70">
            {runnerBusy ? "保存を開始しています…" : "保存を開始できませんでした"}
          </p>
        )}
        {item?.message && item.status !== "succeeded" && (
          <p className="text-sm text-error">{item.message}</p>
        )}
        {snapshot.error && <p className="text-sm text-error">{snapshot.error}</p>}
        {error && <p className="text-sm text-error">{error}</p>}
      </div>
    );
    footer = (
      <div className="flex flex-col gap-2">
        {!plan && !runnerBusy && (
          <button type="button" className="btn btn-block" onClick={() => setStep("form")}>
            戻って修正
          </button>
        )}
        {canReconcile && (
          <button
            type="button"
            className="btn btn-block"
            onClick={handleReconcile}
            disabled={runnerBusy}
          >
            {runnerBusy ? "照合中…" : "結果を照合"}
          </button>
        )}
        {canResume && (
          <button
            type="button"
            className="btn btn-block"
            onClick={handleResume}
            disabled={runnerBusy}
          >
            {runnerBusy ? "保存中…" : "保存を再開"}
          </button>
        )}
        <button type="button" className="btn btn-block" onClick={onCancel}>
          詳細に戻る
        </button>
      </div>
    );
  } else if (step === "review" && changes) {
    const after = previewSnapshot(before, changes);
    body = (
      <div className="flex flex-col gap-3">
        <EditReview
          before={before}
          after={after}
          changes={changes}
          masters={masters}
          showNotice={false}
        />
        {error && <p className="text-sm text-error">{error}</p>}
      </div>
    );
    footer = (
      <div className="flex gap-2">
        <button
          type="button"
          className="btn flex-1"
          onClick={() => setStep("form")}
          disabled={runnerBusy}
        >
          戻って修正
        </button>
        <button
          type="button"
          className="btn btn-primary flex-1"
          onClick={handleSave}
          disabled={runnerBusy || hasUnfinishedRunnerPlan}
        >
          {runnerBusy ? "保存中…" : "この内容で保存"}
        </button>
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        {hasUnfinishedRunnerPlan && (
          <p className="text-sm text-warning">
            未完了の編集計画があります。先に一覧の編集計画を解決してください。
          </p>
        )}
        <EditFields
          mode={before.mode}
          masters={masters}
          draft={draft}
          onChange={setDraft}
          fields={fields}
        />
        {error && <p className="text-sm text-error">{error}</p>}
      </div>
    );
    footer = (
      <div className="flex gap-2">
        <button type="button" className="btn flex-1" onClick={onCancel}>
          キャンセル
        </button>
        <button
          type="button"
          className="btn btn-primary flex-1"
          onClick={handleReview}
          disabled={runnerBusy || hasUnfinishedRunnerPlan || dateError !== null}
        >
          変更を確認
        </button>
      </div>
    );
  }

  const heading =
    step === "form" ? "明細を編集" : step === "review" ? "明細編集の確認" : "明細編集の結果";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-base-300 px-5 py-2">
        <h2 className="text-base font-bold">{heading}</h2>
        <SheetCloseButton />
      </div>
      <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto px-5 py-4">{body}</div>
      <div className="shrink-0 border-t border-base-300 px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        {footer}
      </div>
    </div>
  );
}
