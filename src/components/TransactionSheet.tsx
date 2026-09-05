/**
 * 明細 1 件の詳細シート。
 */

import { Fragment, useEffect, useState, type RefObject } from "react";

import type { Masters } from "../api/masters";
import type { Transaction } from "../api/transactions";
import { formatDateHeading, isFutureDate } from "../lib/format";
import { editableFields, type EditCapabilities, type EditMode } from "../lib/edit";
import { commentSegments, detailFields } from "../lib/transaction";
import { Amount } from "./Amount";
import { SingleEditForm } from "./edit/SingleEditForm";
import { ModeBadge } from "./ModeBadge";

interface CommentTextProps {
  /** 表示するメモ。 */
  comment: string;
}

/**
 * メモを、タグだけ見分けが付く形で出す。
 *
 * タグ（`#MUFG取込` など）は自動連携の出どころや処理待ちを表しており、
 * メモのある明細のほぼ全件に付いている。平文と同じ見た目だと埋もれる。
 *
 * @param props メモ。
 * @returns タグを囲んだメモ。
 */
function CommentText({ comment }: CommentTextProps) {
  return (
    <>
      {commentSegments(comment).map((segment, index) =>
        segment.tag ? (
          // badge は inline-flex なので、行の途中に混ざると下端が揃わない。
          // 素の span に色と角丸だけ当てて、文字として流す
          <span key={index} className="rounded bg-base-200 px-1 text-sm text-base-content/70">
            {segment.text}
          </span>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

interface TransactionSheetProps {
  /** シートの開閉を親が握るための参照。 */
  ref: RefObject<HTMLDialogElement | null>;
  /** 表示する明細。まだ一度も開いていなければ null。 */
  transaction: Transaction | null;
  /** JST の今日（`YYYY-MM-DD`）。未来の明細に印を付けるのに使う。 */
  today: string;
  /** 編集フォームで使うマスタ。 */
  masters?: Masters;
  /** Worker が確認した編集能力。 */
  editCapabilities?: EditCapabilities;
  /** 保存後に一覧とマスタのキャッシュを更新する。 */
  onUpdated?: () => void;
}

/**
 * 下から出る明細の詳細シート。
 *
 * 一覧の主表示は 1 行に切り詰めてあり、切れた先を読む手段が無かった
 * （[#19](https://github.com/Ries630/ZaimViewer/issues/19)）。ここでは
 * 折り返して全文を出す。
 *
 * 絞り込みシートと同じ `dialog` のパターンに揃えてある。ドロワーや全画面も
 * 比べたが、背後に一覧が残って次の明細へ戻りやすいこと、`dialog` の
 * top-layer と ESC と focus trap をブラウザに任せられることでこれを採った
 * （ADR-0029）。
 *
 * **閉じても `transaction` は消さない。** daisyUI の modal は閉じるときに
 * 短い遷移が入るので、そこで中身を空にすると一瞬だけ空のシートが見える。
 *
 * @param props 明細と今日の日付。
 * @returns 詳細シート。
 */
export function TransactionSheet({
  ref,
  transaction,
  today,
  masters,
  editCapabilities,
  onUpdated,
}: TransactionSheetProps) {
  const [editing, setEditing] = useState(false);

  // 別明細を選んだときは、前の明細の編集モードを持ち越さない。
  useEffect(() => setEditing(false), [transaction?.id]);

  const canEdit =
    transaction !== null &&
    transaction.currency_code === "JPY" &&
    editCapabilities !== undefined &&
    // SAFETY: Worker の読み取り API はこの 3 種別を返し、未知の種別は capability から除外される。
    editableFields(transaction.mode as EditMode, editCapabilities, transaction.receipt_id).length >
      0;

  return (
    <dialog
      ref={ref}
      className="modal modal-bottom sm:modal-middle"
      aria-label="明細"
      onClose={() => setEditing(false)}
    >
      <div className="modal-box flex max-h-[85vh] flex-col gap-3 p-0">
        {transaction && !editing && (
          <>
            <div className="border-b border-base-300 px-5 pt-5 pb-3">
              <div className="flex items-baseline gap-2">
                <h2 className="text-base font-bold">{formatDateHeading(transaction.date)}</h2>
                {isFutureDate(transaction.date, today) && (
                  <span className="badge badge-info badge-sm">予定</span>
                )}
              </div>
              {/* 種別は金額を修飾するものなので隣に置く。ラベルと値の対に
                  するより、値が 3 つに限られるぶんバッジの方が速く読める */}
              <p className="mt-1 flex items-center gap-2">
                <Amount transaction={transaction} className="text-2xl" />
                <ModeBadge mode={transaction.mode} />
              </p>
            </div>

            {/* ラベル幅は最長のラベルに揃え、残りをすべて値に渡す。
                値だけが折り返せればよく、ラベルは折り返させない */}
            <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 overflow-y-auto px-5">
              {detailFields(transaction).map((field) => (
                <Fragment key={field.key}>
                  <dt className="text-sm whitespace-nowrap text-base-content/60">{field.label}</dt>
                  <dd className="break-words">
                    {field.key === "comment" ? <CommentText comment={field.value} /> : field.value}
                  </dd>
                </Fragment>
              ))}
            </dl>
          </>
        )}

        {transaction && editing && editCapabilities && (
          <div className="overflow-y-auto px-5 pt-5">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="text-base font-bold">明細を編集</h2>
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
                詳細に戻る
              </button>
            </div>
            <SingleEditForm
              key={transaction.id}
              transaction={transaction}
              masters={masters}
              capabilities={editCapabilities}
              onCancel={() => setEditing(false)}
              onUpdated={onUpdated ?? (() => undefined)}
            />
          </div>
        )}

        <form method="dialog" className="border-t border-base-300 px-5 pt-3 pb-safe-bottom">
          {!editing && canEdit && (
            <button
              type="button"
              className="btn btn-primary btn-block mb-2"
              onClick={() => setEditing(true)}
            >
              編集
            </button>
          )}
          <button className="btn btn-block mb-5">閉じる</button>
        </form>
      </div>

      <form method="dialog" className="modal-backdrop">
        <button>閉じる</button>
      </form>
    </dialog>
  );
}
