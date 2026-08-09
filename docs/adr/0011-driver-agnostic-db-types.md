# ADR-0011: DB アクセスの型を `db.ts` に集め、ドライバを名指ししない

- ステータス: 承認済み
- 日付: 2026-08-07
- 関連: `0cc81d0`、`07d53f1`、`worker/src/db.ts`

## 背景

[ADR-0009](0009-migrate-to-workers.md) の移植を始めた時点で、デプロイ先と課金が
未決だった。具体的には次のどれになるか分からなかった。

- Workers + D1（ネイティブバインディング）
- 手元の Bun + SQLite ファイル
- 手元から HTTP 越しに D1 を叩く

さらに Turso への乗り換えの可能性も残っていた（[ADR-0010](0010-d1-as-mirror.md)）。
`D1Database` 型をコード中に散らすと、この決定が全ファイルに染み出す。

## 決定

DB アクセスの型を `worker/src/db.ts` に集約し、どちらもドライバ固有の型を
名指ししない。用途別に 2 つ置く。

- **`MirrorDatabase`** — 読み取り用。Drizzle の `BaseSQLiteDatabase<"async", unknown>`。
  `drizzle-orm/d1` / `libsql` / `sqlite-proxy` / `bun-sqlite` のどれで作った
  インスタンスでも渡せる
- **`Database`** — 書き込み用。`prepare` / `batch` だけを持つ最小のインターフェース。
  同期が素の SQL を投げる形（[ADR-0014](0014-drizzle-for-reads.md)）に対応する

## 検討した代替

- **`D1Database` を直接使う** — 素直だが、乗り換えのたびに全ファイルを触る
- **リポジトリパターンでラップする** — インターフェースをもう 1 枚挟むぶん、
  クエリの組み立て（`worker/src/queries.ts`）とテストが遠くなる。
  ドライバを差し替えたいだけなので、型だけ抽象化すれば足りる

## 結果

- 配置先の変更をこの 1 ファイルの差し替えで吸収できる。
  [#3](https://github.com/Ries630/ZaimViewer/issues/3) の同期スクリプト
  （手元から HTTP 越しに D1 へ書く）も、`drizzle-orm/sqlite-proxy` を
  この型に嵌める形で載る見込み
- **`D1Database` は `Database` を構造的に満たす。** そのため Workers 上では
  アダプタを 1 つも書かず、そのまま渡している。当初は `as Database` の
  アサーションを各所に置いていたが、型認識 lint（`07d53f1`）がこれを
  不要と検出し、アサーションを全廃した
- 型が抽象なぶん、ドライバ固有の便利な API（D1 のメタ情報など）は使えない
