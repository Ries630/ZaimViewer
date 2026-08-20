# ADR-0034: 入力検証を valibot に一本化する

- ステータス: 承認済み
- 日付: 2026-08-20
- 関連: [#50](https://github.com/Ries630/ZaimViewer/issues/50)、[ADR-0033](0033-zod-mini-for-client-parsing.md)（この ADR が置き換える）、[ADR-0026](0026-filter-defaults-and-persistence.md)

## 背景

[ADR-0033](0033-zod-mini-for-client-parsing.md) でクライアント側の検証に `zod/mini` を入れた結果、
Worker は `zod` 本体、クライアントは `zod/mini` という**2 つの流儀が同じリポジトリに並ぶ**
状態になった。ADR-0033 自身が代償として挙げたとおりで、放置する理由が無い。

一本化にあたり、`zod` 本体 / `zod/mini` / valibot の 3 通りで Worker とクライアントの
両方を実装して測った。valibot 版は 208 件のテスト（安全な整数の門を 1 件足した）と 3 プログラムの型検査が
すべて通っている。valibot の行は移植後の実測値で、他の 3 行は比較用に書いた実装の値。

**Worker（`dist/zaimviewer/index.js`）**

| 実装 | raw | gzip |
|---|---|---|
| zod 本体 | 384.90 kB | 88.05 kB |
| zod/mini | 294.87 kB | 70.91 kB |
| valibot | 275.98 kB | 66.77 kB |

**クライアント（`dist/client/assets/index-*.js`）**

| 実装 | raw | gzip | precache |
|---|---|---|---|
| 手書きの `typeof` ガード | 313.53 kB | 100.19 kB | 376.24 KiB |
| valibot | 319.59 kB | 101.91 kB | 382.15 KiB |
| zod/mini | 331.03 kB | 105.48 kB | 393.33 KiB |
| zod 本体 | 378.06 kB | 117.51 kB | 439.25 KiB |

**ADR-0033 が測ったのはクライアント側だけで、Worker 側の取り分を見落としていた。**
zod 本体を Worker から外すと gzip で 17〜22 kB 減る。こちらの方が大きい。

移行の途中で、zod の直感が通じない箇所が 3 つ見つかった。いずれもテストが検出した。

- **`v.fallback` は pipe を短絡する。** zod の `catch` は pipe の途中に置いても後段の
  `transform` が動くが、valibot は fallback が効いた時点で打ち切る。項目ごとの既定値は
  フィールド全体を包む形にしないと、[ADR-0026](0026-filter-defaults-and-persistence.md) の
  「読めない項目だけ既定に倒す」が壊れる（最初の実装でテストが 2 件落ちた）
- **`v.integer()` は安全な整数を見ない。** `Number.isInteger` そのままなので
  `9007199254740993`（丸めると整数になる）も `1e30` も通る。zod の `.int()` は
  安全な整数の範囲で弾いていたので、`v.safeInteger()` に替えないと桁あふれした値が
  SQL に渡る。上限を持たない `offset` はこれが唯一の門になる
- **クエリの既定値は変換前の型で渡す。** `z.coerce.number().default(50)` に当たる形が
  `v.optional(v.pipe(v.string(), v.transform(Number), …), "50")` と文字列になる

## 決定

入力検証を valibot に一本化し、`zod` と `@hono/zod-validator` を依存から外す。
Worker は `@hono/valibot-validator` の `vValidator`、クライアントは `v.safeParse` を使う。

## 検討した代替

**`zod/mini` に一本化する。** `@hono/zod-validator` の型は `zod/v4/core` の `$ZodType`
基準なので、**mini のスキーマをそのまま受ける**（実際に移して 207 件のテストと型検査が
通ることを確認した）。依存を 1 つも変えずに流儀を揃えられる、いちばん安全な案。
落としたのは gzip 合計で valibot に 8.05 kB 劣ることと、valibot を使ってみたいという
動機があったため。**工学的な差は小さく、ここは好みで決めている。**

**`zod` 本体に一本化する。** クライアントに本体を載せると gzip +17.32 kB。ADR-0033 で
すでに落としている。

**2 流儀のまま放置する。** 書き分けを覚え続ける必要があり、どちらで書くか迷う。
サイズの取り分も逃す。

## 結果

**zod の生態系から外れる。** Hono のドキュメントもサンプルも zod が主で、
`@hono/valibot-validator` は 0.6.1（pre-1.0）。`drizzle-zod` のような zod 前提のツールを
使う道も閉じる。

**zod の直感が通じない箇所が 3 つ残る。** 上に挙げた fallback の短絡・`v.integer()` の
緩さ・既定値の型で、いずれもテストで固定したが、次にスキーマを書くときも同じ罠がある。

**400 のレスポンス本文の形が変わる。** valibot の issues 配列になる。今のクライアントは
`status` しか見ていない（`src/api/client.ts` の `unwrap`）ので実害が出ていないだけで、
エラー本文を読む機能を足すときには影響する。

**RPC の型は valibot の `InferInput` / `InferOutput` 経由になる。** `hc<AppType>` は
そのまま動いているが、型が壊れたときの読み解き方は zod のときと変わる。

## 再評価のサイン

- `@hono/valibot-validator` の更新が止まる、または Hono の破壊的変更に追随しなくなった
  → Standard Schema 経由の `@hono/standard-validator` に逃げる（valibot は Standard Schema を
  実装している）
- 工程 ③ で Zaim のレスポンスを本格的にパースし始め、zod 前提のツールが要るようになった
  → そのときに zod へ戻す費用（今回の逆方向、2 ファイル）を測り直す
- valibot 特有の罠が 3 つより増えた → 一本化の相手を選び直す
