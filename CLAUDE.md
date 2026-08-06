# ZaimViewer

Zaim のフィルタ機能が弱く、自動連携の細かな履歴や振替に重要な入出金が埋もれる。
その問題を「閲覧層の自作」で解決するプロジェクト。iPhone からの利用が主。

## 構成

```
Zaim API ──同期(Python)──▶ SQLite (data/zaim.db) ◀──read── FastAPI ──▶ PWA (React+Vite)
                                    ▲                        │
                                    │              編集プロキシ (OAuth1.0a 署名)
                              Grafana (:3080)               │
                              集計・推移                 Zaim 更新 API
```

iPhone からは Tailscale 経由で自宅の Mac mini に接続する。
インターネットに公開せず、認証を自作しないで済ませるため（家計データのため安全側に倒す）。

## 現在地（2026-08-06）

**工程 ① 同期基盤: 完了。** Zaim 全件 4,362 件（payment 3,266 / income 607 /
transfer 489、2014-02〜2029-12。未来分は繰り返し登録の家賃）を
`data/zaim.db` にミラー済み。マスタは categories 46 / genres 129 / accounts 36。

**工程 ② FastAPI + 最小 PWA: 次はここから。** 明細一覧と、下記フィルタまでを作る。

- 振替の除外（`mode != 'transfer'`）
- 自動連携の細かいノイズの除外（口座・カテゴリ・金額での絞り込み）
- 期間・カテゴリでの絞り込み

**工程 ③ 編集機能: 未着手。** 単体編集 → フィルタ結果への一括編集。
いずれも Zaim 更新 API へ順次反映する。

## 設計上の決定と理由

**ローカル独自データを一切持たない。** 重要フラグやメモのようなカラムは作らない。
除外したい明細（振替・自動連携ノイズ）は行ごとのフラグではなくクエリのルールで表現する。
ルールは今後増える明細にも自動で効くが、フラグは新しい明細のたび付け続ける必要があり、
「入力時に選別する」旧運用に逆戻りしてしまうため。

結果としてこの DB は**使い捨てのミラー**になる。壊れたら再同期すればよく、
バックアップも移行も不要。Zaim が唯一の正。

**編集は必ず Zaim 更新 API を経由する。** ミラーを直接書き換えても Zaim に届かず、
次の同期で黙って消える。OAuth1.0a の署名鍵はブラウザに置けないため、
FastAPI 側に編集プロキシを立て、PWA はそこを叩く。

**同期はアトミック差し替え方式。** 一時ファイルに全件構築 → `integrity_check` と
0 件チェック → `os.replace` で差し替える。読み手（FastAPI / Grafana）は常に
完全な DB だけを見る。認証失敗や API 異常時は既存 DB が無傷で残る。

**SQLite を選んだ理由。** 当初は PostgreSQL 前提だったが、Directus 落選・
Grafana が同一ホスト・独自データなし（移行 = 再同期）で PG の根拠が全て消えた。
読み手が同一ホストの 2 プロセスだけなら SQLite で十分。

**汎用ツール（Directus / NocoDB / Metabase）は不採用。** 編集プロキシとして
バックエンドが必須になった時点で、それらの主価値だった「API 自動生成」が仕事を失った。

## 開発

```bash
uv sync
uv run zaim-sync    # Zaim から全件同期（約 1 分、44 リクエスト）
```

`.env` に Zaim の OAuth1.0a 認証情報が必要（`.env.example` 参照）。
値は `~/.claude.json` の `mcpServers.zaim-api` に設定済みのものと同一。

環境は Python 3.14 + uv。Docker は自宅の Mac mini 上で稼働（wallos, karakeep,
cloudflared, Grafana などが同居）。

## 運用メモ

- 夜間の定期実行（launchd）は未設定。当面は手動実行
- Grafana は同一ホストのコンテナ（:3080）。SQLite を読むには
  `frser-sqlite-datasource` プラグインが必要で、`data/zaim.db` を
  Grafana コンテナに読み取り専用でマウントする。まだ未設定
- このリポジトリは `~/Documents` 配下から移動してきた。iCloud 同期下では
  `.venv` 内の `.pth` に macOS の hidden フラグが付き、Python 3.14 が
  それを黙って無視して `ModuleNotFoundError` になる。移動により解消済み
- Git はユーザー確認なしにコミットしてよい（このリポジトリのコードはユーザーが直接触らないため）。
  ただし GitHub への push やリポジトリ公開は外部への公開にあたるため確認する
- コミットは Conventional Commits、本文は日本語
