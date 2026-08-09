# ADR-0006: Zaim API は OAuth1.0a で直叩きし、署名は自前実装する

- ステータス: 承認済み
- 日付: 2026-08-06
- 関連: `e8bcd61`、`11ba2a6`、`07d53f1`、`worker/src/oauth1.ts`

## 背景

Zaim API は OAuth1.0a（HMAC-SHA1）で署名する。認証情報は既に `~/.claude.json` の
`mcpServers.zaim-api` に設定済みで、MCP サーバ経由でも叩ける状態だった。

一方で、この署名の実装には既知の落とし穴がある。パーセントエンコーディングの
対象文字（`!*'()` を含むか）、日本語のエンコード順序、POST フォームボディを
署名ベース文字列に含める扱い。ここを間違えると認証エラーになるが、
**間違いはサーバ側の 401 としてしか現れず、どこが違うのか分からない**。

## 決定

Zaim API は OAuth1.0a で直接叩く。MCP サーバには依存しない。
署名は外部ライブラリを使わず、Web Crypto（`crypto.subtle`）だけで自前実装する
（`worker/src/oauth1.ts`）。

正しさは、Python の `oauthlib` 3.3.1 で生成した固定ベクタとの一致で担保する
（`worker/test/oauth1.test.ts`、記号 `!*'()`・日本語・POST フォームボディを含む 4 ケース）。

## 検討した代替

- **MCP サーバ（`zaim-api`）を同期にも使う** — 同期は 44 リクエストを連続で投げる
  バッチ処理で、MCP は対話的なツール呼び出し用。コンテナが動いていることが
  同期の前提になり、定期実行の依存が増える
- **`oauth-1.0a` パッケージ** — 同期 API 前提の設計で、コールバックに
  ハッシュ関数を渡す形になっている。Web Crypto の `crypto.subtle` は非同期なので
  噛み合わない。Node の `crypto` を使うなら Workers で `nodejs_compat` フラグが要る
- **`oauthlib`（Python 期）** — Python 実装ではこれで動いていたが、
  [ADR-0009](0009-migrate-to-workers.md) の移植先には存在しない

## 結果

- 依存が 1 つも増えない。Workers で `nodejs_compat` フラグが不要
- 署名の正しさを自分で保証する義務を負う。固定ベクタのテストがその代金
- POST + フォームボディまで検証済みなので、工程 ③ の更新系
  （[ADR-0003](0003-edit-through-zaim-api.md)、[#6](https://github.com/Ries630/ZaimViewer/issues/6)）は
  `ZaimClient` にメソッドを足すだけで始められる。署名の作り直しは要らない
