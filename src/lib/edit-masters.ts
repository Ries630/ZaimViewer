/** 編集先として使うマスタの選択肢を組み立てる。 */

/** 編集欄で使うマスタに共通する値。 */
export interface EditMaster {
  /** マスタ ID。 */
  id: number;
  /** Zaim での有効・無効。1 以外は削除済みとして扱う。 */
  active: number | null;
}

/** 選択欄に表示するマスタ。無効な現在値だけ disabled になる。 */
export type EditMasterOption<T extends EditMaster> = T & {
  /** 現在値として表示するだけで、新しい値には選べないか。 */
  disabled?: boolean;
};

/**
 * 編集先として選べるマスタだけを残す。
 *
 * 削除済みのマスタは新しい編集先にできないが、編集中の明細が現在参照している
 * 場合は値を失わせないために disabled の選択肢として残す。
 *
 * @param options API から取得したマスタ。
 * @param currentId 編集中の現在値。
 * @returns 有効なマスタと、必要なら disabled の現在値。
 */
export function editMasterOptions<T extends EditMaster>(
  options: readonly T[],
  currentId: number | null,
): EditMasterOption<T>[] {
  return options
    .filter((option) => option.active === 1 || option.id === currentId)
    .map((option): EditMasterOption<T> =>
      option.id === currentId && option.active !== 1 ? { ...option, disabled: true } : option,
    );
}
