# Architecture Decision Records

このプロジェクトの設計判断を、判断した時点の記録として残す場所。

CLAUDE.md には**結論**だけを置く。毎セッション自動で読み込まれるので、結論が
そこに無いと同じ提案が蒸し返される。一方で**理由・却下した代替・その時点の測定値**は
必要になったときに読めればよく、しかも後から上書きされては困る。この 2 つを
分けるのが ADR の役目。

## 運用の 3 ルール

1. **一度書いたら本文は編集しない。** 判断が変わったら新しい ADR を書き、古い方は
   ステータス行を `廃止（ADR-XXXX により置換）` に変えるだけにする。本文を書き換えると
   「当時なにを知らなかったのか」が消える
2. **Issue → ADR → PR の順。** Issue で迷い、決まったら ADR を実装の PR に同梱する
3. **連番。** 衝突は個人開発では起きない

## 何を ADR にするか

| 基準 | ADR にする | CLAUDE.md / コードに置く |
|---|---|---|
| 取り消しコスト | 高い（データ移行・API 互換が要る） | いつでも戻せる |
| 代替の比較 | 実際に他案を検討して落とした | 比較していない、慣習の採用 |
| 再評価のサイン | 「こうなったら見直す」条件がある | 条件が無い |
| 守られ方 | 文書でしか守られない | テストや型で自動的に守られる |

最後の行が効く。たとえば「ルート定義は 1 本のチェーンで書く」は ADR にしていない。
`worker/test/rpc.test.ts` が型と値を固定していて、破ればテストが落ちるため。
同じ理由で「キーワードは UTF-8 48 バイトまで」も zod スキーマが守っている。

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
| [0018](0018-d1-http-api-for-sync.md) | 同期は D1 の HTTP API を叩く自作ドライバから書き込む | 承認済み |
| [0019](0019-verify-access-jwt-in-worker.md) | Access の JWT を Worker 自身でも検証する | 承認済み |

### 未決・進行中

| # | 決定 | ステータス |
|---|---|---|
| [0016](0016-cloudflare-access.md) | Cloudflare Access でアプリ全体を保護する | 提案（[#5](https://github.com/Ries630/ZaimViewer/issues/5)） |
| [0017](0017-adr-in-repo.md) | 設計判断を ADR として `docs/adr/` に残す | 承認済み |

## テンプレート

[`template.md`](template.md) をコピーして使う。
