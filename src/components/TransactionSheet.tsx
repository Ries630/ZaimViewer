/**
 * 明細 1 件の詳細シート。
 */

import { Fragment, type RefObject } from "react";

import type { Transaction } from "../api/transactions";
import { formatDateHeading, isFutureDate } from "../lib/format";
import { detailFields } from "../lib/transaction";
import { Amount } from "./Amount";

interface TransactionSheetProps {
  /** シートの開閉を親が握るための参照。 */
  ref: RefObject<HTMLDialogElement | null>;
  /** 表示する明細。まだ一度も開いていなければ null。 */
  transaction: Transaction | null;
  /** JST の今日（`YYYY-MM-DD`）。未来の明細に印を付けるのに使う。 */
  today: string;
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
export function TransactionSheet({ ref, transaction, today }: TransactionSheetProps) {
  return (
    <dialog ref={ref} className="modal modal-bottom sm:modal-middle" aria-label="明細">
      <div className="modal-box flex max-h-[85vh] flex-col gap-3 p-0">
        {transaction && (
          <>
            <div className="border-b border-base-300 px-5 pt-5 pb-3">
              <div className="flex items-baseline gap-2">
                <h2 className="text-base font-bold">{formatDateHeading(transaction.date)}</h2>
                {isFutureDate(transaction.date, today) && (
                  <span className="badge badge-info badge-sm">予定</span>
                )}
              </div>
              <p className="mt-1 text-2xl">
                <Amount transaction={transaction} />
              </p>
            </div>

            {/* ラベル幅は最長のラベルに揃え、残りをすべて値に渡す。
                値だけが折り返せればよく、ラベルは折り返させない */}
            <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 overflow-y-auto px-5">
              {detailFields(transaction).map((field) => (
                <Fragment key={field.label}>
                  <dt className="text-sm whitespace-nowrap text-base-content/60">{field.label}</dt>
                  <dd className="break-words">{field.value}</dd>
                </Fragment>
              ))}
            </dl>
          </>
        )}

        <form method="dialog" className="border-t border-base-300 px-5 pt-3 pb-safe-bottom">
          <button className="btn btn-block mb-5">閉じる</button>
        </form>
      </div>

      <form method="dialog" className="modal-backdrop">
        <button>閉じる</button>
      </form>
    </dialog>
  );
}
