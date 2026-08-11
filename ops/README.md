# 運用（手元の Mac mini）

同期だけが Workers の外で動く。理由は [ADR-0015](../docs/adr/0015-sync-outside-worker.md)、
D1 への書き込み経路は [ADR-0018](../docs/adr/0018-d1-http-api-for-sync.md) を参照。

## 手動で同期する

```bash
bun run sync
```

リポジトリルートの `.dev.vars` から Zaim と Cloudflare の認証情報を読む
（`.dev.vars.example` 参照）。所要は 20 秒前後で、内訳は実行後の 1 行に出る。

途中で失敗した場合、ミラーは差し替え前の状態のまま残る。同期は `*_new` の
DROP から始まるので、そのまま再実行してよい。

## 定期実行（launchd）

```bash
sh ops/install-sync-agent.sh
```

毎日 06:00（ローカルのタイムゾーン）に実行する。**リポジトリの構成やパスを
変えたら流し直すこと。** plist には絶対パスが焼き込まれており、登録済みの
エージェントは自動では追随しない（[ADR-0020](../docs/adr/0020-single-package-vite-worker.md)
でルート構成を変えたときも入れ直しが要った）。スリープで実行時刻を跨いだ場合は
復帰時に 1 回だけ走る。

| 操作 | コマンド |
|---|---|
| ログ | `tail -f ~/Library/Logs/dev.ries.zaimviewer.sync.log` |
| 即時実行 | `launchctl kickstart -p gui/$(id -u)/dev.ries.zaimviewer.sync` |
| 状態 | `launchctl print gui/$(id -u)/dev.ries.zaimviewer.sync` |
| 解除 | `launchctl bootout gui/$(id -u)/dev.ries.zaimviewer.sync` |

スクリプトは再実行できる。パスや実行時刻を変えたら、もう一度流せば入れ直される。

## ミラーの中身を直接見る

```bash
bunx wrangler d1 execute DB --remote --command "SELECT * FROM sync_meta"
```
