/**
 * 値の反映を遅らせる。
 */

import { useEffect, useState } from "react";

/**
 * 値が落ち着くまで反映を遅らせる。
 *
 * フィルタ全体に掛けている。キーワードを 1 文字打つたび、金額を 1 桁入れるたびに
 * リクエストが飛ぶのを防ぐため。チェックボックスの操作まで遅れることになるが、
 * 一覧は `keepPreviousData` で前の結果を出したままなので画面は跳ねない。
 *
 * @param value 追いかける値。
 * @param delayMs 落ち着いたと見なすまでの時間。
 * @returns 遅れて追従する値。
 */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
