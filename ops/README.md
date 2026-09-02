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

## receipt_id を後付けする（Issue #37、一度限り）

この手順は、`receipt_id = 0` かつ品名ありの支出 1,080 件・収入 60 件だけを対象にする。
振替 3 件は ADR-0030 に従って対象外。**変更系は PR のマージ後に `main` で実行し、
各ゲートの結果を確認してから次へ進む。**

### 1. dry-run

```bash
bun run receipt-id:backfill
```

Zaim API から全件を取り直し、対象一覧を標準出力へ出す。同時に、ID 順で
`4200000000` から採番した固定計画を `.receipt-id-backfill-manifest.json` へ保存する。
このファイルには品名と dry-run 時点の金額が入るため Git には追加しない。
既存ファイルは誤って rollback の対応表を失わないよう上書きしない。

確認項目:

- 合計 1,140 件（payment 1,080 / income 60）
- transfer が 0 件
- `receipt_id` が 4,200,000,000〜4,200,001,139 の連番
- 対象の ID・日付・金額・品名に不審なものがない

### 2. canary

```bash
bun run receipt-id:backfill -- --canary
```

先頭の未適用 1 件だけを計画値へ更新し、Zaim API から全列を取り直して
`receipt_id` 以外が変わっていないことを確認した後、`receipt_id = 0` へ戻す。
復元後も全列を再取得して元の状態との一致を確認する。ここで失敗したら本実行しない。

### 3. 本実行

```bash
bun run receipt-id:backfill -- --apply
```

固定計画と Zaim API の現在値を照合してから 1 件ずつ更新する。`amount` は manifest の値を
使わず、**実行直前に Zaim API から取り直した値**を必ず同送する。成功した ID は
`.receipt-id-backfill-progress.jsonl` へ追記する。途中で失敗した場合は同じコマンドを
再実行すれば、API 上で計画値が付いている明細を飛ばして残りから再開する。

本実行後は次の順で確認する。

```bash
bun run sync
```

1. 本番 D1 で対象 1,140 件すべてに計画値が反映されたことを確認する
2. ZaimViewer の API で対象件数と `receipt_id` を確認する
3. iPhone の Zaim で支出・収入から数件ずつ開き、品名欄の表示と編集を目視確認する

### 緊急時の rollback

```bash
bun run receipt-id:backfill -- --rollback
```

同じ固定計画を使い、計画値が付いた明細だけを `receipt_id = 0` へ戻す。
計画外の値は上書きしない。rollback でも金額は Zaim API の最新値を同送し、成功を
同じ処理済みログへ追記する。完了後は `bun run sync` でミラーを追随させる。
