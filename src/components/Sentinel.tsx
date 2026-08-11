/**
 * 無限スクロールの検知。
 */

import { useCallback } from "react";

/**
 * 画面に入る前に読み始める余白。
 *
 * 0 にすると末尾に到達してから取得が始まり、スクロールが必ず一度止まる。
 */
const ROOT_MARGIN = "400px";

interface SentinelProps {
  /** 監視対象が視界に入ったときに呼ばれる。 */
  onVisible: () => void;
}

/**
 * 一覧の末尾に置いて、近づいたら知らせる目印。
 *
 * ref のコールバックから後始末の関数を返している（React 19 の書き方）。
 * `useEffect` と `useRef` を組み合わせるより、監視の開始と解除が
 * 1 箇所に収まる。
 *
 * @param props 視界に入ったときの処理。
 * @returns 高さ 1px の目印。
 */
export function Sentinel({ onVisible }: SentinelProps) {
  const observe = useCallback(
    (node: HTMLDivElement | null): (() => void) => {
      // 後始末を返す ref に React 19 が null を渡すことは無いが、型の上では起こりうる
      if (!node) return () => {};
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) onVisible();
        },
        { rootMargin: ROOT_MARGIN },
      );
      observer.observe(node);
      return () => observer.disconnect();
    },
    [onVisible],
  );

  return <div ref={observe} aria-hidden="true" className="h-px" />;
}
