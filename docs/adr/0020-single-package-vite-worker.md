# ADR-0020: PWA と Worker を 1 つのパッケージに同居させ、リポジトリルートをアプリのルートにする

- ステータス: 承認済み
- 日付: 2026-08-11
- 関連: [#13](https://github.com/Ries630/ZaimViewer/issues/13)、[ADR-0019](0019-verify-access-jwt-in-worker.md) を補う

## 背景

工程 ② の残りとして PWA を作る。[#4](https://github.com/Ries630/ZaimViewer/issues/4) の時点で
`@cloudflare/vite-plugin` を使うことは決まっていた。Vite を別ポートで立てる構成だと
開発中だけ CORS かプロキシ設定が要るため、単一の dev サーバで動かしたい。

着手時に 2 つ分かった。

**プラグインは `wrangler.jsonc` を Vite プロジェクトのルートで探す。** つまり
React と Worker は 1 つのパッケージに同居する前提になっている。それまでの
リポジトリは `worker/` の下に `package.json` から `tsconfig.json` まで一式が
入っており、そのままでは Vite のルートを置く場所が無い。

**既定では静的アセットが Worker より先に配信される。** 何もしなければ
`index.html` も JS も CSS も [ADR-0019](0019-verify-access-jwt-in-worker.md) で
入れた JWT 検証を通らない。Cloudflare の Pages 移行ガイドが
「認証チェックを挟むなら `assets.run_worker_first` が必要」と名指ししている。
`run_worker_first` は `true` かパターン配列（`["/api/*"]` など）を取る。

## 決定

**リポジトリルートをアプリのルートにする。** `package.json` / `wrangler.jsonc` /
`vite.config.ts` / `vitest.config.ts` と lint 設定をルートへ移し、`src/` に
クライアント、`worker/src/` に Worker を置く。ソースは動かさず、設定ファイルだけが
上がる。

**`run_worker_first` は `["/api/*"]` にする。** 静的アセットは Worker を通さない。

**型検査は 3 プログラムに分ける。** クライアント（`tsconfig.json`）、Worker
（`worker/tsconfig.json`）、手元で走るスクリプト（`worker/tsconfig.scripts.json`）。
Worker の tsconfig をあえて `worker/` に残したのは、oxlint がファイルごとに
tsconfig を自動探索するため。ルートに 1 つだけ置くと、Worker 側で型認識ルール
（`no-floating-promises` など）が黙って効かなくなる。移動後に floating promise を
仕込んで検出されることを確認した。

## 検討した代替

**`worker/` を Vite プロジェクトのルートにする。** `wrangler.jsonc` を動かさずに
済み、CI の `working-directory` もそのままでよい。落としたのは、`worker/` の下に
`index.html` と React が入って名前と実態がずれるため。`worker/` が
サブディレクトリだったのは以前ルートに Python 実装があった名残で、その理由は
もう無い。

**`web/` を別パッケージにし、`assets.directory` でビルド成果物を参照する。**
Vite プラグインを使わない構成。単一 dev サーバが得られず、開発中だけ CORS か
プロキシ設定が要る。#4 が明示的に避けていた形なので採らなかった。

**`run_worker_first: true`（全リクエストを Worker に通す）。** ADR-0019 の
「エッジだけに頼らない」を静的アセットにも徹底できる。落としたのは、守る対象が
そこに無いため。家計データはすべて `/api/*` の向こうにあり、`index.html` /
JS / CSS はアプリの外枠でしかない。Access が壊れた場合に見えるのは外枠だけで、
データは Worker の JWT 検証が 403 で止める。加えて SPA のアセット配信は
Worker の invocation を使わずに済む。

**クライアントの型検査に `worker-configuration.d.ts` を足す。** `hc<AppType>` の
ために Worker のソースがクライアント側のプログラムに取り込まれ、`D1Database` や
`ExportedHandler` が解決できない。生成物を足せば解決するが、Workers の
ランタイム型は `fetch` や `Response` を DOM とは別の形で宣言するため衝突する
（`tsconfig.scripts.json` を分けているのと同じ理由）。代わりに
`src/worker-globals.d.ts` でそれらのグローバルだけを `any` として宣言した。

## 結果

- **クライアント側のプログラムは Worker の D1 まわりを検査しない。**
  `src/worker-globals.d.ts` が `any` で潰しているため。`worker/tsconfig.json` が
  本物の型で同じソースを検査しているので抜けは無いが、**穴埋めの対象が増えたら
  同じファイルに足すことになる**。Worker が新しい Workers 固有のグローバルを
  使うたびにここが伸びる
- **静的アセットは Cloudflare Access のエッジ判定だけで守られる。** Access の
  設定ミスがあると、アプリの外枠（HTML / JS / CSS）は誰にでも見える。
  ADR-0019 の多層防御はデータにしか及ばない
- `bun run dev` の入口が `wrangler dev`（:8787）から `vite`（:5173）に変わった。
  ローカル同期の URL も変わる
- `vite build` の出力 `dist/zaimviewer/` に `.dev.vars` が複製される。
  `.gitignore` で `dist/` ごと除外した
- oxfmt の対象がリポジトリ全体に広がり、Markdown まで整形されるようになった。
  日本語の全角幅を勘定せずに表を桁揃えしてソースが読みにくくなるため、
  `.oxfmtrc.json` で `**/*.md` を除外した

## 再評価のサイン

- 静的アセット自体に秘密が入るようになったとき（`run_worker_first: true` へ）
- `src/worker-globals.d.ts` の穴埋めが増えて、何を検査していないか分からなくなったとき
- Worker とクライアントで依存の要件が食い違い、1 つの `package.json` が窮屈になったとき
