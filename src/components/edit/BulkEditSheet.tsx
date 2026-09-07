/** フィルタ結果に対する一括編集シート。 */

import { useEffect, useMemo, useRef, useState } from "react";

import { createEditPlan } from "../../api/edits";
import type { Masters } from "../../api/masters";
import type { Transaction, TransactionFilter } from "../../api/transactions";
import { formatAmount } from "../../lib/format";
import {
  bulkEditableFields,
  changesFromBulk,
  MAX_EDIT_ITEMS,
  previewSnapshot,
  type EditCapabilities,
  type EditChanges,
  type EditDraft,
  type EditField,
  type EditPlan,
} from "../../lib/edit";
import { SheetCloseButton } from "../SheetCloseButton";
import { EditFields } from "./EditFields";
import { EditReview } from "./EditReview";
import { isRunnerBusy } from "../../lib/edit-plan-runner";
import { useEditRunner } from "./EditPlanProvider";
import { useEditActivity } from "./useEditActivity";

interface BulkEditSheetProps {
  /** モーダルの参照。 */
  ref: React.RefObject<HTMLDialogElement | null>;
  /** 現在の API フィルタ。 */
  filter: TransactionFilter;
  /** 同一種別に絞られた種別。 */
  mode: "payment" | "income" | "transfer";
  /** 現在取得済みの対象。MAX_EDIT_ITEMS 以下なら全件が含まれる。 */
  items: Transaction[];
  /** フィルタに一致する総件数。 */
  total: number | undefined;
  /** マスタ。 */
  masters: Masters | undefined;
  /** API が確認した編集能力。 */
  capabilities: EditCapabilities | undefined;
}

type Step = "form" | "review" | "result";

const EMPTY_DRAFT: EditDraft = {
  date: "",
  amount: "",
  category_id: null,
  genre_id: null,
  from_account_id: null,
  to_account_id: null,
  name: "",
  place: "",
  comment: "",
};

function itemStatus(plan: EditPlan): string {
  const counts = new Map<string, number>();
  for (const item of plan.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  return [
    ["succeeded", "完了"],
    ["failed", "失敗"],
    ["pending", "未実行"],
    ["sending", "送信中"],
    ["unknown", "結果未確認"],
    ["mirror_pending", "ミラー反映待ち"],
  ]
    .filter(([key]) => key !== undefined && counts.has(key))
    .map(([key, label]) => `${label ?? ""} ${counts.get(key ?? "") ?? 0}`)
    .join("・");
}

/** サーバーが固定した対象を確認画面へ表示する。 */
function beforeLabel(plan: EditPlan["items"][number]): string {
  const before = plan.before;
  return `${before.date}・${formatAmount(before.amount, before.currency_code)}`;
}

/** 対象を識別するため、サーバー固定時点の店舗と品名を表示する。 */
function identityLabel(item: EditPlan["items"][number]): string {
  const place = item.before.place || "（店舗なし）";
  const name = item.before.name || "（品名なし）";
  return `店舗: ${place}・品名: ${name}`;
}

/**
 * 一括編集の対象確認、逐次実行、手動照合を担う。
 *
 * @param props 対象フィルタと編集能力。
 * @returns 一括編集シート。
 */
export function BulkEditSheet({
  ref,
  filter,
  mode,
  items,
  total,
  masters,
  capabilities,
}: BulkEditSheetProps) {
  const { runner, snapshot } = useEditRunner();
  const [draft, setDraft] = useState<EditDraft>(EMPTY_DRAFT);
  const [selected, setSelected] = useState<ReadonlySet<EditField>>(new Set());
  const [step, setStep] = useState<Step>("form");
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 入力・確認・結果へ進むたび、前の画面のスクロール位置を持ち越さない。
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [step]);
  const [changes, setChanges] = useState<EditChanges | null>(null);
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activity = useEditActivity();
  const generationRef = useRef(0);
  const runnerPlan = snapshot.plan;
  const runnerBusy = isRunnerBusy(snapshot);
  const hasUnfinishedRunnerPlan = !snapshot.canStart;
  const stopped = snapshot.phase === "paused" || snapshot.stopReason !== null;

  const handleDialogClose = () => {
    // ダイアログの表示状態だけ破棄し、Runner が管理する送信は継続する。
    generationRef.current += 1;
    setDraft(EMPTY_DRAFT);
    setSelected(new Set());
    setStep("form");
    setChanges(null);
    setPlan(null);
    setError(null);
    setBusy(false);
  };

  const allHaveReceipt =
    items.length === total &&
    items.every((item) => item.receipt_id !== null && item.receipt_id > 0);
  const allHaveJpy = items.length === total && items.every((item) => item.currency_code === "JPY");
  const fields = useMemo(
    () => (capabilities ? bulkEditableFields(mode, capabilities, allHaveReceipt) : []),
    [allHaveReceipt, capabilities, mode],
  );

  const toggleField = (field: EditField) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  // 支出のカテゴリ変更にはジャンルも必須。手動で選んだ欄とは分けて導出する。
  const effectiveSelected = new Set(selected);
  if (mode === "payment" && selected.has("category_id")) effectiveSelected.add("genre_id");

  const handleReview = async () => {
    const next = changesFromBulk(effectiveSelected, draft);
    setError(null);
    if (!next || Object.keys(next).length === 0) {
      setError("変更する項目を 1 つ以上選択してください");
      return;
    }
    if (mode === "payment" && next.category_id !== undefined && next.genre_id === undefined) {
      setError("カテゴリを一括変更するときは、ジャンルも選択してください");
      return;
    }
    if (runnerBusy || hasUnfinishedRunnerPlan) {
      setError("未完了の編集計画があります。先に一覧の編集計画を解決してください");
      return;
    }
    if (activity.blocked) {
      setError(
        activity.hidden ? "画面を表示してから確認してください" : "オフラインのため確認できません",
      );
      return;
    }
    setBusy(true);
    const generation = generationRef.current;
    try {
      // 対象のスナップショットは確認画面へ進む時点でサーバーに固定する。
      const created = await createEditPlan({ source: "filter", filter, changes: next });
      if (generation !== generationRef.current) return;
      setChanges(next);
      setPlan(created);
      setStep("review");
    } catch (caught) {
      if (generation === generationRef.current) {
        setError(caught instanceof Error ? caught.message : "対象を確認できませんでした");
      }
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  };

  const handleSave = () => {
    if (!changes || !plan || busy || runnerBusy || hasUnfinishedRunnerPlan) return;
    if (activity.blocked) {
      setError(
        activity.hidden ? "画面を表示してから保存してください" : "オフラインのため保存できません",
      );
      return;
    }
    setError(null);
    setStep("result");
    void runner.startPlan(plan);
  };

  const handleResume = () => {
    if (!runnerPlan || busy || runnerBusy || activity.blocked) return;
    setError(null);
    void runner.resume();
  };

  const handleStop = () => {
    runner.stop();
  };

  const handleReconcile = () => {
    if (!runnerPlan || busy || runnerBusy) return;
    if (activity.blocked) {
      setError(
        activity.hidden ? "画面を表示してから照合してください" : "オフラインのため照合できません",
      );
      return;
    }
    setError(null);
    void runner.reconcile();
  };

  const canOpen = allHaveJpy && fields.length > 0 && total > 0 && total <= MAX_EDIT_ITEMS;
  const targetCount = total ?? items.length;
  const reviewCount = plan?.items.length ?? targetCount;

  return (
    <dialog
      ref={ref}
      className="modal modal-bottom sm:modal-middle"
      aria-label="一括編集"
      onClose={handleDialogClose}
    >
      <div className="modal-box flex max-h-[85dvh] flex-col gap-3 overflow-hidden p-0">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-base-300 px-5 pt-3 pb-3">
          <div>
            <h2 className="text-base font-bold">
              {step === "review"
                ? "一括編集の確認"
                : step === "result"
                  ? "一括編集の結果"
                  : "一括編集"}
            </h2>
            <p className="mt-1 text-sm text-base-content/70">
              {step === "review"
                ? "変更対象 " + reviewCount + " 件"
                : targetCount +
                  " 件（" +
                  (mode === "payment" ? "支出" : mode === "income" ? "収入" : "振替") +
                  "）"}
            </p>
          </div>
          <SheetCloseButton />
        </div>

        <div ref={contentRef} className="min-h-0 overflow-y-auto overscroll-contain px-5 pb-3">
          {total !== undefined && items.length === total && !allHaveJpy && (
            <p className="py-4 text-sm text-warning">
              円以外、または通貨を確認できない明細は編集できません。
            </p>
          )}

          {allHaveJpy && !canOpen && (
            <p className="py-4 text-sm text-warning">
              一括編集は 1〜{MAX_EDIT_ITEMS} 件の同一種別で利用できます。
            </p>
          )}

          {step === "form" && canOpen && (
            <div className="flex flex-col gap-3">
              {hasUnfinishedRunnerPlan && (
                <p className="text-sm text-warning">
                  未完了の編集計画があります。先に一覧の編集計画を解決してください。
                </p>
              )}
              <p className="text-sm text-base-content/70">
                変更する項目にチェックを入れ、値を指定してください。
              </p>
              <p className="text-sm text-base-content/60">日付と金額は一括編集できません。</p>
              <EditFields
                mode={mode}
                masters={masters}
                draft={draft}
                onChange={setDraft}
                fields={fields}
                selected={effectiveSelected}
                onToggle={toggleField}
              />
              {error && <p className="text-sm text-error">{error}</p>}
            </div>
          )}

          {step === "review" && changes && plan && (
            <div className="flex flex-col gap-3">
              <ul className="flex flex-col gap-3">
                {plan.items.map((item) => (
                  <li key={item.before.id} className="rounded-box border border-base-300 p-3">
                    <p className="text-sm font-medium">
                      {beforeLabel(item)}・{identityLabel(item)}
                    </p>
                    <div className="mt-2">
                      <EditReview
                        before={item.before}
                        after={previewSnapshot(item.before, changes)}
                        changes={changes}
                        masters={masters}
                        showNotice={false}
                      />
                    </div>
                  </li>
                ))}
              </ul>
              {error && <p className="text-sm text-error">{error}</p>}
            </div>
          )}

          {step === "result" && (
            <div className="flex flex-col gap-3">
              {runnerPlan ? (
                <>
                  <div role="status" className="alert alert-info">
                    <span>{itemStatus(runnerPlan)}</span>
                  </div>
                  {stopped && (
                    <p className="text-sm text-warning">
                      新しい送信を停止しました。送信中または結果不明の項目は先に照合してください。
                    </p>
                  )}
                  {snapshot.error && <p className="text-sm text-error">{snapshot.error}</p>}
                  {error && <p className="text-sm text-error">{error}</p>}
                </>
              ) : (
                <p className="text-sm text-base-content/70">保存を開始しています…</p>
              )}
            </div>
          )}
        </div>

        {(step === "review" ||
          (step === "form" && canOpen) ||
          (step === "result" &&
            runnerPlan?.items.some(
              (item) => item.status !== "succeeded" && item.status !== "failed",
            ))) && (
          <div className="shrink-0 border-t border-base-300 px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            {step === "form" && canOpen && (
              <button
                type="button"
                className="btn btn-primary btn-block mb-2"
                onClick={() => void handleReview()}
                disabled={busy || runnerBusy || hasUnfinishedRunnerPlan}
              >
                {busy ? "対象を確認中…" : "変更を確認"}
              </button>
            )}
            {step === "review" && changes && plan && (
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn flex-1"
                  onClick={() => {
                    setPlan(null);
                    setChanges(null);
                    setStep("form");
                  }}
                  disabled={busy}
                >
                  戻って修正
                </button>
                <button
                  type="button"
                  className="btn btn-primary flex-1"
                  onClick={handleSave}
                  disabled={busy || runnerBusy || hasUnfinishedRunnerPlan}
                >
                  {busy ? "保存中…" : "この内容で保存"}
                </button>
              </div>
            )}
            {step === "result" && runnerPlan && (
              <div className="flex flex-col gap-2">
                {runnerPlan.items.some(
                  (item) =>
                    item.status === "sending" ||
                    item.status === "unknown" ||
                    item.status === "mirror_pending",
                ) && (
                  <button
                    type="button"
                    className="btn"
                    onClick={handleReconcile}
                    disabled={busy || runnerBusy}
                  >
                    {busy || snapshot.phase === "reconciling" ? "照合中…" : "結果を照合"}
                  </button>
                )}
                {runnerPlan.items.some((item) => item.status === "pending") && !stopped && (
                  <button type="button" className="btn" onClick={handleStop} disabled={busy}>
                    送信を停止
                  </button>
                )}
                {runnerPlan.items.some((item) => item.status === "pending") &&
                  stopped &&
                  !activity.blocked && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleResume}
                      disabled={busy || runnerBusy}
                    >
                      残りを再開
                    </button>
                  )}
              </div>
            )}
          </div>
        )}
      </div>
      <form method="dialog" className="modal-backdrop">
        <button>閉じる</button>
      </form>
    </dialog>
  );
}
