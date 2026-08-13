/**
 * 種別（支出 / 収入 / 振替）の指定。
 */

import { MODES, type FilterState, type Mode } from "../../lib/filter";

interface ModeFieldProps {
  /** 現在の状態。 */
  filter: FilterState;
  /** 状態を差し替える。 */
  onChange: (next: FilterState) => void;
}

/**
 * 種別を複数選ぶ。
 *
 * **最後の 1 つは外せない。** API は「指定なし = 制限なし」なので、0 個の状態を
 * そのまま送ると意図と逆に全件が出る。ここで下限を守る。
 *
 * @param props 状態と更新関数。
 * @returns 種別の選択欄。
 */
export function ModeField({ filter, onChange }: ModeFieldProps) {
  /**
   * 種別の入り切りを状態に落とす。
   *
   * @param mode 操作された種別。
   * @param checked 入れるなら true。
   */
  const toggle = (mode: Mode, checked: boolean) => {
    const modes = checked
      ? MODES.map((item) => item.value).filter(
          (value) => value === mode || filter.modes.includes(value),
        )
      : filter.modes.filter((value) => value !== mode);

    if (modes.length === 0) return;
    onChange({ ...filter, modes });
  };

  return (
    <fieldset className="fieldset">
      <legend className="fieldset-legend">種別</legend>
      <div className="join">
        {MODES.map((mode) => {
          const checked = filter.modes.includes(mode.value);
          return (
            <input
              key={mode.value}
              type="checkbox"
              className="btn join-item btn-sm"
              aria-label={mode.label}
              checked={checked}
              // 最後の 1 つを外そうとしても状態は変わらないので、そうと分かるようにする
              disabled={checked && filter.modes.length === 1}
              onChange={(event) => toggle(mode.value, event.target.checked)}
            />
          );
        })}
      </div>
    </fieldset>
  );
}
