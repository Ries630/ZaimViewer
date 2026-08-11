import { useQuery } from "@tanstack/react-query";

import { client, unwrap } from "./api/client";

/**
 * ミラーの鮮度を表示する。
 *
 * 足場（#13）の完了確認を兼ねる。明細一覧は #14、フィルタは #15。
 */
export function App() {
  const meta = useQuery({
    queryKey: ["meta"],
    queryFn: () => unwrap(client.api.meta.$get()),
  });

  return (
    <main className="mx-auto max-w-2xl px-4 pt-safe-top pb-safe-bottom">
      <h1 className="py-6 text-2xl font-bold">ZaimViewer</h1>

      {meta.isPending && <p className="text-gray-500">読み込み中…</p>}

      {meta.isError && <p className="text-red-600">読み込めなかった: {meta.error.message}</p>}

      {meta.isSuccess && (
        <dl className="space-y-2">
          <div className="flex justify-between border-b border-gray-200 py-2">
            <dt className="text-gray-500">同期時刻</dt>
            <dd className="tabular-nums">{meta.data.synced_at ?? "未同期"}</dd>
          </div>
          {Object.entries(meta.data.counts).map(([name, count]) => (
            <div key={name} className="flex justify-between border-b border-gray-200 py-2">
              <dt className="text-gray-500">{name}</dt>
              <dd className="tabular-nums">{count.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      )}
    </main>
  );
}
