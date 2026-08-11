# ADR-0019: Access の JWT を Worker 自身でも検証する

- ステータス: 承認済み
- 日付: 2026-08-11
- 関連: [#9](https://github.com/Ries630/ZaimViewer/issues/9)、[ADR-0016](0016-cloudflare-access.md) を補う

## 背景

[ADR-0016](0016-cloudflare-access.md) で Cloudflare Access を有効化し、認証はエッジで
止まるようになった。ただし Cloudflare 自身が「アプリを完全に守るには
`Cf-Access-Jwt-Assertion` ヘッダの JWT を検証せよ」と明記している。

エッジの判定だけに頼ると、Access の設定ミス・保護漏れ・カスタムドメインを足したときの
張り忘れが、すべて**静かな素通り**になる。落ちて気付くのではなく、通ってしまって
気付かない形の壊れ方で、扱っているのが家計データなので許容しにくい。

有効化の時点で分かった実測値が 2 つある。

- チームドメインは `rieslab` → issuer と JWKS の取得元は
  `https://rieslab.cloudflareaccess.com`
- **Access アプリは 2 つある。** `zaimviewer.ries.workers.dev` と Preview URL
  （`<hash>-zaimviewer.ries.workers.dev`）がそれぞれ別アプリで、AUD タグが異なる

## 決定

Cloudflare 公式の Workers サンプル（[Validating JSON web tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)）に沿い、
`jose` の `createRemoteJWKSet` + `jwtVerify` で JWT を検証する Hono ミドルウェアを
全ルートの手前に置く（`worker/src/access.ts`）。付随して 3 つ決めた。

- **`TEAM_DOMAIN` / `POLICY_AUD` は secret ではなく `wrangler.jsonc` の `vars` に置く。**
  どちらも知られても JWT を偽造できないので秘密ではない
- **`POLICY_AUD` はカンマ区切りで複数受け付け、本番と Preview の両方の AUD を許す**
- **本番で設定が欠けていたら全リクエストを 403 にする。** 検証を飛ばさない

ローカル開発とテストでは検証しない。`ENVIRONMENT` で分ける（`POST /api/sync` を
本番で閉じているのと同じ仕組み）。

## 検討した代替

**エッジの Access だけに任せる（この ADR を書かない）。** Issue #9 の出発点。
設定ミスが静かな素通りになる一点で落とした。

**`TEAM_DOMAIN` / `POLICY_AUD` を `wrangler secret put` で入れる。** 秘密でない値を
secret にすると、リポジトリの外に置くことになり「本番だけ入れ忘れる」経路が残る。
それは #9 が塞ごうとしている失敗と同じ形なので採らなかった。`vars` に置けば
設定はリポジトリに入り、デプロイが設定を運ぶ。

**「変数が設定されているときだけ検証する」。** ローカルは楽になるが、本番で
`POLICY_AUD` を入れ忘れた瞬間に保護が消える。上と同じ理由で落とした。

**本番の AUD だけ許し、Preview URL は Worker 自身が拒否する。** 防御としては
最も素直で、Preview URL の保護漏れを Worker が自力で塞ぐ形になる。ただし
両方とも自分が作った Access アプリで同じポリシー配下にあり、防御レベルは実質
変わらない一方、デプロイ前に Preview URL で動作確認する手段が失われる。
確認手段を残す側を採った。

**`createRemoteJWKSet` をリクエストごとに作る（サンプルどおり）。** jose の鍵
キャッシュは `createRemoteJWKSet` の戻り値クロージャに入るため、毎回作り直すと
1 リクエストにつき 1 回 JWKS を取りに行く。チームドメインをキーにモジュール
スコープでメモ化した。**サンプルから意図的に外した唯一の実装上の点。**

## 結果

- **Preview URL 経由も通るので、Worker 側の検証は「Preview アプリの AUD で
  署名された JWT」を防げない。** 防いでいるのは JWT の欠落・期限切れ・
  他テナントや他アプリの JWT・署名の偽造まで
- **`POLICY_AUD` を間違えるとサイト全体が 403 になる。** fail closed なので
  静かには壊れないが、AUD タグを取り違えたまま deploy すると閲覧できなくなる
- 依存が 1 つ増えた（`jose`）
- Access アプリを増やす・作り直すたびに `wrangler.jsonc` の `POLICY_AUD` を
  更新して deploy し直す必要がある。ダッシュボードの操作だけでは完結しなくなった
- ローカルでは検証されないので、`wrangler dev` は JWT 周りの挙動を再現しない。
  そこは `test/access.test.ts` が JWKS を偽物に差し替えて埋めている

## 再評価のサイン

- カスタムドメインを足したとき（Access アプリが 3 つ目になり `POLICY_AUD` が伸びる）
- Preview URL を使わなくなったとき（本番 AUD だけに絞れる）
- Access のセッション期間や認証方法を変えて JWT のクレームが変わったとき
