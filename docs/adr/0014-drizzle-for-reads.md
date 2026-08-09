# ADR-0014: 読み取りは Drizzle、同期は素の SQL

- ステータス: 承認済み
- 日付: 2026-08-07
- 関連: `70a945f`、`worker/src/schema.ts`、`worker/src/queries.ts`

## 背景

移植直後の読み取り側は、生 SQL を組み立てて `.all<Transaction>()` で結果を
受けていた。これは**無検証のキャスト**で、列名を間違えても実行時まで何も起きない。
`WhereBuilder` という自前のクラスで動的な WHERE を組んでもいた。

Python 期には `v_transactions` というマスタ JOIN 済みの VIEW を使っていたが、
これも「VIEW の定義と受け取る型が別々にずれる」という同じ問題を抱えていた。

## 決定

読み取り側を Drizzle のクエリビルダに置き換える。テーブル定義は
`worker/src/schema.ts` に置き、読み取りの型はそこから推論する。

同期側は素の SQL のままにする。

## 検討した代替

- **全面的に Drizzle** — 同期は `*_new` テーブルを作って差し替える都合で
  テーブル名が動的になり（[ADR-0012](0012-table-swap-sync.md)）、Drizzle の
  スキーマでは表現できない。DDL と一括 INSERT では ORM の利点も出ない
- **生 SQL のまま、型だけ zod で検証** — 実行時コストを払って、
  結局は列名の対応表を手で書くことになる
- **Kysely** — 型の付き方は同等。Drizzle を採ったのは D1 / libSQL / sqlite-proxy /
  bun-sqlite のドライバが揃っており、[ADR-0011](0011-driver-agnostic-db-types.md) の
  ドライバ非依存と噛み合うため

## 結果

- 列名の打ち間違いが型で落ちる。`WhereBuilder` は廃止した
  （`and()` が `undefined` を無視するので、条件を並べるだけで動的な WHERE になる）
- `LIKE ... ESCAPE` と `COALESCE(...)` は Drizzle のヘルパに無いため、
  `sql` テンプレートで書いている
- `v_transactions` VIEW は廃止し、Drizzle の JOIN に置き換えた
- **スキーマ定義が 2 か所になった。** テーブルの実体は `sync.ts` の DDL が作り、
  読み取りの型付けは `schema.ts` が担う。片方だけ変えると「型は通るのに実行時に
  列が無い」という壊れ方をする。これは `worker/test/schema.test.ts` が
  `PRAGMA table_info` と突き合わせて検出する。テストの固定データも `sync.ts` の
  `workTableDdl` / `swapSql` をそのまま使うので、スキーマの写しは増えていない

## 同値性の確認

全件 4,362 → 振替除外 3,873 → 未来分除外 3,833 → 1,000 円未満除外 1,875 と、
金額合計まで移行前と一致。LIKE のエスケープ（`q=%` で 9 件）と
`NOT IN` の NULL 保持も一致。
