# Architecture Decision Records

コードから理由を読み取れない長期的な設計判断を、判断した時点の記録として残す。

## 運用

ADR の作成基準・書式・作成・更新・置換・廃止の手順は `adr` skill を正とする。
このファイルには、このリポジトリの ADR 一覧と動かない結論だけを置く。

## 一覧

### Python + ローカル SQLite 期（工程 ①）

これらは Cloudflare へ移る前の判断。リポジトリ化より前に決まっていたものが多く、
`be3b40a` 時点の CLAUDE.md と `e8bcd61` のコミット本文から復元した。

| # | 決定 | ステータス |
|---|---|---|
| [0001](0001-build-viewer-instead-of-generic-tools.md) | 汎用ツールを使わず閲覧層を自作する | 承認済み |
| [0002](0002-no-local-only-data.md) | ローカル独自データを持たず、除外はクエリのルールで表現する | 承認済み |
| [0003](0003-edit-through-zaim-api.md) | 編集は必ず Zaim 更新 API を経由する | 承認済み |
| [0004](0004-sqlite-as-mirror.md) | ミラー DB に SQLite を使う | 廃止（[0010](0010-d1-as-mirror.md)） |
| [0005](0005-tailscale-for-access.md) | iPhone からの到達は Tailscale で、認証は自作しない | 廃止（[0016](0016-cloudflare-access.md)） |
| [0006](0006-oauth1-in-house.md) | Zaim API は OAuth1.0a で直叩きし、MCP サーバに依存しない | 承認済み |
| [0007](0007-atomic-swap-sync.md) | 同期は全件構築してからアトミックに差し替える | 廃止（[0012](0012-table-swap-sync.md)） |
| [0008](0008-no-default-filters-in-api.md) | API にフィルタの既定値を持たせない | 承認済み |

### TypeScript + Cloudflare Workers 期（工程 ②）

| # | 決定 | ステータス |
|---|---|---|
| [0009](0009-migrate-to-workers.md) | 実行基盤を TypeScript / Hono / Cloudflare Workers へ移す | 承認済み |
| [0010](0010-d1-as-mirror.md) | ミラー DB に Cloudflare D1 を使う（Turso 不採用） | 承認済み |
| [0011](0011-driver-agnostic-db-types.md) | DB アクセスの型を `db.ts` に集め、ドライバを名指ししない | 承認済み |
| [0012](0012-table-swap-sync.md) | 同期は `*_new` テーブルへ構築し `batch()` で差し替える | 承認済み |
| [0013](0013-voidzero-toolchain.md) | ツールチェーンを TypeScript 7 + oxlint + oxfmt にする（Vite+ 不採用） | 承認済み |
| [0014](0014-drizzle-for-reads.md) | 読み取りは Drizzle、同期は素の SQL | 承認済み |
| [0015](0015-sync-outside-worker.md) | 同期は Worker の外（手元の Mac mini）で実行する | 承認済み |
| [0016](0016-cloudflare-access.md) | Cloudflare Access でアプリ全体を保護する | 承認済み |
| [0018](0018-d1-http-api-for-sync.md) | 同期は D1 の HTTP API を叩く自作ドライバから書き込む | 承認済み |
| [0019](0019-verify-access-jwt-in-worker.md) | Access の JWT を Worker 自身でも検証する | 承認済み |
| [0020](0020-single-package-vite-worker.md) | PWA と Worker を 1 パッケージに同居させ、ルートをアプリのルートにする | 承認済み |
| [0021](0021-no-list-virtualization.md) | 明細一覧を仮想化せず、取得済みの全件を素の DOM で描く | 承認済み |
| [0022](0022-daisyui-for-form-components.md) | DaisyUI を採用し、色は semantic トークンで書く | 承認済み |
| [0023](0023-darken-success-for-income-amount.md) | 収入の金額のため、`light` テーマの success だけ値を上書きする | 承認済み |
| [0024](0024-dark-mode-follows-device.md) | ダークモードは端末の設定に従い、色の上書きは `light` 側だけに閉じる | 承認済み |
| [0025](0025-temporal-for-date-arithmetic.md) | 日付演算に Temporal を使い、表示の整形は `Intl` のまま残す | 承認済み |
| [0026](0026-filter-defaults-and-persistence.md) | フィルタの既定値と保存先を PWA が持ち、localStorage に永続化する | 承認済み |
| [0027](0027-master-options-follow-zaim-order.md) | フィルタの選択肢は Zaim の並びに従わせ、削除済みは参照されているものだけ残す | 承認済み |
| [0028](0028-service-worker-precache-only.md) | Service Worker は静的アセットの precache だけに使い、ナビゲーションと `/api/*` には触らせない | 承認済み |
| [0029](0029-detail-bottom-sheet-as-edit-entry.md) | 明細の詳細をボトムシートで見せ、そこを工程 ③ の編集の入口にする | 承認済み |
| [0030](0030-receipt-id-gates-name-editing.md) | 品名を編集できるのは `receipt_id` を持つ明細だけとし、持たない既存分には後付けする | 承認済み |
| [0031](0031-agents-md-as-instruction-source.md) | 指示ファイルを `AGENTS.md` に移し、`CLAUDE.md` はインポートだけにする | 承認済み |
| [0032](0032-anti-slop-lint-rules.md) | anti-slop の Oxlint プラグインをベンダリングし、ルールを段階的に有効にする | 承認済み |
| [0033](0033-zod-mini-for-client-parsing.md) | クライアント側の入力検証に `zod/mini` を使う | 廃止（[0034](0034-valibot-for-validation.md) により置換） |
| [0034](0034-valibot-for-validation.md) | 入力検証を valibot に一本化する | 承認済み |

### 未決・進行中

| # | 決定 | ステータス |
|---|---|---|
| [0017](0017-adr-in-repo.md) | 設計判断を ADR として `docs/adr/` に残す | 承認済み |

## テンプレート

[`template.md`](template.md) をコピーして使う。
