# ADR-0005: iPhone からの到達は Tailscale で、認証は自作しない

- ステータス: 廃止（[ADR-0016](0016-cloudflare-access.md) により置換）
- 日付: 2026-08-06
- 関連: `7750953`

## 背景

主な利用は iPhone から。閲覧層は Mac mini 上の FastAPI で動く
（[ADR-0004](0004-sqlite-as-mirror.md)）ため、外出先から Mac mini に到達する
経路が要る。

扱うのは家計データなので、**安全側に倒す**のが前提。同時に、認証を自作したくない。
ログイン画面・セッション・パスワードリセットを自分で書けば、そこがそのまま
最も壊れやすい部分になる。

## 決定

iPhone からは Tailscale 経由で自宅の Mac mini に接続する。インターネットには
公開せず、アプリ側に認証機構を持たない。

## 検討した代替

- **ポート開放 + 自作の認証** — 認証を自作しないという前提に反する
- **Cloudflare Tunnel + Cloudflare Access** — Mac mini には既に `cloudflared` が
  同居しており、これでも成立した。Tailscale を採ったのは、この時点では
  「そもそも公開しない」方が単純だったため

## 結果

- アプリ側は認証について何も考えなくてよい。到達できる = 認可されている
- iPhone に Tailscale クライアントが常駐する
- **Mac mini がスリープしていると到達できない。** [ADR-0004](0004-sqlite-as-mirror.md)
  の制約と同じ根に由来する

## 廃止の経緯

[ADR-0009](0009-migrate-to-workers.md) で Cloudflare Workers に移り、閲覧層が
自宅ネットワークの外に出たため、Tailscale で囲う手が使えなくなった。
「認証を自作しない」という前提はそのまま引き継ぎ、
[ADR-0016](0016-cloudflare-access.md) で Cloudflare Access に置き換える。
