/**
 * マスタ（カテゴリ・ジャンル・口座）からの複数選択。
 */

/** 選択肢 1 つ。マスタの 3 種類に共通する部分だけを見る。 */
export interface SelectOption {
  /** マスタの ID。 */
  id: number;
  /** 表示名。 */
  name: string | null;
}

/** 見出しでまとめた選択肢。見出しが要らないときは `label` を null にする。 */
export interface OptionGroup {
  /** React の key。 */
  key: string;
  /** 見出し。null なら見出しを出さない。 */
  label: string | null;
  /** そのまとまりの選択肢。 */
  options: SelectOption[];
}

interface MasterMultiSelectProps {
  /** 項目名。 */
  legend: string;
  /** 選択肢。 */
  groups: OptionGroup[];
  /** 選択中の ID。 */
  selected: number[];
  /** 選択肢が 0 件のときに出す説明。 */
  emptyLabel: string;
  /** 選択が変わったときに呼ぶ。 */
  onChange: (ids: number[]) => void;
}

/**
 * 折り畳んだ中に選択肢を並べる。
 *
 * カテゴリ 46 / ジャンル 129 / 口座 36 をすべて開いたまま並べるとシートが
 * 縦に伸びきるので、既定は畳んでおき、見出しに選択件数を出す。
 * `details` を使うのは開閉の状態を DOM に持たせるためで、React 側に state が要らない。
 *
 * @param props 選択肢と選択状態。
 * @returns 複数選択の入力欄。
 */
export function MasterMultiSelect({
  legend,
  groups,
  selected,
  emptyLabel,
  onChange,
}: MasterMultiSelectProps) {
  /**
   * 選択の入り切りを反映する。
   *
   * @param id 操作された ID。
   * @param checked 入れるなら true。
   */
  const toggle = (id: number, checked: boolean) => {
    onChange(checked ? [...selected, id] : selected.filter((value) => value !== id));
  };

  const total = groups.reduce((sum, group) => sum + group.options.length, 0);

  return (
    <details className="collapse-arrow collapse border border-base-300">
      <summary className="collapse-title min-h-0 py-3 text-sm font-medium">
        {legend}
        <span className="ml-2 font-normal text-base-content/60">
          {selected.length > 0 ? `${selected.length} 件` : "すべて"}
        </span>
      </summary>

      <div className="collapse-content">
        {/* 高さの上限は collapse-content ではなく内側に置く。daisyUI が開閉の
            アニメーションで collapse-content の max-height を握っているため */}
        <div className="max-h-64 overflow-y-auto">
          {total === 0 ? (
            <p className="py-2 text-sm text-base-content/60">{emptyLabel}</p>
          ) : (
            groups.map((group) => (
              // label は inline-flex なので、包まずに並べると 1 行に流れる
              <div key={group.key} className="flex flex-col">
                {group.label !== null && (
                  <p className="pt-3 pb-1 text-xs font-medium text-base-content/60">
                    {group.label}
                  </p>
                )}
                {group.options.map((option) => (
                  <label key={option.id} className="label justify-start gap-2 py-1.5">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-sm"
                      checked={selected.includes(option.id)}
                      onChange={(event) => toggle(option.id, event.target.checked)}
                    />
                    {option.name ?? `#${option.id}`}
                  </label>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </details>
  );
}
