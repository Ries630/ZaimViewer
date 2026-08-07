# ZaimViewer

Zaim のフィルタ機能が弱く、自動連携の細かな履歴や振替に重要な入出金が埋もれる。
その問題を「閲覧層の自作」で解決するプロジェクト。iPhone からの利用が主。

## 構成

```
Zaim API ──同期(手元の Mac mini で実行)──▶ D1
                                          ▲
                                          │ read
                        Cloudflare Workers │
                        ┌─────────────────┴──────────────┐
                        │ Hono: 読み取り API + 編集プロキシ │──▶ PWA (React+Vite)
                        └─────────────────┬──────────────┘
                                          │ OAuth1.0a 署名
                                          ▼
                                    Zaim 更新 API
```

読み取り API・編集プロキシ・PWA 配信は 1 つの Worker（`worker/`）に同居する。
iPhone からの入口はひとつで、CORS も不要。同期だけが Worker の外なのは
CPU 時間とクエリ数の上限のため（「デプロイの前提」参照）。

## 現在地（2026-08-07）

**工程 ① 同期基盤: 完了。** Zaim 全件 4,362 件（payment 3,266 / income 607 /
transfer 489、2014-02〜2029-12。未来分は繰り返し登録の家賃）をミラー済み。
マスタは categories 46 / genres 129 / accounts 36。

**工程 ② 読み取り API: 完了。** `GET /api/transactions`（フィルタ + ページング）、
`/api/masters`（フィルタ UI の選択肢）、`/api/meta`（同期の鮮度）、
`POST /api/sync`（手動同期）。実データでの確認済み: 全 4,362 件 → 振替除外 3,873
→ 未来分を隠して 3,833 → 1,000 円未満のノイズ除外で 1,875 件。

なお `POST /api/sync` は**ローカル開発でしか使えない**。CPU 時間とクエリ数の
上限（下記）に引っかかるため、本番の同期は手元から実行する別経路になる。

**工程 ② PWA: 次はここから。** React + Vite + TypeScript + Tailwind CSS v4。
明細一覧（無限スクロール）とフィルタパネル。モバイルファースト。
ビルド成果物は Workers の Static Assets として同じ Worker から配信する。

**工程 ③ 編集機能: 未着手。** 単体編集 → フィルタ結果への一括編集。
いずれも Zaim 更新 API へ順次反映する。署名側は POST + フォームボディまで
検証済みなので、`ZaimClient` に更新系メソッドを足すところから始められる。

## 技術選定

| 領域 | 採用 | 主な理由 |
|---|---|---|
| 実行環境 | Cloudflare Workers | Mac mini 非依存。Cron Trigger で定期実行 |
| DB | D1 | Workers のネイティブバインディング。認証トークンも外部通信も不要 |
| フレームワーク | Hono | RPC で PWA と型を共有できる |
| クエリ | Drizzle（読み取りのみ） | 列名を型で拾う。ドライバ非依存 |
| 入力検証 | zod + `@hono/zod-validator` | pydantic 相当 |
| 型検査 | TypeScript 7（Go 実装） | 同じコードで 0.60 秒 → 0.07 秒 |
| lint / format | oxlint + oxfmt | `oxlint-tsgolint` で型認識ルールが効く |
| テスト | vitest + `@cloudflare/vitest-pool-workers` | workerd 上で実物の D1 を使う |
| パッケージ管理 | bun | peer dependency の解決が緩いので、更新時は要注意 |
| PWA（予定） | React + Vite + `@cloudflare/vite-plugin` | Worker と単一の dev サーバで動き、同一オリジンで API を叩ける |

**不採用にしたもの。**

- **Vite+** — Vitest / Rolldown / Oxlint / Oxfmt を束ねた統合層（2026-07 に beta、MIT）。
  中身の oxlint と oxfmt は個別に採用済み。統合層を入れないのは、テストが
  `@cloudflare/vitest-pool-workers` という独自 pool に依存していて、`vp test` が
  これを通すか未知なため。1.0 になり PWA を作る段になったら `vp migrate` を試す価値はある
- **Turso（libSQL）** — 無料枠は D1 より大きく（5GB / 5 億行月）、D1 固有の制限
  （LIKE パターン 50 バイト、invocation あたりクエリ数）も無い。それでも D1 を採るのは、
  実測でどの制限にも余裕があり（DB 3.3MB）、ネイティブバインディングの単純さが勝つため。
  乗り換えるサインは「LIKE の 48 バイトが実際に邪魔になる」「同期を Worker 内で完結させたくなる」。
  Drizzle を通しているので `drizzle-orm/d1` → `drizzle-orm/libsql` の差し替えで済む
- **汎用ツール（Directus / NocoDB / Metabase）** — 編集プロキシとしてバックエンドが
  必須になった時点で、主価値だった「API 自動生成」が仕事を失った

## デプロイの前提（未実施）

**同期は手元（Mac mini）から実行し、読み取りだけ Workers に置く。** Workers の
CPU 時間上限は無料プランだと Cron Trigger でも 10ms で、全件同期の実測（約 20ms、
ローカル実行値）が収まらない。さらに D1 には「invocation あたりのクエリ数」制限が
あり（無料 50 / 有料 1,000）、約 4,600 文を投げる同期は**有料プランでも 1 回では収まらない**。

読み取り API は 1 リクエストあたり 2〜3 クエリなので無料枠で足りる。
同期だけを外に出せば月額 0 円で、Mac mini がスリープ中でも iPhone から閲覧できる
（ミラーが古くなるだけ）。

**アトミック差し替えはこの構成でも維持できる。** `*_new` への一括投入は多数の
リクエストに分かれてよく（誰も読んでいないテーブルなので）、原子性が要るのは
差し替えの 13 文だけ。これは 1 バッチに収まる。

**未検証: Cloudflare Access の挙動。** ホーム画面から起動した PWA でセッションが
切れたときの再認証は、実際にデプロイしないと分からない。セッション期間は最長 1 か月。

## 設計上の決定と理由

**ローカル独自データを一切持たない。** 重要フラグやメモのようなカラムは作らない。
除外したい明細（振替・自動連携ノイズ）は行ごとのフラグではなくクエリのルールで表現する。
ルールは今後増える明細にも自動で効くが、フラグは新しい明細のたび付け続ける必要があり、
「入力時に選別する」旧運用に逆戻りしてしまうため。

結果としてこの DB は**使い捨てのミラー**になる。壊れたら再同期すればよく、
バックアップも移行も不要。Zaim が唯一の正。

**編集は必ず Zaim 更新 API を経由する。** ミラーを直接書き換えても Zaim に届かず、
次の同期で黙って消える。OAuth1.0a の署名鍵はブラウザに置けないため、
Worker 側に編集プロキシを立て、PWA はそこを叩く。

**TypeScript + Hono + Workers を選んだ理由。** 当初は Python + FastAPI + ローカル
SQLite で組んでいたが、(1) 学習対象が TS / Hono / Cloudflare であること、
(2) Mac mini がスリープしていると iPhone から見られない問題が消えること、
(3) 定期実行が Cron Trigger で済み launchd を書かずに済むこと、の 3 点で乗り換えた。
移植時、フィルタの結果が Python 実装と 19 ケースすべてで一致することを確認している。

**OAuth1.0a の署名は自前実装。** `oauth-1.0a` は同期 API 前提で、非同期の
`crypto.subtle` と噛み合わない。Web Crypto だけで書けば依存が増えず、
`nodejs_compat` フラグも要らない（`worker/src/oauth1.ts`）。
署名は `oauthlib` と一致することを確認済み（記号 `!*'()`・日本語・POST ボディを含む）。

**同期はテーブル差し替え方式。** D1 にはファイル差し替えに相当する操作がないため、
`*_new` テーブルに全件構築し、`DROP` → `RENAME` → インデックス再作成を単一の
`batch()` で実行する。`batch()` は 1 トランザクションなので、途中で失敗すれば
旧テーブルがそのまま残る（故意に失敗させて検証済み）。認証確認と 0 件チェックを
差し替えより前に置き、API 異常時に空のミラーで上書きしないようにしている。

**DB アクセスの型は `worker/src/db.ts` に集める。** 読み取り用（`MirrorDatabase`、
Drizzle のドライバ非依存な型）と書き込み用（`Database`、素の SQL を投げる形）の
2 つを置き、どちらもドライバを名指ししない。同期を手元から D1 の HTTP API 越しに
実行する構成（上記）や、Turso への乗り換えを、この 1 ファイルの差し替えで
吸収するため。`D1Database` は `Database` を構造的に満たすので、Workers 上では
実装を挟まずそのまま渡している。

**ルート定義は 1 本のチェーンで書く。** `app.get(...)` を文として並べると
RPC の型が `typeof app` に積み上がらず、PWA の `hc<AppType>` からエンドポイントが
一切見えなくなる。壊れても実行時には何も起きないため、`test/rpc.test.ts` で
型と値の両方を固定してある。なお RPC のレスポンス型は「成功」と
「バリデーションエラー」の union になるので、呼び出し側は `res.status` で
絞ってからでないと本体に触れない。

**キーワード検索は UTF-8 で 48 バイトまで。** D1 は LIKE / GLOB のパターン長を
50 バイトに制限している（標準の SQLite ビルドは 50,000 なのでローカルでは踏めない）。
前後に `%` が付くぶんを引いて 48 バイト。日本語だけなら 16 文字が上限になる。

**API にフィルタの既定値を持たせない。** 「振替を除外」「今日以前だけ」といった
既定は PWA 側が持ち、API は指定なし = 制限なしに徹する。API 側に暗黙の既定を
埋めると「全件見たい」ときの外し方が分からなくなり、別の読み手から
叩いたときに驚くため。

**読み取りは Drizzle、同期は素の SQL。** 読み取り側は列名の打ち間違いを
型で拾いたいので Drizzle を通す（以前は `.all<Transaction>()` という無検証の
キャストだった）。同期側は `*_new` テーブルを作って差し替える都合でテーブル名が
動的になり、DDL と一括 INSERT では ORM の利点も出ないため素のままにしてある。
`LIKE ... ESCAPE` と `COALESCE(...)` は Drizzle のヘルパに無いので `sql` で書く。

**スキーマ定義は 2 か所にあり、テストで守る。** テーブルの実体は `sync.ts` の
DDL が作り、読み取りの型付けは `schema.ts` が担う。片方だけ変更すると
「型は通るのに実行時に列が無い」という壊れ方をするため、`test/schema.test.ts` が
`PRAGMA table_info` と突き合わせて検出する。テストの固定データも `sync.ts` の
DDL と差し替え処理をそのまま使うので、スキーマの写しは増えない。

**フィルタの SQL 組み立ては `worker/src/queries.ts` に閉じる。** 「除外はクエリの
ルールで表現する」の実装箇所。よく使う除外条件に名前を付けるプリセット層を将来
載せる場合も、その層は `TransactionFilter` を組み立てるだけでよく SQL を書かずに済む。
プリセットを今作らないのは、どのノイズを消したいかが実データを触りながら
決まる段階で、固まっていないルールを設定ファイルに固定したくないため。

## 開発

```bash
cd worker
bun install
bun run dev         # ローカル D1 で :8787 に起動
bun run check       # format:check → lint → typecheck → test を一括
bun run test        # workerd 上で実行（D1 も実物を使う）
bun run lint        # oxlint（型認識ルール込み）
bun run format      # oxfmt
bun run cf-typegen  # wrangler.jsonc 変更後に型を再生成
```

ツールチェーンは TypeScript 7（Go 実装）+ oxlint + oxfmt。
lint は `--type-aware` で動かしており、型情報を要するルール（`no-floating-promises`
など）も効く。これは `oxlint-tsgolint` が入っていることが前提。

同期はローカルでは `curl -X POST http://127.0.0.1:8787/api/sync`（約 17 秒、44 リクエスト）。

CI は GitHub Actions（`.github/workflows/ci.yml`）で、PR と main への push に
`bun run check` を実行する。Zaim の認証情報も Cloudflare へのログインも要らない。

`worker/.dev.vars` に Zaim の OAuth1.0a 認証情報が必要（`worker/.dev.vars.example` 参照）。
値は `~/.claude.json` の `mcpServers.zaim-api` に設定済みのものと同一。
本番へは `wrangler secret put` で入れる。

## 残っている作業

デプロイに必要な設定は、まだどれも入っていない。`worker/wrangler.jsonc` の
`database_id` は検証時のプレースホルダのまま。

1. Cloudflare 上に D1 を作り、`database_id` を差し替える
2. `wrangler secret put` で Zaim の認証情報を登録する
3. 同期スクリプト（手元で実行し、D1 の HTTP API 越しに書く）
4. PWA（React + Vite + `@cloudflare/vite-plugin`）と、`wrangler.jsonc` の
   Static Assets 設定
5. Cloudflare Access の設定と、PWA でのセッション挙動の確認
6. 工程 ③ の編集プロキシ（`ZaimClient` に更新系メソッドを足すところから）

## 運用メモ

- Grafana（Mac mini の :3080）からミラーを読む構想があったが、D1 へ移したため
  そのままでは繋がらない。集計・推移が必要になったら、Worker 側に集計エンドポイントを
  足すか、Grafana の JSON データソースを使う
- Git はユーザー確認なしにコミットしてよい（このリポジトリのコードはユーザーが直接触らないため）。
  ただし GitHub への push やリポジトリ公開は外部への公開にあたるため確認する
- コミットは Conventional Commits、本文は日本語
- 旧 Python 実装（`src/zaimviewer/`、`tests/`）は削除済み。手元の `.venv` と
  `data/zaim.db` は追跡外なので、不要になれば消してよい
