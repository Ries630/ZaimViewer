# ADR-0018: 同期は D1 の HTTP API を叩く自作ドライバから書き込む

- ステータス: 承認済み
- 日付: 2026-08-11
- 関連: [#3](https://github.com/Ries630/ZaimViewer/issues/3)、[ADR-0015](0015-sync-outside-worker.md)

## 背景

[ADR-0015](0015-sync-outside-worker.md) で同期を Worker の外へ出したため、
手元の Bun から本番 D1 へ書き込む経路が要る。D1 は Workers のバインディングが
本来の入口で、外から触るには Cloudflare API を使うことになる。

制約は 2 つある。

1. [ADR-0012](0012-table-swap-sync.md) の差し替えは `DROP` → `RENAME` →
   インデックス再作成の 13 文が単一トランザクションで走ることに依存している。
   経路を変えてもこの原子性を落とせない
2. 同期の本体（`worker/src/sync.ts`）は Worker と手元で同じものを使いたい。
   写しを作れば、片方だけ直したときに気付けない

`worker/src/db.ts` は [ADR-0011](0011-driver-agnostic-db-types.md) で
ドライバを名指ししない形にしてある。`sync.ts` が要求するのは
`Database`（`prepare(sql)` と `batch(statements)` だけ）である。

判断の前に、本番 D1 に対して 3 点を実測した。

| 確認したこと | 結果 |
|---|---|
| `POST /accounts/{id}/d1/database/{id}/query` の `{ batch: [...] }` 形式 | 受け付ける。結果は文と同じ順で返る |
| JSON の数値・null が SQLite にどう入るか | `typeof` は `integer` / `null`。バインド値は `real` で届くが列の親和性で整数になる |
| バッチ途中で失敗したときの巻き戻し | 2 文目の主キー衝突で 1 文目も残らない（`success: false` + `errors[]`） |

## 決定

`worker/src/d1-http.ts` に `Database` を実装する薄いドライバを置き、
D1 の HTTP API を `{ batch: [...] }` 形式で叩く。
`worker/scripts/sync.ts` はこれと `ZaimClient` を組み立てて `syncAll` を呼ぶだけにする。

## 検討した代替

- **`drizzle-orm/sqlite-proxy`** — Issue #3 の当初の見込み。これは Drizzle の
  クエリビルダに任意の HTTP エンドポイントを繋ぐ**読み取り側**のドライバで、
  返るのは `MirrorDatabase`。`sync.ts` が要求するのは素の SQL を投げる
  `Database` なので、結局その上にアダプタを重ねることになる。
  自作ドライバより層が 1 枚増えて、得るものが無い
- **`wrangler d1 execute --remote --file`** — SQL をファイルに書き出して流す。
  `sync.ts` の再利用が成立せず、SQL 文字列を組み立てる第 2 の実装ができる。
  加えて wrangler がファイルをどう分割して送るかに差し替えの原子性が依存し、
  こちらから保証できない
- **Worker に書き込み用エンドポイントを立てて手元から叩く** — 認証と入力検証を
  自前で持つことになり、Worker 側に「外から SQL を受ける口」が増える。
  D1 の HTTP API が既にその役目を果たしている

## 結果

- **Cloudflare の API トークンが手元に必要になった。** 権限は `Account > D1 > Edit`
  だけだが、Zaim の認証情報に加えてもう 1 つ秘密が増えた
- **Cloudflare API のグローバルなレート制限を受ける。** 同期 1 回は
  約 50 リクエスト（4,370 件を 100 文ずつ）で、制限に対しては十分に低い。
  実測 22 秒（fetch 16.1 秒 / write 4.6 秒 / swap 0.1 秒）
- **リトライは冪等ではない。** 429 と 5xx は指数バックオフで 3 回まで再送するが、
  「サーバ側で成功したのに応答が届かなかった」場合は再送が主キー衝突になる。
  同期全体は `*_new` の DROP から始まるので、そのときは最初からやり直せばよい
- **D1 のバインドは JSON の型に縛られる。** 数値は `real` として届き、
  列の親和性で整数に落ちる。2^53 を超える ID が現れたら壊れる
  （Zaim の ID は 10 桁なので当面問題にならない）
- Worker のバンドルには入らない `src/` のファイルが 1 つできた。
  `d1-http.ts` は `index.ts` から辿れないので配信物には含まれないが、
  `src/` を見て「Worker のコード」と読むと誤解の余地がある

## 再評価のサイン

- 同期の所要時間が伸びて Cloudflare API のレート制限に触れたとき。
  その場合は 1 バッチあたりの文数（`sync.ts` の `BATCH_SIZE`）を上げる
- Zaim の ID が 2^53 を超えたとき。バインド値を文字列で送る形に変える
