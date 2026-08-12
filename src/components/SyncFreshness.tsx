/**
 * ミラーの鮮度表示。
 *
 * 既定は相対表記にする。同期は毎日 06:00 の 1 回なので分単位の精度は要らず、
 * むしろ「3 日前」のような表記が出ること自体が同期の停止を知らせる。
 * 絶対時刻はタップで popover に出す。
 *
 * 切り替え式（相対 ⇄ 絶対）ではなく popover なのは、絶対時刻を見たいのは
 * 相対表記に疑問を持った瞬間で、そのとき相対表記が消えると比べられなくなるため。
 * popover なら light dismiss が仕様で付いてくるので、閉じ忘れで表示が
 * 固まったままになる経路も無い。
 */

import { formatAbsoluteTime, formatRelativeTime, isStale } from "../lib/format";

/** popover と起動ボタンを結ぶ id。画面に 1 つしか出ないので固定でよい。 */
const POPOVER_ID = "synced-at-absolute";

interface SyncFreshnessProps {
  /** API が返す UTC の ISO 8601 文字列。未同期なら null。 */
  syncedAt: string | null;
  /** 現在時刻。相対表記の基準に使う。 */
  now: Date;
}

/**
 * ミラーの同期時刻を相対表記で出し、タップで絶対時刻を見せる。
 *
 * @param props 同期時刻と現在時刻。
 * @returns 鮮度表示。
 */
export function SyncFreshness({ syncedAt, now }: SyncFreshnessProps) {
  if (!syncedAt) {
    return <span className="text-sm text-base-content/60">未同期</span>;
  }

  const stale = isStale(syncedAt, now);
  const absolute = formatAbsoluteTime(syncedAt);

  return (
    <>
      <button
        type="button"
        popoverTarget={POPOVER_ID}
        // ホバーのある環境向け。iOS Safari はタップで title を出さないので、
        // これだけに頼ると絶対時刻に到達する手段が無くなる
        title={absolute}
        // 古いときだけ地色を敷く。warning と warning-content の組はどのテーマでも
        // 読める前提で用意されているので、対比を自前で調整しなくてよい
        className={`freshness-anchor shrink-0 rounded px-2 py-1 text-sm ${
          stale ? "bg-warning font-medium text-warning-content" : "text-base-content/60"
        }`}
      >
        <time dateTime={syncedAt}>{formatRelativeTime(syncedAt, now)}</time>
        {stale && <span className="ml-1">同期が古い</span>}
      </button>

      <div
        id={POPOVER_ID}
        popover="auto"
        className="freshness-popover rounded-lg bg-neutral px-3 py-2 text-sm text-neutral-content shadow-lg"
      >
        {absolute} 時点のミラー
      </div>
    </>
  );
}
