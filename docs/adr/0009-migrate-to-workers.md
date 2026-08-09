# ADR-0009: 実行基盤を TypeScript / Hono / Cloudflare Workers へ移す

- ステータス: 承認済み
- 日付: 2026-08-07
- 関連: `11ba2a6`（検証スパイク）、`0cc81d0`（移行）、[PR #1](https://github.com/Ries630/ZaimViewer/pull/1)

## 背景

工程 ① と工程 ② 前半を Python + FastAPI + ローカル SQLite で作り終えた時点で、
3 つの不満が残っていた。

1. **Mac mini がスリープしていると iPhone から見られない。**
   [ADR-0004](0004-sqlite-as-mirror.md) と [ADR-0005](0005-tailscale-for-access.md)
   の両方が「Mac mini が起きていること」に依存している
2. **定期実行に launchd を書く必要がある。** この時点で未設定のまま手動実行だった
3. **学習対象がずれている。** このプロジェクトで学びたいのは TypeScript / Hono /
   Cloudflare であって、Python ではない

3 番目が実は一番大きい。1 と 2 だけなら、Mac mini のスリープを止めれば済む。

移行の前に検証スパイク（`11ba2a6`）を置き、判断材料を実データで取った。

- OAuth1.0a の署名を Web Crypto だけで実装し、Zaim API に到達すること
- 署名が `oauthlib` と完全一致すること（4 ケース）
- 全件同期 4,362 件が D1 で成立すること。所要 17 秒、うち CPU 分は約 20ms
- `batch()` によるテーブル差し替えが失敗時にロールバックすること

## 決定

同期基盤・読み取り API・テストを TypeScript へ移植し、Cloudflare Workers 上の
Hono アプリにする。Python 実装は削除する。

## 検討した代替

- **Python のまま Mac mini で運用を続ける** — スリープ問題が残り、
  学習対象にも合わない
- **Python のまま別のホスティングに載せる**（Fly.io など）— スリープ問題は
  解決するが、学習対象の動機が満たされない。無料枠の条件も Workers より厳しい
- **Deno Deploy / Bun + どこか** — Cloudflare を選んだのは D1 の
  ネイティブバインディングと Cron Trigger が同じ場所にあるため

## 同値性の確認

移植で挙動が変わっていないことを実データで確認した。

- フィルタ結果が Python 実装と 19 ケースすべて一致（LIKE のワイルドカード、
  `NOT IN` の NULL 取りこぼし、複数値パラメータ、日本語検索を含む）
- 全件同期の件数が一致（明細 4,362 / categories 46 / genres 129 / accounts 36）
- 絞り込みの連鎖が金額合計まで一致（4,362 → 3,873 → 3,833 → 1,875）
- pytest 24 件相当を vitest 30 件へ移植

## 結果

- **[ADR-0004](0004-sqlite-as-mirror.md) と [ADR-0005](0005-tailscale-for-access.md) が
  両方とも成立しなくなった。** それぞれ [ADR-0010](0010-d1-as-mirror.md)、
  [ADR-0016](0016-cloudflare-access.md) で置き換える
- Grafana からミラーを読む経路が切れた。集計が要るなら Worker 側にエンドポイントを足す
- バリデーションエラーの応答が FastAPI の 422 から Hono 既定の 400 に変わった
- 実行環境の上限（CPU 時間、D1 のクエリ数）という新しい制約が加わった。
  これが [ADR-0015](0015-sync-outside-worker.md) を引き起こす
- 開発は `worker/` で bun を使う。uv / pytest は使わない
