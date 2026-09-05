# 運用（手元の Mac mini）

同期だけが Workers の外で動く。理由は [ADR-0015](../docs/adr/0015-sync-outside-worker.md)、
D1 への書き込み経路は [ADR-0018](../docs/adr/0018-d1-http-api-for-sync.md) を参照。

編集機能の公開・中断後の照合・共有排他の復旧は [編集の運用手順](editing.md) を参照する。

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

## receipt_id の移行と収入の補正（Issue #37、一度限り）

判断の正は [ADR-0035](../docs/adr/0035-itemized-receipt-id-is-payment-only.md)。
`receipt_id` による品目化は支出だけに使い、収入と振替には独自採番しない。

2026-09-02 に作成した `.receipt-id-backfill-manifest.json` は、当初の固定計画である
支出 1,080 件・収入 60 件を含む version 1 の対応表である。支出 1,080 件への適用と
Zaim 実機での品名表示確認は完了した。収入 60 件は効果が未検証だったため、以下の
専用操作で `receipt_id = 0` へ戻す。

固定計画には品名と dry-run 時点の金額が入るため Git に追加しない。収入の復元と
緊急時の全件復元に必要なので、ファイルを再生成・上書きしない。
**変更系は PR のマージ後に `main` で実行する。**

### 収入 60 件だけを戻す

```bash
bun run receipt-id:backfill -- --rollback-income
```

固定計画のうち、計画値が現在も付いている収入だけを 1 件ずつ `receipt_id = 0` へ戻す。
支出は更新対象に含めず、計画外の値も上書きしない。各更新の直前に Zaim API から明細を
取り直し、最新の `amount` を必ず同送する。更新直後にも全列を取り直して、
`receipt_id` 以外が変わっていないことを確認する。成功した ID は
`.receipt-id-backfill-progress.jsonl` へ追記する。

初回の完了件数は 60 件。途中で失敗した場合は同じコマンドを再実行でき、API 上で
既に 0 の収入は飛ばす。完了後の再実行は 0 件になる。

### ミラーと件数を確認する

```bash
bun run sync
bunx wrangler d1 execute DB --remote --command "SELECT mode, COUNT(*) AS count FROM transactions WHERE receipt_id BETWEEN 4200000000 AND 4200001139 GROUP BY mode"
```

独自採番域に残るのが `payment = 1080` だけで、`income` と `transfer` が出ないことを
確認する。ZaimViewer の API でも同じ状態を確認する。

### 完了済み操作を再実行する場合

`--canary` と `--apply` は支出だけを対象にする。`--apply` は適用済みの支出を飛ばすため
再開可能だが、Issue #37 の支出 1,080 件は既に完了しており、通常は再実行しない。
引数なしの dry-run は当初の version 1 固定計画を作る歴史的な操作であり、今後の移行対象の
選択には使わない。

### 緊急時に支出も戻す

```bash
bun run receipt-id:backfill -- --rollback
```

同じ固定計画を使い、計画値が付いた全明細を `receipt_id = 0` へ戻す。計画外の値は
上書きしない。支出の品名表示効果も失われるため、通常の収入補正には使わない。
完了後は `bun run sync` でミラーを追随させる。
