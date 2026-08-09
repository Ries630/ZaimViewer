# ADR-0013: ツールチェーンを TypeScript 7 + oxlint + oxfmt にする

- ステータス: 承認済み
- 日付: 2026-08-07
- 関連: `07d53f1`、`bafc466`

## 背景

[ADR-0009](0009-migrate-to-workers.md) の移植で、型検査・lint・整形を選び直す
必要が生じた。ESLint + Prettier + tsc（JS 実装）が定番だが、この時点で
Go 実装の TypeScript 7 と、Rust 実装の oxlint / oxfmt が揃っていた。

型検査の実測は、同じコードで **0.60 秒 → 0.07 秒**。

lint については、oxlint 単体だと型情報を要するルール（`no-floating-promises` など）が
効かない。`oxlint-tsgolint` を入れると `--type-aware` で有効になる。

## 決定

型検査は TypeScript 7（Go 実装）、lint は oxlint（`--type-aware`、`oxlint-tsgolint` 前提）、
整形は oxfmt。`bun run check` で整形チェック → lint → 型検査 → テストを一括実行する。

パッケージ管理は bun、テストは vitest + `@cloudflare/vitest-pool-workers`
（workerd 上で実物の D1 を使う）。

## 検討した代替

- **Vite+** — Vitest / Rolldown / Oxlint / Oxfmt を束ねた統合層（2026-07 に beta、MIT）。
  中身の oxlint と oxfmt は個別に採用済みなので、得られるのは統合の手間だけ。
  採らないのは、テストが `@cloudflare/vitest-pool-workers` という独自 pool に
  依存していて、`vp test` がこれを通すか未知なため
- **ESLint + Prettier + tsc** — 実績はあるが、速度と、新しい推奨パターンを
  試すという方針で劣る

## 結果

- 型認識 lint が実際に不備を検出した。`oauth1.ts` の二重スプレッド、破壊的な
  `sort`（`toSorted` に変更、これに伴い tsconfig の `lib` を ES2024 へ引き上げ）、
  そして各所の `as Database` が不要だったこと（[ADR-0011](0011-driver-agnostic-db-types.md)）
- oxlint / oxfmt はまだ 1.x で、ルールの網羅性は ESLint に劣る
- bun は peer dependency の解決が緩い。依存を更新するときは注意が要る

## 再評価のサイン

- **Vite+ が 1.0 になり、PWA（[#4](https://github.com/Ries630/ZaimViewer/issues/4)）を
  作る段になったとき。** `vp migrate` を試す価値がある。判断の分かれ目は
  `@cloudflare/vitest-pool-workers` が通るかどうかの 1 点
