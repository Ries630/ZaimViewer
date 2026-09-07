/**
 * 接続状態の購読。
 */

import { onlineManager } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

/** クエリと編集 Runner が共有する現在の接続状態を返す。 */
export function isOnline(): boolean {
  return onlineManager.isOnline();
}

/** 描画を待たずに通信中断を検知するため、共通の接続状態を購読する。 */
export function subscribeOnline(onChange: () => void): () => void {
  return onlineManager.subscribe(onChange);
}

/**
 * 端末がオンラインかどうかを購読する。
 *
 * 出所を TanStack Query の `onlineManager` に寄せているのが肝。`navigator.onLine` を
 * 直接見ると、クエリを止めるかどうかの判断（`networkMode: "online"` の既定）と
 * 画面の表示が別々の情報源を持つことになり、ずれる余地が生まれる。
 *
 * なお `networkMode` は既定の `"online"` のまま変えていない。`"always"` にすれば
 * オフラインでもクエリが発行されて失敗し、既存のエラー表示に落ちるが、
 * 接続が戻ったときに自動で取り直す挙動（実機で確認済み）が失われる。
 * 復帰に手動の再試行が要るようになるのは後退なので、止まっていることを
 * 画面に出す側で解いている（[#27](https://github.com/Ries630/ZaimViewer/issues/27)）。
 *
 * @returns オンラインなら true。
 */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    isOnline,
    // SSR はしないので呼ばれないが、useSyncExternalStore の契約として渡しておく
    () => true,
  );
}
