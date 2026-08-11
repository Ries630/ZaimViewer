import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * PWA と Worker を単一の dev サーバで動かす。
 *
 * `@cloudflare/vite-plugin` は Worker を workerd 上で走らせるので、D1 も
 * Access の環境変数もローカルで本番と同じ形になる。React の HMR は保たれ、
 * API は同一オリジンで叩ける。Vite を別ポートで立てる構成だと開発中だけ
 * CORS かプロキシ設定が要るので避けている。
 *
 * プラグインはリポジトリルートの `wrangler.jsonc` を入力設定として読み、
 * `vite build` 時に成果物を指す `wrangler.json` を出力する。デプロイと
 * プレビューはその出力の方を使う。
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
});
