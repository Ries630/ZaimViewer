import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * テストは workerd 上で実行し、D1 も実物（miniflare の SQLite）を使う。
 * SQL の方言差やバインドの挙動をモックで取り違えないため。
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        d1Databases: ["DB"],
      },
    }),
  ],
});
