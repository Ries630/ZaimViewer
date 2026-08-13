/**
 * ヘッダに常設する絞り込みの操作。
 */

import { MAX_QUERY_BYTES, queryByteLength } from "../../worker/src/limits";
import type { FilterBadge, FilterState } from "../lib/filter";

interface FilterBarProps {
  /** 現在の状態。 */
  filter: FilterState;
  /** 適用中の条件。 */
  badges: FilterBadge[];
  /** 状態を差し替える。 */
  onChange: (next: FilterState) => void;
  /** 絞り込みシートを開く。 */
  onOpenSheet: () => void;
}

/**
 * キーワード入力・シートを開くボタン・適用中のバッジ。
 *
 * バッジをヘッダに出しているのは、シートを開かなくても何が効いているかが
 * 分かるようにするため。既定で 3 つの条件が入っているので、
 * 「なぜこの件数なのか」がすぐ辿れないと混乱する。
 *
 * @param props 状態と更新関数。
 * @returns ヘッダの絞り込み操作。
 */
export function FilterBar({ filter, badges, onChange, onOpenSheet }: FilterBarProps) {
  const bytes = queryByteLength(filter.q.trim());
  const tooLong = bytes > MAX_QUERY_BYTES;

  return (
    <div className="flex flex-col gap-2 pt-2">
      <div className="flex items-center gap-2">
        <label className={`input input-sm grow ${tooLong ? "input-error" : ""}`}>
          <span className="opacity-60" aria-hidden="true">
            🔍
          </span>
          <input
            type="search"
            placeholder="品名・店舗・メモ"
            aria-label="キーワード"
            aria-invalid={tooLong}
            value={filter.q}
            onChange={(event) => onChange({ ...filter, q: event.target.value })}
          />
          {bytes > 0 && (
            <span className={`text-xs tabular-nums ${tooLong ? "text-error" : "opacity-60"}`}>
              {bytes}/{MAX_QUERY_BYTES}
            </span>
          )}
        </label>

        <button type="button" className="btn btn-sm" onClick={onOpenSheet}>
          絞り込み
          {badges.length > 0 && <span className="badge badge-sm">{badges.length}</span>}
        </button>
      </div>

      {tooLong && (
        <p className="text-xs text-error">
          キーワードは UTF-8 で {MAX_QUERY_BYTES} バイトまで（日本語なら 16 文字）。
          超えているあいだは絞り込みに使わない
        </p>
      )}

      {badges.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {badges.map((badge) => (
            <li key={badge.key}>
              <button
                type="button"
                className="badge badge-sm badge-ghost gap-1"
                aria-label={`${badge.label} を外す`}
                onClick={() => onChange(badge.next)}
              >
                {badge.label}
                <span aria-hidden="true">✕</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
