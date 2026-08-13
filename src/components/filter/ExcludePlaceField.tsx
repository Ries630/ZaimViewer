/**
 * 除外する店舗名の指定。
 */

import { useState } from "react";

import type { FilterState } from "../../lib/filter";

interface ExcludePlaceFieldProps {
  /** 現在の状態。 */
  filter: FilterState;
  /** 状態を差し替える。 */
  onChange: (next: FilterState) => void;
}

/**
 * 除外する店舗名を並べる。
 *
 * `place` はマスタを持たない自由文字列なので、選択肢ではなく自由入力で受ける。
 * API 側は完全一致で除外するため、一覧に出ている表記をそのまま入れてもらう。
 *
 * @param props 状態と更新関数。
 * @returns 店舗除外の入力欄。
 */
export function ExcludePlaceField({ filter, onChange }: ExcludePlaceFieldProps) {
  const [draft, setDraft] = useState("");

  /** 入力中の店舗名を一覧に足す。 */
  const add = () => {
    const place = draft.trim();
    if (place === "" || filter.excludePlaces.includes(place)) {
      setDraft("");
      return;
    }
    onChange({ ...filter, excludePlaces: [...filter.excludePlaces, place] });
    setDraft("");
  };

  /**
   * 除外を 1 件外す。
   *
   * @param place 外す店舗名。
   */
  const remove = (place: string) => {
    onChange({
      ...filter,
      excludePlaces: filter.excludePlaces.filter((value) => value !== place),
    });
  };

  return (
    <fieldset className="fieldset">
      <legend className="fieldset-legend">店舗を除外</legend>

      <div className="join">
        <input
          type="text"
          className="input join-item grow"
          placeholder="店舗名（完全一致）"
          aria-label="除外する店舗名"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              // シートが form の中にあっても送信させない
              event.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn join-item btn-sm" onClick={add}>
          追加
        </button>
      </div>

      {filter.excludePlaces.length > 0 && (
        <ul className="flex flex-wrap gap-1 pt-1">
          {filter.excludePlaces.map((place) => (
            <li key={place}>
              <button
                type="button"
                className="badge badge-sm badge-ghost gap-1"
                aria-label={`${place} の除外を外す`}
                onClick={() => remove(place)}
              >
                {place}
                <span aria-hidden="true">✕</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
