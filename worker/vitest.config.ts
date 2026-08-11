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
        // wrangler.jsonc の vars は ENVIRONMENT=production なので、そのままだと
        // Access の JWT 検証が全テストで効いて 403 になる。手元の .dev.vars と
        // 同じく development に倒し、検証そのものは access.test.ts が
        // env を production に切り替えて確かめる
        bindings: { ENVIRONMENT: "development" },
      },
    }),
  ],
});
