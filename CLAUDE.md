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

## 現在地（2026-08-11）

**工程 ① 同期基盤: 完了。** Zaim 全件 4,370 件（payment 3,272 / income 607 /
transfer 491、2014-02〜2029-12。未来分は繰り返し登録の家賃）を本番 D1 にミラー済み。
マスタは categories 46 / genres 129 / accounts 36。件数は同期のたびに増える。

**工程 ② 読み取り API: 完了。** `GET /api/transactions`（フィルタ + ページング）、
`/api/masters`（フィルタ UI の選択肢）、`/api/meta`（同期の鮮度）、
`POST /api/sync`（手動同期）。実データでの確認済み: 全 4,370 件 → 振替除外 3,879
→ 未来分を隠して 3,839 → 1,000 円未満のノイズ除外で 1,881 件。

なお `POST /api/sync` は**ローカル開発専用**で、本番では 404 を返す。CPU 時間と
クエリ数の上限（下記）に引っかかるため、本番の同期は手元から実行する。

**初回デプロイ: 完了。** https://zaimviewer.ries.workers.dev で読み取り API 3 本が
応答する。D1 は `zaim-viewer`（APAC）。Cloudflare Access で保護済み。

**同期スクリプト: 完了。** `worker/scripts/sync.ts` を手元から実行して本番 D1 を
更新する。書き込みは D1 の HTTP API 経由（[ADR-0018](docs/adr/0018-d1-http-api-for-sync.md)）で、
同期処理そのものは Worker と同じ `src/sync.ts`。実測 22 秒で全件差し替わる。
定期実行は launchd（毎日 06:00）。手順は [`ops/README.md`](ops/README.md)。

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

**不採用にしたもの。** 理由と再評価のサインは各 ADR にある。

- **Turso（libSQL）** — 制限だけ見れば D1 より上だが、実測でどれにも余裕がある
  → [ADR-0010](docs/adr/0010-d1-as-mirror.md)
- **Vite+** — 中身の oxlint / oxfmt は個別に採用済み
  → [ADR-0013](docs/adr/0013-voidzero-toolchain.md)
- **汎用ツール（Directus / NocoDB / Metabase）** — 編集プロキシが必須になり主価値が消えた
  → [ADR-0001](docs/adr/0001-build-viewer-instead-of-generic-tools.md)

## デプロイの前提

**同期は手元（Mac mini）から実行し、読み取りだけ Workers に置く。** Workers の
CPU 時間（10ms に対し実測 20ms）と D1 の invocation あたりクエリ数（有料 1,000 に対し
約 4,600 文）の両方に収まらないため。有料プランでも解決しない
→ [ADR-0015](docs/adr/0015-sync-outside-worker.md)

読み取り API は 1 リクエストあたり 2〜3 クエリなので無料枠で足りる。月額 0 円で、
Mac mini がスリープ中でも閲覧できる（ミラーが古くなるだけ）。
アトミック差し替えもこの構成で維持できる（原子性が要るのは差し替えの 13 文だけ）。
書き込みは D1 の HTTP API で、バッチが 1 トランザクションになることは本番で確認済み
→ [ADR-0018](docs/adr/0018-d1-http-api-for-sync.md)

**未検証: Cloudflare Access の挙動。** ホーム画面から起動した PWA でセッションが
切れたときの再認証は、PWA ができるまで分からない。セッション期間は最長 1 か月
→ [ADR-0016](docs/adr/0016-cloudflare-access.md)（提案のまま）

## 設計上の決定

理由・却下した代替・再評価のサインは [`docs/adr/`](docs/adr/README.md) にある。
ここには結論だけを置く。**判断を覆す提案をする前に、対応する ADR を読むこと。**

| 決定 | ADR |
|---|---|
| 汎用ツールを使わず閲覧層を自作する | [0001](docs/adr/0001-build-viewer-instead-of-generic-tools.md) |
| ローカル独自データを持たない。除外はクエリのルールで表現する。DB は使い捨てのミラーで Zaim が唯一の正 | [0002](docs/adr/0002-no-local-only-data.md) |
| 編集は必ず Zaim 更新 API を経由する。署名鍵はブラウザに置けないので Worker に編集プロキシを立てる | [0003](docs/adr/0003-edit-through-zaim-api.md) |
| Zaim API は OAuth1.0a で直叩き。署名は Web Crypto だけで自前実装（`worker/src/oauth1.ts`） | [0006](docs/adr/0006-oauth1-in-house.md) |
| API にフィルタの既定値を持たせない。指定なし = 制限なし | [0008](docs/adr/0008-no-default-filters-in-api.md) |
| 実行基盤は TypeScript / Hono / Cloudflare Workers | [0009](docs/adr/0009-migrate-to-workers.md) |
| ミラー DB は D1 | [0010](docs/adr/0010-d1-as-mirror.md) |
| DB アクセスの型は `worker/src/db.ts` に集め、ドライバを名指ししない | [0011](docs/adr/0011-driver-agnostic-db-types.md) |
| 同期は `*_new` に全件構築し `batch()` で差し替える。認証確認と 0 件チェックは差し替えより前 | [0012](docs/adr/0012-table-swap-sync.md) |
| ツールチェーンは TypeScript 7 + oxlint + oxfmt | [0013](docs/adr/0013-voidzero-toolchain.md) |
| 読み取りは Drizzle、同期は素の SQL | [0014](docs/adr/0014-drizzle-for-reads.md) |
| 同期は Worker の外で実行する | [0015](docs/adr/0015-sync-outside-worker.md) |
| 設計判断は ADR として残す | [0017](docs/adr/0017-adr-in-repo.md) |
| 同期の書き込みは D1 の HTTP API を叩く自作ドライバ（`worker/src/d1-http.ts`） | [0018](docs/adr/0018-d1-http-api-for-sync.md) |

以下はコードとテストが守っているもので、ADR にはしていない。

**ルート定義は 1 本のチェーンで書く。** `app.get(...)` を文として並べると
RPC の型が `typeof app` に積み上がらず、PWA の `hc<AppType>` からエンドポイントが
一切見えなくなる。壊れても実行時には何も起きないため、`test/rpc.test.ts` で
型と値の両方を固定してある。なお RPC のレスポンス型は「成功」と
「バリデーションエラー」の union になるので、呼び出し側は `res.status` で
絞ってからでないと本体に触れない。

**キーワード検索は UTF-8 で 48 バイトまで。** D1 は LIKE / GLOB のパターン長を
50 バイトに制限している（標準の SQLite ビルドは 50,000 なのでローカルでは踏めない）。
前後に `%` が付くぶんを引いて 48 バイト。日本語だけなら 16 文字が上限になる。
本番 D1 で確認済み（50 バイトは通り、51 バイトで `SQLITE_ERROR [code: 7500]`）。

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
bun run sync        # 本番 D1 を Zaim から全件更新（手元で実行する同期）
bun run check       # format:check → lint → typecheck → test を一括
bun run test        # workerd 上で実行（D1 も実物を使う）
bun run lint        # oxlint（型認識ルール込み）
bun run format      # oxfmt
bun run cf-typegen  # wrangler.jsonc 変更後に型を再生成
bun run db:init     # 本番 D1 に空のミラーを作る（既存テーブルは DROP される）
bunx wrangler deploy
bunx wrangler tail  # デプロイ後のリクエストログ
```

`db:init` は `sync.ts` の DDL から SQL を生成して `--remote` に流すので、
**実行するとミラーの中身は消える。** 空の DB を作り直すときだけ使う。

ツールチェーンは TypeScript 7（Go 実装）+ oxlint + oxfmt。
lint は `--type-aware` で動かしており、型情報を要するルール（`no-floating-promises`
など）も効く。これは `oxlint-tsgolint` が入っていることが前提。

**型検査は 2 プログラムに分かれている。** `scripts/` は Worker ではなく Bun で
走るため `tsconfig.scripts.json` で別に検査する。Workers と Bun の型を同じ
プログラムに混ぜると `fetch` などの宣言が衝突するため。`bun run typecheck` は両方走る。

同期はローカルでは `curl -X POST http://127.0.0.1:8787/api/sync`（約 17 秒、44 リクエスト）。
本番向けは `bun run sync`（約 22 秒）。運用手順は [`ops/README.md`](ops/README.md)。

CI は GitHub Actions（`.github/workflows/ci.yml`）で、PR と main への push に
`bun run check` を実行する。Zaim の認証情報も Cloudflare へのログインも要らない。

`worker/.dev.vars` に Zaim の OAuth1.0a 認証情報と、同期スクリプト用の
Cloudflare の認証情報（`Account > D1 > Edit` のトークン）が必要
（`worker/.dev.vars.example` 参照）。Zaim 側の値は `~/.claude.json` の
`mcpServers.zaim-api` に設定済みのものと同一。本番 Worker へは
`wrangler secret put` で入れるが、工程 ③ まではその必要が無い。

## 残っている作業

1. Access の JWT（`Cf-Access-Jwt-Assertion`）を Worker 側でも検証する。エッジの
   判定だけに頼ると、設定ミスや Preview URL の漏れが静かな素通りになる
2. PWA（React + Vite + `@cloudflare/vite-plugin`）と、`wrangler.jsonc` の
   Static Assets 設定。ホーム画面から起動したときの Access 再認証の確認もここで
3. 工程 ③ の編集プロキシ（`ZaimClient` に更新系メソッドを足すところから）。
   `wrangler secret put` で Zaim の認証情報を入れるのもここ。同期を Worker の外へ
   出したので、それまで本番に認証情報は要らない

## 運用メモ

- Grafana（Mac mini の :3080）からミラーを読む構想があったが、D1 へ移したため
  そのままでは繋がらない。集計・推移が必要になったら、Worker 側に集計エンドポイントを
  足すか、Grafana の JSON データソースを使う
- 同期の定期実行は launchd（毎日 06:00）。登録・ログ・解除は [`ops/README.md`](ops/README.md)
- コミットは Conventional Commits、本文は日本語
- 旧 Python 実装は完全に削除済み。`src/zaimviewer/`、`tests/`、`.venv`、
  `data/zaim.db`、`__pycache__` のいずれも手元に残っていない
