/**
 * Issue #37 の支出 receipt_id 後付けと収入の補正を手元から安全に実行する。
 *
 * dry-run・canary・本実行・rollback の順序と確認事項の正は `ops/README.md` を参照。
 */

import { appendFile, chmod, writeFile } from "node:fs/promises";

import {
  createReceiptIdBackfillManifest,
  parseReceiptIdBackfillManifest,
  type ReceiptIdBackfillManifest,
} from "../src/receipt-id-backfill";
import {
  applyReceiptIdBackfill,
  fetchAllMoney,
  rollbackIncomeReceiptIdBackfill,
  rollbackReceiptIdBackfill,
  runReceiptIdBackfillCanary,
  type ReceiptIdBackfillUpdateEvent,
} from "../src/receipt-id-backfill-runner";
import { ZaimClient } from "../src/zaim";

/** 既定の固定計画ファイル。Git の追跡対象外。 */
const DEFAULT_MANIFEST_PATH = ".receipt-id-backfill-manifest.json";

/** 既定の処理済みログ。Git の追跡対象外。 */
const DEFAULT_PROGRESS_PATH = ".receipt-id-backfill-progress.jsonl";

/** CLI が受け付ける操作。 */
type Command = "dry-run" | "canary" | "apply" | "rollback-income" | "rollback";

/** 解釈済みの CLI 引数。 */
interface CliOptions {
  /** 実行する操作。 */
  command: Command;
  /** dry-run で作り、変更系で読む固定計画。 */
  manifestPath: string;
  /** 本実行と rollback の成功記録。 */
  progressPath: string;
}

/**
 * 必須の環境変数を読む。
 *
 * @param name 環境変数名。
 * @returns 設定済みの値。
 * @throws 未設定または空文字の場合。
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が未設定（.dev.vars を確認）`);
  return value;
}

/**
 * CLI の使い方を返す。
 *
 * @returns 標準出力へ表示する説明。
 */
function usage(): string {
  return `使い方:
  bun run receipt-id:backfill                         # dry-run
  bun run receipt-id:backfill -- --canary
  bun run receipt-id:backfill -- --apply
  bun run receipt-id:backfill -- --rollback-income
  bun run receipt-id:backfill -- --rollback

オプション:
  --manifest <path>      固定計画（既定: ${DEFAULT_MANIFEST_PATH}）
  --progress-log <path>  処理済みログ（既定: ${DEFAULT_PROGRESS_PATH}）`;
}

/**
 * CLI 引数を解釈する。
 *
 * @param args process.argv のスクリプト名より後ろ。
 * @returns 操作とファイルパス。
 * @throws 未知の引数、操作の重複、パスの欠落がある場合。
 */
function parseArgs(args: readonly string[]): CliOptions {
  let command: Command = "dry-run";
  let explicitCommand = false;
  let manifestPath = DEFAULT_MANIFEST_PATH;
  let progressPath = DEFAULT_PROGRESS_PATH;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (
      ["--dry-run", "--canary", "--apply", "--rollback-income", "--rollback"].includes(argument)
    ) {
      if (explicitCommand) throw new Error("操作は 1 つだけ指定する");
      if (argument === "--dry-run") command = "dry-run";
      else if (argument === "--canary") command = "canary";
      else if (argument === "--apply") command = "apply";
      else if (argument === "--rollback-income") command = "rollback-income";
      else command = "rollback";
      explicitCommand = true;
      continue;
    }
    if (argument === "--manifest" || argument === "--progress-log") {
      const path = args[index + 1];
      if (!path || path.startsWith("--")) throw new Error(`${argument} のパスがない`);
      if (argument === "--manifest") manifestPath = path;
      else progressPath = path;
      index += 1;
      continue;
    }
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`未知の引数: ${argument}`);
  }

  return { command, manifestPath, progressPath };
}

/**
 * Zaim の認証情報を環境変数から読みクライアントを作る。
 *
 * @returns 認証済みリクエストを送るクライアント。
 */
function createClient(): ZaimClient {
  return new ZaimClient({
    consumerKey: requireEnv("ZAIM_CONSUMER_KEY"),
    consumerSecret: requireEnv("ZAIM_CONSUMER_SECRET"),
    accessToken: requireEnv("ZAIM_ACCESS_TOKEN"),
    accessTokenSecret: requireEnv("ZAIM_ACCESS_TOKEN_SECRET"),
  });
}

/**
 * manifest を JSON から読み、形式を検証する。
 *
 * @param path 読み込むファイルパス。
 * @returns 型検証済みの固定計画。
 */
async function readManifest(path: string): Promise<ReceiptIdBackfillManifest> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`manifest がない: ${path}（先に dry-run を実行する）`);
  }
  return parseReceiptIdBackfillManifest(await file.json());
}

/**
 * 品名を dry-run の 1 行表示へ安全に埋め込む。
 *
 * @param value Zaim の品名。
 * @returns タブと改行を空白へ変えた値。
 */
function singleLine(value: string): string {
  return value.replaceAll(/[\t\r\n]/g, " ");
}

/**
 * API を変更せず対象を一覧表示し、以降の操作で使う固定計画を保存する。
 *
 * @param client Zaim API クライアント。
 * @param manifestPath 保存先。
 */
async function dryRun(client: ZaimClient, manifestPath: string): Promise<void> {
  const file = Bun.file(manifestPath);
  if (await file.exists()) {
    throw new Error(
      `manifest は既に存在するため上書きしない: ${manifestPath}（必要なら別パスを指定）`,
    );
  }

  const money = await fetchAllMoney(client);
  const manifest = createReceiptIdBackfillManifest(money, new Date().toISOString());
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  console.log("mode\tid\tdate\tamount\tname\treceipt_id");
  for (const entry of manifest.entries) {
    console.log(
      [
        entry.mode,
        entry.id,
        entry.observedDate,
        entry.observedAmount,
        singleLine(entry.observedName),
        entry.receiptId,
      ].join("\t"),
    );
  }
  console.log(`dry-run 完了: ${manifest.entries.length} 件。固定計画を ${manifestPath} に保存`);
}

/**
 * 成功した更新 1 件を JSON Lines へ追記する。
 *
 * @param path ログファイル。
 * @param event 更新内容。品名・金額・認証情報は含まない。
 */
async function logUpdate(path: string, event: ReceiptIdBackfillUpdateEvent): Promise<void> {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    action: event.action,
    id: event.entry.id,
    mode: event.entry.mode,
    receiptId: event.entry.receiptId,
  });
  await appendFile(path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

/**
 * 指定された操作を 1 回実行する。
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const client = createClient();
  if (options.command === "dry-run") {
    await dryRun(client, options.manifestPath);
    return;
  }

  const manifest = await readManifest(options.manifestPath);
  if (options.command === "canary") {
    const entry = await runReceiptIdBackfillCanary(client, manifest);
    console.log(
      `canary 完了: ${entry.mode} ${entry.id} の receipt_id を ${entry.receiptId} に更新し、0 への復元を確認`,
    );
    return;
  }

  const onUpdated = async (event: ReceiptIdBackfillUpdateEvent): Promise<void> =>
    logUpdate(options.progressPath, event);
  if (options.command === "apply") {
    const result = await applyReceiptIdBackfill(client, manifest, { onUpdated });
    console.log(
      `本実行完了: 新規 ${result.newlyApplied} 件、開始時点で適用済み ${result.alreadyApplied} 件`,
    );
    return;
  }

  if (options.command === "rollback-income") {
    const count = await rollbackIncomeReceiptIdBackfill(client, manifest, { onUpdated });
    console.log(`収入 rollback 完了: ${count} 件を receipt_id 0 に復元`);
    return;
  }

  const count = await rollbackReceiptIdBackfill(client, manifest, { onUpdated });
  console.log(`rollback 完了: ${count} 件を receipt_id 0 に復元`);
}

try {
  await main();
} catch (error) {
  console.error(`[${new Date().toISOString()}] receipt_id 後付け失敗:`, error);
  console.error(usage());
  process.exit(1);
}
