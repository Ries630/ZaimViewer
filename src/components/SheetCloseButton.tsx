/** ダイアログの右上に置く閉じる操作。 */
export function SheetCloseButton() {
  return (
    <form method="dialog" className="shrink-0">
      <button
        className="btn btn-ghost btn-square min-h-11 min-w-11"
        aria-label="閉じる"
        title="閉じる"
      >
        <span aria-hidden="true" className="text-2xl">
          ×
        </span>
      </button>
    </form>
  );
}
