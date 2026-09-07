/** アプリが所有する編集計画の進捗と操作を一覧へ表示する。 */

import { useOnline } from "../../hooks/useOnline";
import { type EditChanges, type EditField, type EditPlan } from "../../lib/edit";
import { isRunnerBusy } from "../../lib/edit-plan-runner";
import { formatAmount } from "../../lib/format";
import { useEditRunner } from "./EditPlanProvider";

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

/** 項目別の処理結果をまとめる。 */
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

/** 初回送信も手動再開も同じ Runner の状態として表示する。 */
export function EditPlanStatus() {
  const { runner, snapshot } = useEditRunner();
  const { plan, phase, error, stopReason } = snapshot;
  const online = useOnline();
  const busy = isRunnerBusy(snapshot);
  const canStop = phase === "running" || phase === "creating" || phase === "reconciling";

  if (!plan) {
    if (phase === "idle" && !error) return null;
    return (
      <div className="border-b border-base-300 px-4 py-2 text-sm" aria-live="polite">
        {busy && <p>{phase === "loading" ? "編集計画を取得中…" : "保存を準備中…"}</p>}
        {error && <p className="text-error">{error}</p>}
        {canStop && (
          <button type="button" className="btn btn-ghost" onClick={() => runner.stop()}>
            送信を停止
          </button>
        )}
        {error && phase === "paused" && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!online}
            onClick={() => void runner.refresh()}
          >
            最新状態を取得
          </button>
        )}
      </div>
    );
  }
  const pendingItems = plan.items.filter((item) => item.status === "pending");
  const unresolved = plan.items.some(
    (item) =>
      item.status === "sending" || item.status === "unknown" || item.status === "mirror_pending",
  );
  // SAFETY: changes は editChangesSchema で検証済みなのでキーは EditField に限る。
  const changeFields = Object.keys(plan.changes) as EditField[];

  return (
    <div className="border-b border-base-300 px-4 py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <p aria-live="polite">
          編集計画: <span className="font-medium">{statusText(plan)}</span>
          {phase === "running" && <span>（送信中）</span>}
          {phase === "stopping" && <span>（停止待ち）</span>}
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void runner.refresh()}
            disabled={busy || !online}
          >
            {phase === "loading" ? "取得中…" : "最新状態を取得"}
          </button>
          {unresolved && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void runner.reconcile()}
              disabled={busy || !online}
            >
              {phase === "reconciling" ? "照合中…" : "送信結果を照合"}
            </button>
          )}
          {pendingItems.length > 0 && !busy && !unresolved && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void runner.resume()}
              disabled={!online}
            >
              残りを手動再開
            </button>
          )}
          {(canStop || phase === "stopping") && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => runner.stop()}
              disabled={phase === "stopping"}
            >
              {phase === "stopping" ? "停止待ち…" : "送信を停止"}
            </button>
          )}
          {!busy && !unresolved && (
            <button type="button" className="btn btn-ghost" onClick={() => runner.dismiss()}>
              {pendingItems.length > 0 ? "残りの編集を取りやめる" : "結果を閉じる"}
            </button>
          )}
        </div>
      </div>
      {stopReason && <p className="mt-1 text-warning">{stopReason}</p>}
      {pendingItems.length > 0 && !busy && !unresolved && (
        <p className="mt-1 text-base-content/70">取りやめても、保存済みの変更は元に戻りません。</p>
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
