/**
 * フィルタ状態と localStorage の橋渡し。
 */

import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

import type { FilterState } from "../lib/filter";
import { FILTER_STORAGE_KEY, parseStoredFilter } from "../lib/filter-storage";

/**
 * localStorage から読む。
 *
 * Safari のプライベートモードなど、参照そのものが例外になる環境がある。
 * 絞り込みが復元できないだけなので、握って既定に倒す。
 *
 * @returns 保存されていた文字列。読めなければ null。
 */
function read(): string | null {
  try {
    return localStorage.getItem(FILTER_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * localStorage に書く。
 *
 * @param filter 保存する状態。
 */
function write(filter: FilterState): void {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filter));
  } catch {
    // 書けなくても操作は続けられる（次の起動で既定に戻るだけ）
  }
}

/**
 * フィルタ状態を保持し、変更のたびに localStorage へ書く。
 *
 * @returns 現在の状態と、更新する関数。
 */
export function useStoredFilter(): [FilterState, Dispatch<SetStateAction<FilterState>>] {
  // 初期化関数にしているので、読み出しは初回の描画だけで走る
  const [filter, setFilter] = useState<FilterState>(() => parseStoredFilter(read()));

  useEffect(() => {
    write(filter);
  }, [filter]);

  return [filter, setFilter];
}
