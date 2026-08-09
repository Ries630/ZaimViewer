# ADR-0016: Cloudflare Access でアプリ全体を保護する

- ステータス: 提案
- 日付: 2026-08-09
- 関連: [#5](https://github.com/Ries630/ZaimViewer/issues/5)、[ADR-0005](0005-tailscale-for-access.md) を置換

## 背景

[ADR-0009](0009-migrate-to-workers.md) で閲覧層が自宅ネットワークの外に出たため、
Tailscale で囲う手（[ADR-0005](0005-tailscale-for-access.md)）が使えなくなった。

前提は変わっていない。家計データなので認証は必須で、かつ**認証は自作しない**。
デプロイすればアプリは公開 URL を持つので、何かで囲う必要がある。

Cloudflare Access（Zero Trust）は 50 ユーザーまで無料で、Worker の URL の
手前で認証を強制できる。アプリ側のコードは変わらない。

## 決定

Cloudflare Access でアプリ全体を保護する。アプリ側には認証機構を持たせない。

## 検討した代替

- **Worker 内で認証を実装する**（Basic 認証、セッション、WebAuthn など）—
  「認証を自作しない」という前提に反する
- **Cloudflare Tunnel で Mac mini に戻す** — [ADR-0009](0009-migrate-to-workers.md) の
  スリープ問題が戻る

## 未検証の点

**この ADR がまだ「提案」なのは、デプロイしないと確認できない点が残っているため。**

- ホーム画面から起動した PWA で、Access のセッションが切れたときの再認証の挙動。
  PWA は通常のブラウザタブと異なる扱いになることがあり、Access のリダイレクトが
  期待どおり動くとは限らない。セッション期間は最長 1 か月まで延ばせるので、
  頻度を下げること自体は可能
- 同期スクリプト（[ADR-0015](0015-sync-outside-worker.md)）が D1 の HTTP API を
  叩く経路は Access の外だが、もし Worker のエンドポイントを使うなら
  サービストークンが要る

## 結果（想定）

- 認証周りのコードを 1 行も書かない
- Cloudflare への依存が 1 段深くなる
- 認証方法（メール OTP / Google など）とセッション期間の設定が運用項目として増える
