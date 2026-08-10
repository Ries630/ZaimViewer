/**
 * 手元（Mac mini）から実行する Zaim → 本番 D1 の全件同期。
 *
 * 同期処理そのものは Worker と同じ `src/sync.ts` を使い、書き込み先だけを
 * D1 の HTTP API に差し替える。Worker 内で動かせない理由は ADR-0015 を参照。
 *
 * 使い方:
 *   bun run sync
 * これは `bun --env-file=.dev.vars run scripts/sync.ts` の別名で、
 * Zaim と Cloudflare の認証情報を `worker/.dev.vars` から読む。
 *
 * 定期実行は launchd に任せる。設定は `ops/README.md` を参照。
 */

import { D1HttpDatabase } from "../src/d1-http";
import { syncAll } from "../src/sync";
import { ZaimClient } from "../src/zaim";

/**
 * 必須の環境変数を読む。
 *
 * 未設定のまま走らせると「認証エラー」など遠い場所で失敗するので、
 * 実行前にまとめて弾く。
 *
 * @param name 環境変数名。
 * @returns 値。
 * @throws 未設定または空文字の場合。
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`環境変数 ${name} が未設定（worker/.dev.vars を確認）`);
  }
  return value;
}

/**
 * 同期を 1 回実行し、結果を標準出力に書く。
 */
async function main(): Promise<void> {
  const db = new D1HttpDatabase({
    accountId: requireEnv("CLOUDFLARE_ACCOUNT_ID"),
    databaseId: requireEnv("D1_DATABASE_ID"),
    apiToken: requireEnv("CLOUDFLARE_API_TOKEN"),
  });
  const client = new ZaimClient({
    consumerKey: requireEnv("ZAIM_CONSUMER_KEY"),
    consumerSecret: requireEnv("ZAIM_CONSUMER_SECRET"),
    accessToken: requireEnv("ZAIM_ACCESS_TOKEN"),
    accessTokenSecret: requireEnv("ZAIM_ACCESS_TOKEN_SECRET"),
  });

  const { counts, syncedAt, timings } = await syncAll(db, client);
  const summary = Object.entries(counts)
    .map(([table, n]) => `${table}=${n}`)
    .join(" ");
  console.log(
    `[${syncedAt}] 同期完了 ${summary} ` +
      `(fetch ${timings.fetchMs}ms / write ${timings.writeMs}ms / swap ${timings.swapMs}ms / ` +
      `total ${timings.totalMs}ms)`,
  );
}

try {
  await main();
} catch (error) {
  // launchd のログに時刻付きで残す。差し替え前に落ちていればミラーは無傷
  console.error(`[${new Date().toISOString()}] 同期失敗:`, error);
  process.exit(1);
}
