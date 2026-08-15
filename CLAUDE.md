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

**工程 ② PWA: 一覧とフィルタまで完了。** React 19 + Vite 8 + TypeScript + Tailwind CSS v4 +
TanStack Query。`@cloudflare/vite-plugin` で Worker と単一の dev サーバ（:5173）で動き、
ビルド成果物は Static Assets として同じ Worker から配信される。RPC クライアントと
Access セッション切れの検出は `src/api/` にある。**リポジトリルートがアプリのルート**で、
`src/` がクライアント、`worker/src/` が Worker（[ADR-0020](docs/adr/0020-single-package-vite-worker.md)）。

明細一覧は `useInfiniteQuery` + `IntersectionObserver` の無限スクロール
（[#14](https://github.com/Ries630/ZaimViewer/issues/14)）。
**一覧は仮想化していない**（測定値と再評価のサインは
[ADR-0021](docs/adr/0021-no-list-virtualization.md)）。

フィルタは「ヘッダ常設 + ボトムシート」（[#15](https://github.com/Ries630/ZaimViewer/issues/15)）。
**既定は振替除外 + 未来を隠すの 2 段**で、初期表示は 4,370 件中 3,839 件から始まる。
金額の下限は既定に置かない（情報を落とす条件なので画面で指定する）。状態は
localStorage に永続化し、URL とは同期しない
（[ADR-0026](docs/adr/0026-filter-defaults-and-persistence.md)）。

**PWA 化: 実装は完了、実機確認が残り（[#16](https://github.com/Ries630/ZaimViewer/issues/16)）。**
`vite-plugin-pwa` でマニフェストと Service Worker を出す。**Service Worker が
precache するのはハッシュ付きの JS / CSS とアイコンだけで、ナビゲーションと
`/api/*` には触らない**（[ADR-0028](docs/adr/0028-service-worker-precache-only.md)）。
オフラインではアプリが起動しない代わりに、Access のセッションが切れたときの
`location.reload()` が必ずネットワークに出る。アイコンは `public/icon.svg` が原本で、
PNG は `./scripts/make-icons.sh` で作り直す。

**アイコンのダーク版は渡せない。** iOS 18 以降はダーク版を持たないアイコンを OS が
自動で暗くするので、緑地は端末がダークモードだと黒に近くなる。`apple-touch-icon` の
`media="(prefers-color-scheme: dark)"` は iOS では効かず（スプラッシュ画像には効く）、
マニフェストの `icons` にも配色を指定する項目が無い。iPhone 実機で確認済みなので、
暗くなるのを直そうとしない。

**色はすべて DaisyUI の semantic トークンで書く。** パレット直書き（`text-gray-500`）は
テーマから外れるので使わない（[ADR-0022](docs/adr/0022-daisyui-for-form-components.md)）。
テーマは端末の設定に従う（[ADR-0024](docs/adr/0024-dark-mode-follows-device.md)）。

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
| PWA | React + Vite + `@cloudflare/vite-plugin` | Worker と単一の dev サーバで動き、同一オリジンで API を叩ける |
| マニフェスト / SW | `vite-plugin-pwa`（`generateSW`） | 設定だけで済む。precache の範囲は絞る（ADR-0028） |
| スタイル | Tailwind CSS v4（`@tailwindcss/vite`） | 設定ファイルを持たず CSS 側で完結する |
| UI 部品 | DaisyUI 5 | #15 のフォーム部品。CSS 側の `@plugin` だけで載る |
| データ取得 | TanStack Query | `useInfiniteQuery` が無限スクロールに、キャッシュがフィルタ切り替えに効く |
| 日付演算 | `temporal-polyfill` | 相対期間（過去 3 か月）が月末で壊れない。整形は `Intl` のまま |

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

**静的アセットは Worker を通らない。** `assets.run_worker_first` を `["/api/*"]` に
してあるため、`index.html` / JS / CSS は Access のエッジ判定だけで守られる。
家計データはすべて `/api/*` の向こうにあり、そこは Worker の JWT 検証も通る
→ [ADR-0020](docs/adr/0020-single-package-vite-worker.md)

**Access の JWT は Worker 自身でも検証する。** エッジの判定だけに頼らず、
`Cf-Access-Jwt-Assertion` を `worker/src/access.ts` で検証する。`TEAM_DOMAIN` と
`POLICY_AUD` は秘密でないので `wrangler.jsonc` の `vars` に置き、本番と Preview の
AUD を両方許す。本番で設定が欠けていれば全リクエストが 403 になる（fail closed）
→ [ADR-0019](docs/adr/0019-verify-access-jwt-in-worker.md)

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
| Access の JWT を Worker 自身でも検証する。設定は `vars`、本番・Preview 両方の AUD を許す | [0019](docs/adr/0019-verify-access-jwt-in-worker.md) |
| PWA と Worker を 1 パッケージに同居させ、リポジトリルートをアプリのルートにする。静的アセットは Worker を通さない | [0020](docs/adr/0020-single-package-vite-worker.md) |
| 明細一覧を仮想化せず、取得済みの全件を素の DOM で描く | [0021](docs/adr/0021-no-list-virtualization.md) |
| DaisyUI を採用する。色は semantic トークンで書き、パレット直書き（`text-gray-500`）は使わない | [0022](docs/adr/0022-daisyui-for-form-components.md) |
| 収入の金額が白地で読めるよう、`light` テーマの `success` だけ値を上書きする。他の色は組み込みの既定のまま | [0023](docs/adr/0023-darken-success-for-income-amount.md) |
| ダークモードは端末の設定に従う。色の上書きは `light` 側だけに閉じ、テーマ切り替え UI は持たない | [0024](docs/adr/0024-dark-mode-follows-device.md) |
| 日付演算にだけ Temporal を使い、適用範囲を `src/lib/period.ts` に閉じる。表示の整形は `Intl` のまま | [0025](docs/adr/0025-temporal-for-date-arithmetic.md) |
| フィルタの既定値（振替除外 + 未来を隠す）と保存先は PWA が持つ。localStorage に永続化し、URL とは同期しない | [0026](docs/adr/0026-filter-defaults-and-persistence.md) |
| フィルタの選択肢は Zaim の並び（有効なものが先 → 支出・収入 → `sort`）で返す。削除済みは明細から参照されているものだけ残す | [0027](docs/adr/0027-master-options-follow-zaim-order.md) |
| Service Worker は静的アセットの precache だけに使い、ナビゲーションと `/api/*` には触らせない | [0028](docs/adr/0028-service-worker-precache-only.md) |

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

**入力の上限値の正は `worker/src/limits.ts` の 1 か所。** キーワードの 48 バイトと
金額の 9 桁（`MAX_AMOUNT`）がここにあり、Worker（400 を返す判定）とクライアント
（入力欄でそれより前に止める）の両方がそこから import する。依存を持たない別モジュールに
してあるのが肝で、`index.ts` に置いたまま値として import するとクライアントのバンドルに
Worker 本体が入る。金額に上限を置いているのは、`<input type="number">` が桁数を
制限せず、安全な整数（2^53-1）を超えると zod の `.int()` が `too_big` で 400 を返すため。

**入力欄では `input-sm` を使わない。** daisyUI は iOS Safari 限定
（`@media (pointer:coarse)` かつ `@supports (-webkit-touch-callout:none)`）で
`.input:focus` の font-size を 1rem に上げる。iOS Safari が 16px 未満の入力欄で
ページを拡大するのを封じるための措置だが、フォーカスのたび文字が跳ねる。
`src/index.css` の `@utility input` で `--font-size-min: 1rem` に固定して
最初から 16px にしてあり、`input-sm`（0.75rem）を足すとその指定と食い違う。
**入力欄が既定サイズ（高さ 2.5rem）になった以上、フォーム内のボタンも `btn-sm` に
しない。** 32px と 40px が同じ行に並ぶと、とくに `join` で枠線が揃わず崩れて見える。
文字サイズは入力欄 16px / ボタン 14px で揃わないが、これは iOS 対策で入力欄だけ
上げた結果で、高さが揃っていれば問題にならない。

**マニフェストの `link` には `crossorigin="use-credentials"` が要る。** ブラウザは
マニフェストを既定で資格情報なしに取りに行くため、Access 配下では Cookie が付かず
302 → 別オリジン → CORS で必ず失敗する。`vite.config.ts` の `useCredentials: true` が
この属性を出している。外すとホーム画面に追加したときだけ名前もアイコンも
反映されない、という形で出る（画面は普通に動くので気付きにくい）。

**スキーマ定義は 2 か所にあり、テストで守る。** テーブルの実体は `sync.ts` の
DDL が作り、読み取りの型付けは `schema.ts` が担う。片方だけ変更すると
「型は通るのに実行時に列が無い」という壊れ方をするため、`test/schema.test.ts` が
`PRAGMA table_info` と突き合わせて検出する。テストの固定データも `sync.ts` の
DDL と差し替え処理をそのまま使うので、スキーマの写しは増えない。

**クライアントのテストは純関数だけで、workerd 上で走る。** vitest は全ファイルを
`@cloudflare/vitest-pool-workers` に載せるので、DOM を要するテストは書けない。
整形・フォールバック・日付のまとめといった壊れやすい部分を `src/lib/` の純関数に
切り出し、コンポーネントは型検査とブラウザでの目視で見ている。**`Intl` の出力は
実行環境の ICU に依存する**点に注意（例: ja-JP の JPY は workerd とブラウザでは
全角の ￥ だが、Bun では半角の ¥ になる）。テストが固定しているのは workerd の
出力で、そちらが CLDR とブラウザに一致する。

**RPC のレスポンスは `src/api/client.ts` の `unwrap` を通す。** `zValidator` のある
ルートは成功と 400 の union になり、`res.ok` で分岐しても `json()` の型は union の
ままなので、型の側でも成功側を選び出す必要がある。判定は status で行う（成功側は
`ContentfulStatusCode`、エラー側は `400` のリテラル）。

**フィルタの SQL 組み立ては `worker/src/queries.ts` に閉じる。** 「除外はクエリの
ルールで表現する」の実装箇所。よく使う除外条件に名前を付けるプリセット層を将来
載せる場合も、その層は `TransactionFilter` を組み立てるだけでよく SQL を書かずに済む。
プリセットを今作らないのは、どのノイズを消したいかが実データを触りながら
決まる段階で、固まっていないルールを設定ファイルに固定したくないため。

**マスタの並び替えも `worker/src/queries.ts` の `fetchMasters` に閉じる。**
選択肢は Zaim の画面と同じ順序で返す必要があり、その材料（`active`、カテゴリの
`sort`、明細からの参照）はすべて SQL の側にある。クライアントで並べ替えると
全件を持ってきてから捨てることになる（[ADR-0027](docs/adr/0027-master-options-follow-zaim-order.md)）。
**削除済みのマスタは `sort` が 0 に潰れる**ので、素直に `sort` で並べると先頭に来る。

**クライアント側は `FilterState`（画面の状態）と `TransactionFilter`（API の引数）を
別の型で持つ。** 両者は 1 対 1 でなく、たとえば「未来を隠す」は API に無い概念で、
`date_to` を今日に丸める操作として畳み込まれる。変換は `src/lib/filter.ts` の
`toTransactionFilter`。選択肢の従属関係（種別 → カテゴリ → ジャンル）を保つのは
`src/lib/masters.ts` の `reconcile` で、**状態の更新は必ずこれを通す**。
通さないと、画面に出ていない選択が条件として効き続けて件数が合わなくなる。

## 開発

```bash
bun install
bun run dev         # PWA と Worker を :5173 に同居させて起動（ローカル D1）
bun run build       # PWA と Worker をビルド（dist/client と dist/zaimviewer）
bun run sync        # 本番 D1 を Zaim から全件更新（手元で実行する同期）
bun run check       # format:check → lint → typecheck → test → build を一括
bun run test        # workerd 上で実行（D1 も実物を使う）
bun run lint        # oxlint（型認識ルール込み）
bun run format      # oxfmt
bun run cf-typegen  # wrangler.jsonc 変更後に型を再生成
bun run db:init     # 本番 D1 に空のミラーを作る（既存テーブルは DROP される）
./scripts/make-icons.sh  # public/icon.svg からホーム画面アイコンの PNG を作り直す
bunx wrangler deploy
bunx wrangler tail  # デプロイ後のリクエストログ
```

**コマンドはすべてリポジトリルートで実行する。** `worker/` にあった
`package.json` などは ADR-0020 でルートへ上がった。`worker/` に残っているのは
Worker のソース・テスト・スクリプトと、その tsconfig 2 つだけ。

`db:init` は `sync.ts` の DDL から SQL を生成して `--remote` に流すので、
**実行するとミラーの中身は消える。** 空の DB を作り直すときだけ使う。

ツールチェーンは TypeScript 7（Go 実装）+ oxlint + oxfmt。
lint は `--type-aware` で動かしており、型情報を要するルール（`no-floating-promises`
など）も効く。これは `oxlint-tsgolint` が入っていることが前提。

**型検査は 3 プログラムに分かれている。** ルートの `tsconfig.json` がクライアント
（`src/`、DOM の型が要る）、`worker/tsconfig.json` が Worker 本体とテスト、
`worker/tsconfig.scripts.json` が手元の Bun で走る `worker/scripts/`。Workers と
DOM と Bun はいずれも `fetch` などの宣言が衝突するため混ぜられない。
`bun run typecheck` は 3 つとも走る。

**Worker の tsconfig は `worker/` に置いたままにする。** oxlint はファイルごとに
tsconfig を自動探索するので、ルートに 1 つだけ置くと Worker 側で型認識ルールが
黙って効かなくなる。移動時に floating promise を仕込んで検出されることを確認した。

**クライアントは `src/worker-globals.d.ts` で Workers のグローバルを潰している。**
`hc<AppType>` のために Worker のソースがクライアント側のプログラムに取り込まれ、
`D1Database` などが解決できないため。生成物をクライアントの `types` に足すと
DOM と衝突するので採れない。本物の型による検査は `worker/tsconfig.json` が担う。

**`worker-configuration.d.ts` は手元と CI で違う型になる。** 追跡していない生成物で、
`wrangler.jsonc` の `vars` をリテラル型として出す。ただし `.dev.vars` が同じ名前を
上書きしていると `string` に広がるため、`.dev.vars` の無い CI ではリテラルのままになる。
**手元の型検査が通っても CI で落ちうる**のはこれが理由。env を書き換えるテストは
生成物の型ではなく宣言された型を経由する（`test/access-harness.ts` の `accessEnv`）。
CI と同じ型で確かめたいときは `.dev.vars` を退避して `bun run cf-typegen` し直す。

同期はローカルでは `curl -X POST http://localhost:5173/api/sync`（約 17 秒、44 リクエスト）。
本番向けは `bun run sync`（約 22 秒）。運用手順は [`ops/README.md`](ops/README.md)。

CI は GitHub Actions（`.github/workflows/ci.yml`）で、PR と main への push に
`bun run check` を実行する。Zaim の認証情報も Cloudflare へのログインも要らない。

`.dev.vars`（リポジトリルート）に Zaim の OAuth1.0a 認証情報と、同期スクリプト用の
Cloudflare の認証情報（`Account > D1 > Edit` のトークン）が必要
（`.dev.vars.example` 参照）。Zaim 側の値は `~/.claude.json` の
`mcpServers.zaim-api` に設定済みのものと同一。本番 Worker へは
`wrangler secret put` で入れるが、工程 ③ まではその必要が無い。

## 残っている作業

1. ホーム画面から起動したときの Access 再認証の実機確認
   （[#16](https://github.com/Ries630/ZaimViewer/issues/16)）。マニフェストと
   Service Worker は入っているので、残るのは iPhone での確認だけ。ADR-0016 を
   「承認済み」にできるのはここ
2. 明細の主表示が長いときに全文を読む手段
   （[#19](https://github.com/Ries630/ZaimViewer/issues/19)）
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
