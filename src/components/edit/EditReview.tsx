/** 保存前に変更内容を確認する表示。 */

import type { Masters } from "../../api/masters";
import type { EditChanges, EditSnapshot } from "../../lib/edit";
import { formatAmount } from "../../lib/format";

interface EditReviewProps {
  /** 更新前の値。 */
  before: EditSnapshot;
  /** 確認用の更新後の値。 */
  after: EditSnapshot;
  /** 実際に送る変更項目。 */
  changes: EditChanges;
  /** マスタ名。 */
  masters: Masters | undefined;
  /** 一括対象の一覧では、外側の見出しを使うため通知を省略する。 */
  showNotice?: boolean;
}

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
} satisfies Record<keyof EditChanges, string>;

function nameOf(
  field: keyof EditChanges,
  value: string | number | null,
  masters: Masters | undefined,
  currency: string | null,
): string {
  if (value === null || value === "" || value === 0) return "（未設定）";
  if (field === "amount") return formatAmount(Number(value), currency);
  if (field === "category_id") {
    return masters?.categories.find((item) => item.id === value)?.name ?? `ID ${value}`;
  }
  if (field === "genre_id") {
    return masters?.genres.find((item) => item.id === value)?.name ?? `ID ${value}`;
  }
  if (field === "from_account_id" || field === "to_account_id") {
    return masters?.accounts.find((item) => item.id === value)?.name ?? `ID ${value}`;
  }
  return String(value);
}

/**
 * 変更項目だけを更新前後で並べる。
 *
 * @param props 更新前後の値と変更項目。
 * @returns 確認表示。
 */
export function EditReview({
  before,
  after,
  changes,
  masters,
  showNotice = true,
}: EditReviewProps) {
  // SAFETY: changes は editChangesSchema で検証済みなので、キーは EditChanges の項目に限られる。
  const fields = Object.keys(changes) as (keyof EditChanges)[];
  return (
    <div className="flex flex-col gap-3">
      {showNotice && (
        <div role="alert" className="alert alert-warning">
          <span>この内容を Zaim に保存します。項目を確認してください。</span>
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr_1fr] items-baseline gap-x-3 gap-y-2 text-sm">
        <div className="contents text-base-content/60">
          <dt>項目</dt>
          <dd>変更前</dd>
          <dd>変更後</dd>
        </div>
        {fields.map((field) => (
          <div key={field} className="contents">
            <dt className="whitespace-nowrap text-base-content/60">{LABELS[field]}</dt>
            <dd className="min-w-0 break-words">
              {nameOf(field, before[fieldToSnapshotKey(field)], masters, before.currency_code)}
            </dd>
            <dd className="min-w-0 break-words font-medium">
              {nameOf(field, after[fieldToSnapshotKey(field)], masters, after.currency_code)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** EditChanges のキーを snapshot の同名キーへ合わせる。 */
function fieldToSnapshotKey(field: keyof EditChanges): keyof EditSnapshot {
  return field;
}
