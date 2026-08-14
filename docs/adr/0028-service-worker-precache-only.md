# ADR-0028: Service Worker は静的アセットの precache だけに使い、ナビゲーションと `/api/*` には触らせない

- ステータス: 承認済み
- 日付: 2026-08-14
- 関連: [#16](https://github.com/Ries630/ZaimViewer/issues/16)、[ADR-0016](0016-cloudflare-access.md)、[ADR-0020](0020-single-package-vite-worker.md)

## 背景

ホーム画面から起動できるようにするにあたり、`vite-plugin-pwa` を入れた。

このアプリの前提が 2 つある。

**認証はエッジの Cloudflare Access が持っている**（[ADR-0016](0016-cloudflare-access.md)）。
セッションが切れた状態で `/api/*` を叩くと、返るのは JSON ではなく
`rieslab.cloudflareaccess.com` への 302 で、別オリジンなのでブラウザが追うと
CORS に阻まれ `fetch` は `TypeError` になる。`src/api/access.ts` はこれを
`redirect: "manual"` で受け止めて `opaqueredirect` を検出し、`location.reload()` で
トップレベルの画面遷移に切り替えることで Access のログインへ到達させている。
**再認証の経路はナビゲーションが実際にネットワークへ出ることに全面的に依存している。**

**データはすべてネットワークの向こうにある。** 明細も集計もマスタも D1 にあり、
端末には何も持たない（[ADR-0002](0002-no-local-only-data.md)）。そもそもオフラインで
表示できるものが無い。

`vite-plugin-pwa` の既定は `navigateFallback: "index.html"` で、ナビゲーション
要求に precache した HTML を返す。これを有効にしたまま Access と組み合わせると、
セッションが切れたときに `location.reload()` がネットワークに出ず、同じシェルが
返り、そのシェルが再び API を叩いて失敗し、また `reload()` する。
**#16 が避けようとしている「アプリが黙って壊れたように見える」状態を、
オフライン対応そのものが作り出す。**

ビルド後の実測では、Cloudflare の Static Assets は HTML に
`cache-control: public, max-age=0, must-revalidate` を付けて返す。Service Worker が
ナビゲーションを横取りしない限り、再読み込みは必ずエッジに届く。

## 決定

`generateSW` 戦略で、precache するのはハッシュ付きの JS / CSS とマニフェスト・
アイコンだけにする。`navigateFallback` は `undefined` にし、`runtimeCaching` は
置かない。ナビゲーションと `/api/*` は Service Worker を通らず、Access の挙動は
Service Worker を入れる前と完全に同じままになる。

設定は `vite.config.ts` の `VitePWA` に閉じる。

## 検討した代替

- **Service Worker を持たない** — iOS 26 は manifest の `display: standalone` だけで
  ホーム画面起動を認めるので、#16 の完了条件はこれでも満たせる。採らなかったのは、
  precache に副作用が無いまま 2 回目以降の起動が速くなるため。ナビゲーションを
  触らない限り、Access との関係は「持たない」場合と同一になる
- **オフラインシェル（`navigateFallback` を残す）** — オフラインでも枠は出るが、
  出るのは枠だけで明細は 1 件も見えない。得られるのは「壊れていないように見える
  空画面」で、代償が上記の再認証ループになる。割に合わない
- **`/api/*` に `NetworkFirst` を敷く** — 直近の結果をオフラインで見られるが、
  家計データを端末のキャッシュに置くことになる。Access で囲っている前提と食い違う。
  加えて Access の 302 をキャッシュ層がどう扱うかという未知が増える

## 結果

- **オフラインではアプリが起動しない。** ナビゲーションがネットワークに出るので、
  圏外や機内モードではブラウザのエラー画面になる。precache した JS / CSS は
  使われないまま残る
- 得られるのは 2 回目以降の起動の短縮だけで、それ以上のオフライン能力は無い
- `registerType: "autoUpdate"` が `skipWaiting` / `clientsClaim` を自動で立てるのは
  `injectRegister` が `"auto"` のときだけなので、`"inline"` にしている今の設定では
  両方を明示的に書く必要がある。書き忘れると新しい Service Worker が waiting のまま
  留まり、起動しっぱなしの PWA では古い JS がいつまでも使われる

## 再評価のサイン

- 直近の明細をオフラインで見たい場面が実際に出てきたとき。そのときは
  `navigateFallback` ではなく、まず「何を端末に置いてよいか」を
  [ADR-0002](0002-no-local-only-data.md) と突き合わせるところから始める
- iPhone 以外（Chrome の PWA インストール要件など）を入口に加えるとき
