# ADR-0004: ミラー DB に SQLite を使う

- ステータス: 廃止（[ADR-0010](0010-d1-as-mirror.md) により置換）
- 日付: 2026-08-06
- 関連: `be3b40a`

## 背景

当初は PostgreSQL を前提に考えていた。理由は 3 つあった。

1. Directus を使うつもりだった。PostgreSQL が最も素直に繋がる
2. Grafana から集計・推移を見る想定で、複数の読み手が同時に触る
3. データが育ったときの移行を考えていた

この 3 つが順に消えた。

1. Directus を落とした（[ADR-0001](0001-build-viewer-instead-of-generic-tools.md)）
2. Grafana は同じ Mac mini 上のコンテナ（:3080）で、読み手は同一ホストの
   2 プロセスだけと分かった
3. 独自データを持たないと決めたので（[ADR-0002](0002-no-local-only-data.md)）、
   移行は再同期と同義になった

実データは全 4,362 件、マスタを含めても DB ファイルは数 MB に収まる。

## 決定

ミラー DB は `data/zaim.db` の SQLite ファイルにする。DB サーバは立てない。

## 検討した代替

- **PostgreSQL** — 上の 3 つの根拠が全て消えた時点で、Docker コンテナを 1 つ
  増やすコストだけが残った
- **DuckDB** — 集計は速いが、書き込みの並行性と Grafana プラグインの成熟度で劣る。
  この規模では速度差が体感に出ない

## 結果

- 読み手が同一ホストのプロセスに限られる。iPhone からは Mac mini に到達する
  必要があり、[ADR-0005](0005-tailscale-for-access.md) の Tailscale 前提と対になる
- **Mac mini がスリープしていると何も見られない。** この制約が
  [ADR-0009](0009-migrate-to-workers.md) で基盤ごと乗り換える動機のひとつになった
- ファイル 1 つなので、`os.replace` によるアトミック差し替えが使える
  （[ADR-0007](0007-atomic-swap-sync.md)）

## 廃止の経緯

[ADR-0009](0009-migrate-to-workers.md) で実行基盤を Cloudflare Workers に移した。
Workers からローカルのファイルは読めないため、DB も移す必要が生じ、
[ADR-0010](0010-d1-as-mirror.md) で D1 を選んだ。
