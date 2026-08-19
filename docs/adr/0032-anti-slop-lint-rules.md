# ADR-0032: anti-slop の Oxlint プラグインをベンダリングし、ルールを段階的に有効にする

- ステータス: 承認済み
- 日付: 2026-08-19
- 関連: [#41](https://github.com/Ries630/ZaimViewer/issues/41)、[#42](https://github.com/Ries630/ZaimViewer/issues/42)、[ADR-0011](0011-driver-agnostic-db-types.md)、[ADR-0013](0013-voidzero-toolchain.md)

## 背景

anti-slop は Oxlint の JS プラグインで、「型の証拠を捨てる」「境界でパースせず `typeof` で
分岐する」といった実装パターンを 15 のルールで拒否する。npm では配られておらず、
スキルが配る `install.mjs` でリポジトリにコピーして使う。

採否を決める前に、使い捨ての worktree に全 15 ルールを `error` で入れて実測した。
**指摘は 53 件、鳴ったのは 6 ルールだけ。** 既存の lint はクリーンなので、増えるのは
この 53 件ちょうどだった。

| ルール | 件数 |
|---|---|
| `require-safety-comment-for-type-assertion` | 16（うちテスト 9） |
| `no-unsafe-dictionary-type` | 12 |
| `no-unknown-parameters` | 9 |
| `no-runtime-typeof` | 8 |
| `no-known-value-widening` | 5 |
| `no-unknown-returns` | 3 |

ファイル別では `src/lib/filter-storage.ts` が 17 件で突出していた。localStorage から
復元した値を `unknown` で受け、`typeof` の手書きガードで検証している箇所で、
`no-unknown-parameters` と `no-runtime-typeof` はどちらもここを指している。
zod は既に依存にあるので、指摘の内容そのものは正しい。

一方で、直せない・直すべきでない指摘も混ざっていた。`worker/src/db.ts` の
`all<T = Record<string, unknown>>()` は D1 のシグネチャを写したもので
（→ [ADR-0011](0011-driver-agnostic-db-types.md)）、ここを「直す」と外部インターフェースと
食い違う。`src/api/client.ts` の `json: () => Promise<unknown>` は `Response.json()` の
型そのもので、名前付きのドメイン型には置き換えられない。

実行環境の制約も測った。**プラグインは `.ts` のまま読まれ、Oxlint は `node` で実行する。**
node 22.12 では `ERR_UNKNOWN_FILE_EXTENSION` で設定の読み込み自体が失敗し、
lint が 1 件も走らない（型ストリップが既定で効くのは node 22.18 以降）。node 24.19.0 では
オプション無しで動く。

直し方も先に確かめた。`no-known-value-widening` は注釈を消しても `satisfies` に
変えても消える。`require-safety-comment-for-type-assertion` が要求する `SAFETY:` は、
本文が日本語でも通る。`no-runtime-typeof` には `allowInTypeGuards` オプションがあり、
`true` にすると型述語関数（`value is Foo`）の中が許され 8 → 5 件になる。

## 決定

プラグインを `tools/oxlint/anti-slop/` にベンダリングし、**11 ルールを採用、4 ルールを不採用**
とする。採用分は 3 段に分けて有効にし、段ごとに PR を分ける。

- **第 1 段（指摘 0 件、コード変更なし）**: `no-chained-type-assertions`、`no-widen-then-assert`、
  `no-unknown-type-aliases`、`no-object-parameters`、`no-reflect-get`、`no-reflect-apply`、
  `no-module-mocking`
- **第 2 段（21 件を直す）**: `no-known-value-widening`、
  `require-safety-comment-for-type-assertion`（テストでは切る）
- **第 3 段（`filter-storage.ts` の zod 化が前提）**: `no-unknown-parameters`、
  `no-runtime-typeof`（`allowInTypeGuards: true`）

不採用は 4 つ。`no-unsafe-dictionary-type` は上記のとおり D1 のシグネチャを写した箇所を
直させるため。`no-unknown-returns` は `Response.json()` に対する誤検知が避けられないため。
`no-conditional-empty-object-spread` は `{...(cond ? { place } : {})}` を禁じるもので、
工程 ③ の PUT ペイロード組み立ての書き味を優先した。`no-shape-in-symbol-names` は
識別子に "shape" という語を禁じるだけで、一般則ではない。

`oxlint` と `@oxlint/plugins` はキャレットを付けず同一バージョンに固定する。
プラグイン API を挟んで結合しているため、range で別々に上がると食い違いうる。

## 検討した代替

**15 ルールすべてを一度に `error` にする。** 53 件を一度に直すことになり、そのうち
15 件（`no-unsafe-dictionary-type` の一部と `no-unknown-returns`）は外部インターフェースを
写した箇所なので、直せば設計が悪くなる。lint を通すために型をロンダリングする動機が
生まれる時点で、ルールの目的と逆を向く。

**導入しない。** 実測した 53 件のうち、`filter-storage.ts` の 17 件は「zod があるのに
localStorage の復元だけ手書きの `typeof` ガード」という実在の穴を指しており、指摘の質は
高かった。捨てる理由が無い。

**鳴っているルールを `warn` で入れる。**（未検討）

## 結果

**node のバージョンに縛られる。** 22.18 未満では lint が起動しない。CI に
`actions/setup-node` が増え、bun だけで完結しなくなった。手元の環境でも同じ制約がかかる。

**上流の更新が自動で来ない。** npm パッケージではないので、更新は `install.mjs --force` で
上書きして diff を読む手作業になる。しかも Effect 用のプラグイン（`effect/`）を採用時に
削っているため、次の更新でも素の差分は取れない。

**ベンダリングした 19 ファイルは型検査も整形も掛からない。** `tsconfig.json` の `include` に
入れず、`.oxfmtrc.json` の `ignorePatterns` にも入れた（整形すると上流と diff が取れない）。
壊れても `bun run check` の型検査やテストでは分からず、lint 実行時のエラーで初めて出る。

**Tailwind の走査対象から `tools/` を外す必要があった。** ベンダリングしたルールの
実装にはクラス名として解釈できる語（`object`、`shape` など）が並んでおり、除外しないと
本番 CSS に混入する。実測 71.73 → 72.28 kB（gzip 12.68 → 12.76 kB）。
[ADR-0031](0031-agents-md-as-instruction-source.md) が「再発しうる」と書いた結合が
実際に再発した形で、ビルドもテストも通るため検出経路は無い。今回はファイル名ではなく
ディレクトリ単位（`@source not "../tools"`）で外した。

**`as` を書くたびに `SAFETY:` コメントが要る**（第 2 段以降。テストは除く）。1 行の
型合わせでも根拠を書く必要があり、それが狙いでもある。

**第 3 段の 2 ルールは、`filter-storage.ts` の zod 化が終わるまで有効にできない。**
それまでは同じパターンを新しく書いても止まらない。

**採用しなかった 4 ルールが禁じるパターンは、これまでどおり書ける。**
`Record<string, unknown>` も `x as unknown` を返す関数も lint では止まらない。

## 再評価のサイン

- 誤検知を黙らせる `oxlint-disable` コメントが増え始めた → そのルールの採否を見直す。
  1 ファイルに 2 つ以上付いた時点で、ルールがこのリポジトリに合っていない
- anti-slop が npm パッケージとして配られるようになった → ベンダリングをやめる
- [ADR-0011](0011-driver-agnostic-db-types.md) のドライバ非依存の型をやめた → `no-unsafe-dictionary-type` の
  不採用理由が消えるので、採用を再検討する
- 第 3 段の zod 化で指摘が消えなかった → 消えなかったルールはその時点で不採用に倒す
