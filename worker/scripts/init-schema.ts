/**
 * 空のミラー DB を作る SQL を標準出力に書き出す。
 *
 * 初回デプロイ直後は同期がまだ走っておらずテーブルが存在しないため、
 * 読み取り API が「no such table」で 500 を返す。それを避けるために、
 * デプロイ前に空のテーブルとインデックスだけ作っておく。
 *
 * SQL を手で書き起こさず `sync.ts` の DDL をそのまま使うのは、
 * スキーマの写しをこれ以上増やさないため。同期本体が作る形と
 * 必ず一致するので、初期化した DB は 1 回目の同期でそのまま差し替わる。
 *
 * 使い方は `package.json` の `db:init` を参照。
 */

import { swapSql, workTableDdl } from "../src/sync";

// workTableDdl() が `*_new` を作り、swapSql() が本来の名前へ改名してインデックスを張る。
// 空の DB に対して通すと、行が 0 件のミラーがそのまま出来上がる。
console.log([...workTableDdl(), ...swapSql()].join(";\n") + ";");
