# ADR-0025: 日付演算に Temporal を使い、表示の整形は Intl.DateTimeFormat のまま残す

- ステータス: 承認済み
- 日付: 2026-08-13
- 関連: [#15](https://github.com/Ries630/ZaimViewer/issues/15)（採否の判断をここで行うと #14 完了時に決めた）

## 背景

#14 の完了後に Temporal の採用可否を調べ、判断は #15 まで持ち越した。#14 時点の
`Date` の利用は `src/lib/format.ts` の 5 関数・約 40 行で、得られるのは主に書き味の
改善だったのに対し、#15 の期間フィルタでは月の加減算が要るため。

### 対応状況（2026-08-12 時点、実測 + caniuse）

| 環境 | ネイティブ Temporal |
|---|---|
| **iOS Safari（主な入口）** | **非対応**（26.5 まで） |
| デスクトップ Safari | 非対応（27 まで。Technology Preview でも既定オフ） |
| Chrome | 対応（144 以降。手元の 151 で確認） |
| Firefox | 対応（139 以降） |
| **workerd（テストの実行環境）** | **非対応**（実測） |
| Bun（`worker/scripts/`） | 非対応（実測） |
| TypeScript 7 の型 | あり（`lib.esnext.temporal.d.ts`） |

主な入口の iPhone が非対応なので、**polyfill は保険ではなく本番の実行経路になる。**
「いずれ polyfill を落とせる」という通常の利点は、Safari が対応するまで回収できない。

### polyfill の比較

| | temporal-polyfill | temporal-polyfill-lite | @js-temporal/polyfill |
|---|---|---|---|
| 版 | **1.0.3** | 0.4.2 | 0.5.1 |
| 初公開 | 2021-05 | 2026-01-25 | - |
| 最終公開 | 2026-08-03 | 2026-06-28 | 2025-03-31 |
| commit 数 | 2,617 | 475 | - |
| min+gzip（esbuild で実測） | 19.3 KB | 17.9 KB | 45.8 KB |
| API 表面 vs ネイティブ Chrome 151 | 完全一致 | 完全一致 | 未計測 |
| 日付演算 vs ネイティブ（11 項目） | 完全一致 | 完全一致 | 未計測 |

### バンドルへの影響（この構成での実測）

`vite build` の client 成果物（`main` = fe72cc6 との比較）。

| | raw | gzip |
|---|---|---|
| main | 237.47 kB | 74.91 kB |
| フィルタパネルのみ（polyfill を外して同じコードをビルド） | 252.85 kB | 79.31 kB |
| **フィルタパネル + polyfill** | **309.23 kB** | **99.17 kB** |

polyfill 単体で **+56.38 kB raw / +19.86 kB gzip**。main 比で gzip +26.5%。

### 踏むと分かっていた落とし穴

**`new Intl.DateTimeFormat(...).format(temporalObject)` は polyfill では TypeError に
なる**（ネイティブは動く）。`format.ts` はフォーマッタをモジュール定数でキャッシュして
`.format(date)` を呼ぶ形で、一覧が数千行を描くのでキャッシュは意図的なもの
（[ADR-0021](0021-no-list-virtualization.md) で仮想化しないと決めているため、
描画コストは行数にそのまま比例する）。Temporal に移すと `plainDate.toLocaleString(...)`
に変わり、(1) キャッシュが効かなくなる、(2) 出力が変わる（同じオプションで polyfill は
`2026年8月8日(土)`、ネイティブ Chrome は `2026/8/8(土)`）。

## 決定

**日付演算にだけ Temporal を使い、適用範囲を `src/lib/period.ts` に閉じる。**
表示の整形は `src/lib/format.ts` の `Date` + `Intl.DateTimeFormat` のまま残す。
polyfill は `temporal-polyfill` 1.0.3 を明示 import し、ネイティブ実装は使わない。

`Temporal` 型はモジュールの外へ出さない。`period.ts` の入出力はどちらも
`YYYY-MM-DD` の文字列で、呼び出し側は Temporal を知らずに済む。

## 検討した代替

- **全面採用（`format.ts` も Temporal に載せ替える）** — 書き味は最良。落としたのは
  上記の落とし穴 2 点をそのまま踏むため。フォーマッタのキャッシュが効かなくなるのは
  仮想化していない一覧に直接効き、出力の変化は「将来 Safari が対応して polyfill を
  外したときにもう一度変わる」という形で二度払いになる
- **不採用（`Date` のままにする）** — 19.86 kB を払わずに済む。落としたのは
  「過去 3 か月」が相対期間だから。`Temporal.PlainDate.subtract({ months: 3 })` は
  5/31 → 2/28 に丸める（既定の `constrain`）が、`new Date(y, m - 1, d)` 系は
  3/3 に繰り上がり、期間が 3 か月より短くなる。暦月の区切り（今月・先月・今年）だけなら
  `day: 1` 固定と「翌月 1 日 - 1 日」で安全に書けるので、この 1 つが決め手になった
- **`temporal-polyfill-lite`** — 1.4 KB（7%）小さい。落としたのは 0.x・公開 6.5 か月の
  パッケージを長期依存に置く理由として弱いため。API 表面が一致しているので、
  必要になれば import の書き換えだけで乗り換えられる
- **`@js-temporal/polyfill`** — 45.8 KB で 2.4 倍。最終公開も 2025-03 で止まっている

## 結果

- **日付の表現が 2 つ混在する。** 演算は `Temporal.PlainDate`、整形は `Date`。境界が
  `period.ts` の入出力（`YYYY-MM-DD` の文字列）にあることを知らないと、
  どちらで書くべきか迷う場所が増えた
- **gzip 19.86 kB が iOS Safari の対応まで永久に乗る。** 74.91 → 99.17 kB のうち
  polyfill が 19.86 kB。ネイティブが使える Chrome でも polyfill を通る
- **`format.ts` の書き味は改善しない。** Temporal を入れたのに、`Date` を触る
  5 関数はそのまま残る
- **`format.ts` を Temporal に移す道は事実上塞がった。** 移した時点で出力が変わるので、
  移すなら表示の変更として別に判断することになる

## 再評価のサイン

- **iOS Safari が Temporal に対応したとき。** polyfill を落とせるかを検討する。
  ただし明示 import をやめると Chrome と polyfill で `toLocaleString` の出力が
  食い違うので、`format.ts` を移していないうちは影響が無いことも確認する
- **日付演算が `period.ts` の外に出たくなったとき。** 適用範囲を閉じた前提が崩れる
- **一覧の描画が重くなったとき。** フォーマッタのキャッシュを守るために整形を
  `Intl` に残した判断が、そもそも効いていたかを測り直す
