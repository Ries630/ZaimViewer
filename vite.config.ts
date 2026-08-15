import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

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
  plugins: [
    react(),
    tailwindcss(),
    cloudflare(),
    VitePWA({
      // 新しいビルドを見つけたら黙って入れ替える。1 人用のアプリなので
      // 「更新があります」の確認 UI は持たない
      registerType: "autoUpdate",
      // 登録スクリプトを index.html に直接埋める。別ファイルにすると
      // 起動のたびに 1 リクエスト増える
      injectRegister: "inline",
      // マニフェストの取得に Cookie を付けさせる（link に
      // crossorigin="use-credentials" が入る）。これが無いと Access 配下では
      // 資格情報なしで取りに行って 302 → 別オリジン → CORS で必ず失敗する
      useCredentials: true,
      manifest: {
        id: "/",
        name: "ZaimViewer",
        short_name: "ZaimViewer",
        description: "Zaim の明細をフィルタして読む",
        lang: "ja",
        start_url: "/",
        scope: "/",
        display: "standalone",
        // 起動時のスプラッシュの地色。アイコンが緑なので、地色を緑にすると
        // アイコンが背景に溶ける。メディアクエリは書けないので白で固定する
        background_color: "#ffffff",
        // 端末のテーマに合わせる指定は index.html の meta が持つ。
        // マニフェストは 1 色しか書けないので light 側の base-100 を置く
        theme_color: "#ffffff",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // precache するのはハッシュ付きのアセットだけ。index.html を入れても
        // ナビゲーションには使われず（下記）、キャッシュに死蔵されるだけになる。
        // アイコンとマニフェストはプラグインが別途足すので、ここで png を
        // 拾うと同じ URL が 2 回並ぶ
        globPatterns: ["**/*.{js,css}"],
        // registerType: "autoUpdate" がこの 2 つを立てるのは
        // injectRegister が "auto" のときだけで、上で "inline" にしている
        // 今の設定では自分で書く必要がある。無いと新しい Service Worker が
        // waiting のまま留まり、ホーム画面から起動しっぱなしの PWA では
        // 古い JS がいつまでも使われる
        skipWaiting: true,
        clientsClaim: true,
        // **ここがこの設定の要**。既定では navigateFallback が "index.html" で、
        // ナビゲーションに precache した HTML を返す。それをやると Access の
        // セッションが切れたときに `location.reload()`（src/api/access.ts）が
        // ネットワークに出ず、302 を踏めないまま同じシェルが返り続ける
        // ＝「reload → API 失敗 → reload」の無限ループになる。
        // undefined にするとナビゲーションは Service Worker を通らず、
        // Access の挙動は SW を入れる前と完全に同じになる（ADR-0028）
        navigateFallback: undefined,
        // runtimeCaching は置かない。/api/* も SW を通らないので、
        // src/api/access.ts の redirect: "manual" による opaqueredirect 判定が
        // そのまま効く
      },
    }),
  ],
});
