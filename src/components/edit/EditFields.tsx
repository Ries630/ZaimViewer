/** 単体・一括編集フォームで共用する入力欄。 */

import { useId } from "react";
import { editDateError } from "../../lib/edit";

import type { Masters } from "../../api/masters";
import type { EditDraft, EditField, EditMode } from "../../lib/edit";
import { editMasterOptions, type EditMasterOption } from "../../lib/edit-masters";
import { categoriesForModes, genresForCategories } from "../../lib/masters";
import { MAX_EDIT_TEXT_LENGTH } from "../../../worker/src/edit-contract";
import { MAX_AMOUNT } from "../../../worker/src/limits";

interface EditFieldsProps {
  /** 編集対象の種別。 */
  mode: EditMode;
  /** マスタ。未取得なら選択欄を無効化する。 */
  masters: Masters | undefined;
  /** 現在の入力値。 */
  draft: EditDraft;
  /** 入力値を更新する。 */
  onChange: (next: EditDraft) => void;
  /** 表示する欄。 */
  fields: EditField[];
  /** 一括編集時にチェックされた欄。 */
  selected?: ReadonlySet<EditField>;
  /** 一括編集時の欄のチェック状態を変える。 */
  onToggle?: (field: EditField) => void;
}

/** 欄の表示名。 */
const FIELD_LABELS = {
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

/** 種別に応じて口座のマスタを返す。 */
function accountOptions(masters: Masters | undefined) {
  return masters?.accounts ?? [];
}

/** 一括欄の見出しとチェックボックスを出す。 */
function FieldLegend({
  field,
  selected,
  required,
  onToggle,
}: {
  field: EditField;
  selected: boolean;
  required: boolean;
  onToggle: (() => void) | undefined;
}) {
  if (!onToggle) return <legend className="fieldset-legend">{FIELD_LABELS[field]}</legend>;
  return (
    <label className="fieldset-legend cursor-pointer gap-2 font-normal">
      <input
        type="checkbox"
        className="checkbox"
        checked={selected}
        disabled={required}
        onChange={onToggle}
        aria-label={`${FIELD_LABELS[field]}を一括変更`}
      />
      <span>
        {FIELD_LABELS[field]}を変更{required ? "（カテゴリ変更に必須）" : ""}
      </span>
    </label>
  );
}

/** マスタ選択欄。 */
function MasterSelect({
  field,
  value,
  options,
  disabled,
  onChange,
}: {
  field: EditField;
  value: number | null;
  options: EditMasterOption<{ id: number; name: string | null; active: number | null }>[];
  disabled: boolean;
  onChange: (value: number | null) => void;
}) {
  return (
    <select
      className="select w-full text-base"
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => {
        const selectedValue = event.target.value;
        onChange(selectedValue === "" ? null : Number(selectedValue));
      }}
      aria-label={FIELD_LABELS[field]}
    >
      <option value="" disabled>
        未設定
      </option>
      {options.map((option) => (
        <option key={option.id} value={option.id} disabled={option.disabled}>
          {option.name ?? `ID ${option.id}`}
        </option>
      ))}
    </select>
  );
}

/**
 * 編集欄を描画する。
 *
 * @param props 編集対象とフォーム値。
 * @returns 編集入力欄。
 */
export function EditFields({
  mode,
  masters,
  draft,
  onChange,
  fields,
  selected,
  onToggle,
}: EditFieldsProps) {
  const dateErrorId = useId();
  const dateError = editDateError(draft.date);
  const categoryMasters = masters ? categoriesForModes(masters.categories, [mode]) : [];
  const genreMasters = masters
    ? genresForCategories(masters.genres, draft.category_id ? [draft.category_id] : [])
    : [];
  const categories = editMasterOptions(categoryMasters, draft.category_id);
  const genres = editMasterOptions(genreMasters, draft.genre_id);
  const accounts = accountOptions(masters);
  const isSelected = (field: EditField) => selected?.has(field) ?? true;
  // 一括編集では、未選択の欄は見出しだけを残して入力欄を表示しない。
  // draft は親が保持しているため、再選択すれば入力済みの値を復元できる。
  const isInputVisible = (field: EditField) => selected === undefined || isSelected(field);

  return (
    <div className="flex flex-col gap-2">
      {fields.map((field) => (
        <fieldset key={field} className="fieldset">
          <FieldLegend
            field={field}
            selected={isSelected(field)}
            required={
              mode === "payment" && field === "genre_id" && selected?.has("category_id") === true
            }
            onToggle={onToggle ? () => onToggle(field) : undefined}
          />

          {isInputVisible(field) && field === "date" && (
            <>
              <input
                type="date"
                className="input w-full text-base"
                value={draft.date}
                onChange={(event) => onChange({ ...draft, date: event.target.value })}
                aria-label="日付"
                required
                aria-invalid={dateError !== null}
                aria-describedby={dateError ? dateErrorId : undefined}
              />
              {dateError && (
                <p id={dateErrorId} role="alert" className="text-sm text-error">
                  {dateError}
                </p>
              )}
            </>
          )}

          {isInputVisible(field) && field === "amount" && (
            <input
              type="number"
              inputMode="numeric"
              min="0"
              max={MAX_AMOUNT}
              step={1}
              className="input w-full text-base"
              value={draft.amount}
              onChange={(event) => onChange({ ...draft, amount: event.target.value })}
              aria-label="金額"
            />
          )}

          {isInputVisible(field) && field === "category_id" && (
            <MasterSelect
              field={field}
              value={draft.category_id}
              options={categories}
              disabled={categories.length === 0}
              onChange={(category_id) =>
                onChange({
                  ...draft,
                  category_id,
                  // カテゴリが変わったら、別カテゴリのジャンルを条件に残さない。
                  genre_id:
                    category_id !== draft.category_id &&
                    draft.genre_id !== null &&
                    !genresForCategories(masters?.genres ?? [], [category_id ?? 0]).some(
                      (genre) => genre.id === draft.genre_id,
                    )
                      ? null
                      : draft.genre_id,
                })
              }
            />
          )}

          {isInputVisible(field) && field === "genre_id" && (
            <MasterSelect
              field={field}
              value={draft.genre_id}
              options={genres}
              disabled={genres.length === 0}
              onChange={(genre_id) => onChange({ ...draft, genre_id })}
            />
          )}

          {isInputVisible(field) && (field === "from_account_id" || field === "to_account_id") && (
            <MasterSelect
              field={field}
              value={draft[field]}
              options={editMasterOptions(accounts, draft[field])}
              disabled={accounts.length === 0}
              onChange={(value) => onChange({ ...draft, [field]: value })}
            />
          )}

          {isInputVisible(field) && (field === "name" || field === "place") && (
            <input
              type="text"
              className="input w-full text-base"
              value={draft[field]}
              maxLength={MAX_EDIT_TEXT_LENGTH}
              onChange={(event) => onChange({ ...draft, [field]: event.target.value })}
              aria-label={FIELD_LABELS[field]}
            />
          )}

          {isInputVisible(field) && field === "comment" && (
            <textarea
              className="textarea min-h-24 w-full text-base"
              value={draft.comment}
              maxLength={MAX_EDIT_TEXT_LENGTH}
              onChange={(event) => onChange({ ...draft, comment: event.target.value })}
              aria-label="メモ"
            />
          )}
        </fieldset>
      ))}
    </div>
  );
}
