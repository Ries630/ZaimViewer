/** フィルタ結果に対する一括編集シート。 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  createEditPlan,
  EditApiError,
  executeEditPlan,
  getEditPlan,
  reconcileEditPlan,
} from "../../api/edits";
import type { Masters } from "../../api/masters";
import type { Transaction, TransactionFilter } from "../../api/transactions";
import { formatAmount } from "../../lib/format";
import {
  bulkEditableFields,
  changesFromBulk,
  EDIT_INTERVAL_MS,
  isEditExecutionUncertain,
  MAX_EDIT_ITEMS,
  previewSnapshot,
  type EditCapabilities,
  type EditChanges,
  type EditDraft,
  type EditField,
  type EditPlan,
} from "../../lib/edit";
import { EditFields } from "./EditFields";
import { EditReview } from "./EditReview";
import { setActivePlan } from "./EditPlanStatus";
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
  /** シートを閉じる。 */
  onCancel: () => void;
  /** ミラー更新後に一覧を再取得する。 */
  onUpdated: () => void;
}

type Step = "form" | "review" | "result";

const LABELS = {
  date: "日付",
  amount: "金額",
  category_id: "カテゴリ",
  genre_id: "ジャンル",
  from_account_id: "出金元",
  to_account_id: "入金先",
  name: "品名",
  place: "店舗",
  comment: "メモ",
} satisfies Record<EditField, string>;

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

function valueText(field: EditField, value: EditDraft, masters: Masters | undefined): string {
  if (field === "name" || field === "place" || field === "comment") return value[field];
  if (field === "category_id") {
    return masters?.categories.find((item) => item.id === value.category_id)?.name ?? "（未設定）";
  }
  if (field === "genre_id") {
    return masters?.genres.find((item) => item.id === value.genre_id)?.name ?? "（未設定）";
  }
  if (field === "from_account_id" || field === "to_account_id") {
    return masters?.accounts.find((item) => item.id === value[field])?.name ?? "（未設定）";
  }
  return "（一括変更不可）";
}

function withUnknown(plan: EditPlan, id: number, message: string): EditPlan {
  const target = plan.items.find((candidate) => candidate.before.id === id);
  // GET が送信中を返した場合は、その状態を保ったまま照合へ回す。
  if (target && target.status !== "pending") return plan;
  return {
    ...plan,
    items: plan.items.map((item) =>
      item.before.id === id ? { ...item, status: "unknown", message } : item,
    ),
  };
}

/** サーバーが固定した対象を確認画面へ表示する。 */
function beforeLabel(plan: EditPlan["items"][number]): string {
  const before = plan.before;
  return `#${before.id} ${before.date}・${formatAmount(before.amount, before.currency_code)}`;
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
  onCancel,
  onUpdated,
}: BulkEditSheetProps) {
  const [draft, setDraft] = useState<EditDraft>(EMPTY_DRAFT);
  const [selected, setSelected] = useState<ReadonlySet<EditField>>(new Set());
  const [step, setStep] = useState<Step>("form");
  const [changes, setChanges] = useState<EditChanges | null>(null);
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopped, setStopped] = useState(false);
  const activity = useEditActivity();
  const activityRef = useRef(activity);
  const stopRef = useRef(false);
  useEffect(() => {
    activityRef.current = activity;
  }, [activity]);
  useEffect(() => {
    stopRef.current = false;
    return () => {
      // シートのアンマウント後に次の明細へ送らない。
      stopRef.current = true;
    };
  }, []);

  const handleDialogClose = () => {
    stopRef.current = true;
    setStopped(true);
    if (plan?.items.every((item) => item.status === "succeeded" || item.status === "failed")) {
      // 完了済みの結果だけを次回へ持ち越さず、次の一括操作をフォームから始める。
      setDraft(EMPTY_DRAFT);
      setSelected(new Set());
      setStep("form");
      setChanges(null);
      setPlan(null);
      setError(null);
      setStopped(false);
      setActivePlan(null);
    }
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

  const handleReview = async () => {
    stopRef.current = false;
    const next = changesFromBulk(selected, draft);
    setError(null);
    if (!next || Object.keys(next).length === 0) {
      setError("変更する項目を 1 つ以上選択してください");
      return;
    }
    if (mode === "payment" && next.category_id !== undefined && next.genre_id === undefined) {
      setError("カテゴリを一括変更するときは、ジャンルも選択してください");
      return;
    }
    if (activity.blocked) {
      setError(
        activity.hidden ? "画面を表示してから確認してください" : "オフラインのため確認できません",
      );
      return;
    }
    setBusy(true);
    try {
      // 対象のスナップショットは確認画面へ進む時点でサーバーに固定する。
      const created = await createEditPlan({ source: "filter", filter, changes: next });
      setChanges(next);
      setPlan(created);
      setStep("review");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "対象を確認できませんでした");
    } finally {
      setBusy(false);
    }
  };

  const executeRemaining = async (initial: EditPlan) => {
    let current = initial;
    const notifyUpdated = () => {
      if (current.items.some((item) => item.status === "succeeded")) {
        onUpdated();
      }
    };
    setPlan(current);
    setStopped(false);
    setActivePlan(current.id, current, true);
    try {
      for (;;) {
        if (stopRef.current || activityRef.current.blocked || activity.wasInterrupted()) {
          if (activityRef.current.blocked) stopRef.current = true;
          setStopped(true);
          if (ref.current?.open !== false) setPlan(current);
          return;
        }
        const next = current.items.find((item) => item.status === "pending");
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
          return;
        }
        if (!next) {
          setPlan(current);
          return;
        }
        try {
          // シート実行中は計画表示からの再開・照合を受け付けない。
          setActivePlan(current.id, current, true);
          current = await executeEditPlan(current.id, next.before.id);
          setPlan(current);
          setActivePlan(current.id, current, true);
          notifyUpdated();
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : "結果を確認できませんでした";
          if (!isEditExecutionUncertain(caught instanceof EditApiError ? caught : null)) {
            setPlan(current);
            setError(message);
            setStopped(true);
            return;
          }
          // 送信が届いた可能性を考え、同じ計画を読み直す。execute は再送しない。
          try {
            current = withUnknown(await getEditPlan(current.id), next.before.id, message);
          } catch {
            current = withUnknown(current, next.before.id, message);
          }
          setPlan(current);
          setActivePlan(current.id, current, true);
          const confirmed =
            current.items.find((item) => item.before.id === next.before.id)?.status === "succeeded";
          setError(confirmed ? null : message);
          setStopped(
            current.items.some((item) => item.status !== "succeeded" && item.status !== "failed"),
          );
          return;
        }
        const result = current.items.find((item) => item.before.id === next.before.id);
        if (
          result?.status === "sending" ||
          result?.status === "unknown" ||
          result?.status === "mirror_pending"
        ) {
          setStopped(true);
          return;
        }
        // Zaim 側への連続要求を詰めず、画面にも進捗を描画する。
        await new Promise((resolve) => window.setTimeout(resolve, EDIT_INTERVAL_MS));
      }
    } finally {
      notifyUpdated();
      if (current.items.every((item) => item.status === "succeeded" || item.status === "failed"))
        setActivePlan(null);
      else setActivePlan(current.id, current, false);
    }
  };

  const handleSave = async () => {
    if (!changes || !plan || busy) return;
    if (activity.blocked) {
      setError(
        activity.hidden ? "画面を表示してから保存してください" : "オフラインのため保存できません",
      );
      return;
    }
    setBusy(true);
    activity.resetInterruption();
    stopRef.current = false;
    setError(null);
    try {
      setStep("result");
      await executeRemaining(plan);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存を開始できませんでした");
    } finally {
      setBusy(false);
    }
  };

  const handleResume = async () => {
    if (!plan || busy || activity.blocked) return;
    setBusy(true);
    activity.resetInterruption();
    stopRef.current = false;
    setError(null);
    try {
      await executeRemaining(plan);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "再開できませんでした");
    } finally {
      setBusy(false);
    }
  };

  const handleStop = () => {
    stopRef.current = true;
    setStopped(true);
  };

  const handleReconcile = async () => {
    if (!plan || busy) return;
    if (activity.blocked) {
      setError(
        activity.hidden ? "画面を表示してから照合してください" : "オフラインのため照合できません",
      );
      return;
    }
    const targets = plan.items.filter(
      (item) =>
        item.status === "sending" || item.status === "unknown" || item.status === "mirror_pending",
    );
    if (targets.length === 0) return;
    setBusy(true);
    stopRef.current = false;
    setError(null);
    let current = plan;
    let clearActive = false;
    let updated = false;
    const notifyUpdated = () => {
      if (!updated && current.items.some((item) => item.status === "succeeded")) {
        updated = true;
        onUpdated();
      }
    };
    setActivePlan(current.id, current, true);
    try {
      for (const item of targets) {
        if (activityRef.current.blocked) {
          setStopped(true);
          return;
        }
        current = await reconcileEditPlan(current.id, item.before.id);
        setPlan(current);
        setActivePlan(current.id, current, true);
        notifyUpdated();
      }
      if (current.items.every((item) => item.status === "succeeded" || item.status === "failed")) {
        clearActive = true;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "照合できませんでした");
    } finally {
      notifyUpdated();
      if (clearActive) setActivePlan(null);
      else setActivePlan(current.id, current, false);
      setBusy(false);
    }
  };

  const canOpen = allHaveJpy && fields.length > 0 && total > 0 && total <= MAX_EDIT_ITEMS;
  const targetCount = total ?? items.length;
  const reviewCount = plan?.items.length ?? targetCount;
  // SAFETY: changes は editChangesSchema で検証済みなので、キーは EditChanges の項目に限られる。
  const changedFields = changes ? (Object.keys(changes) as EditField[]) : [];

  return (
    <dialog
      ref={ref}
      className="modal modal-bottom sm:modal-middle"
      aria-label="一括編集"
      onClose={handleDialogClose}
    >
      <div className="modal-box flex max-h-[85vh] flex-col gap-3 p-0">
        <div className="border-b border-base-300 px-5 pt-5 pb-3">
          <h2 className="text-base font-bold">一括編集</h2>
          <p className="mt-1 text-sm text-base-content/70">
            {targetCount} 件（{mode === "payment" ? "支出" : mode === "income" ? "収入" : "振替"}）
          </p>
        </div>

        <div className="overflow-y-auto px-5">
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
              <p className="text-sm text-base-content/70">
                変更する項目にチェックを入れ、値を指定してください。
              </p>
              <EditFields
                mode={mode}
                masters={masters}
                draft={draft}
                onChange={setDraft}
                fields={fields}
                selected={selected}
                onToggle={toggleField}
              />
              {error && <p className="text-sm text-error">{error}</p>}
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleReview()}
                disabled={busy}
              >
                {busy ? "対象を確認中…" : "変更を確認"}
              </button>
            </div>
          )}

          {step === "review" && changes && plan && (
            <div className="flex flex-col gap-3">
              <div role="alert" className="alert alert-warning">
                <span>{reviewCount} 件に次の変更を適用します。</span>
              </div>
              <div className="rounded-box border border-base-300 p-3">
                <p className="text-sm font-medium">サーバーが固定した変更前の対象</p>
                <p className="mt-1 text-sm text-base-content/70">
                  対象ごとに変更前後を確認してから保存してください。
                </p>
                <ul className="mt-2 flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
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
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
                {changedFields.map((field) => (
                  <div key={field} className="contents">
                    <dt className="text-base-content/60">{LABELS[field]}</dt>
                    <dd className="break-words font-medium">
                      {valueText(field, draft, masters) || "（空文字にする）"}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-sm text-base-content/60">日付と金額は一括編集できません。</p>
              {error && <p className="text-sm text-error">{error}</p>}
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn flex-1"
                  onClick={() => {
                    // 未実行計画を画面に残さず、次の確認で新しい計画を作る。
                    setActivePlan(null);
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
                  onClick={() => void handleSave()}
                  disabled={busy}
                >
                  {busy ? "保存中…" : "この内容で保存"}
                </button>
              </div>
            </div>
          )}

          {step === "result" && plan && (
            <div className="flex flex-col gap-3">
              <div role="status" className="alert alert-info">
                <span>{itemStatus(plan)}</span>
              </div>
              {stopped && (
                <p className="text-sm text-warning">
                  新しい送信を停止しました。送信中または結果不明の項目は先に照合してください。
                </p>
              )}
              {activity.blocked && (
                <p className="text-sm text-warning">
                  オフラインまたはバックグラウンドのため停止中です。
                </p>
              )}
              {error && <p className="text-sm text-error">{error}</p>}
              {plan.items.some(
                (item) =>
                  item.status === "sending" ||
                  item.status === "unknown" ||
                  item.status === "mirror_pending",
              ) && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => void handleReconcile()}
                  disabled={busy}
                >
                  {busy ? "照合中…" : "結果を照合"}
                </button>
              )}
              {plan.items.some((item) => item.status === "pending") && !stopped && (
                <button type="button" className="btn" onClick={handleStop} disabled={busy}>
                  ここで停止
                </button>
              )}
              {plan.items.some((item) => item.status === "pending") &&
                stopped &&
                !activity.blocked && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handleResume()}
                    disabled={busy}
                  >
                    残りを再開
                  </button>
                )}
            </div>
          )}
        </div>

        <form method="dialog" className="border-t border-base-300 px-5 pt-3 pb-safe-bottom">
          <button className="btn btn-block mb-5" onClick={onCancel}>
            閉じる
          </button>
        </form>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button>閉じる</button>
      </form>
    </dialog>
  );
}
