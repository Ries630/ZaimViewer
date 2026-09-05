/** Worker の環境バインディングと認証情報への変換。 */
import type { AccessEnv } from "./access";
import type { EditEnvironment } from "./edit-config";
import type { OAuth1Credentials } from "./oauth1";

/** ルートとテストが共有する Worker 環境の境界。 */
export interface Env extends AccessEnv, EditEnvironment {
  DB: D1Database;
  ZAIM_CONSUMER_KEY: string;
  ZAIM_CONSUMER_SECRET: string;
  ZAIM_ACCESS_TOKEN: string;
  ZAIM_ACCESS_TOKEN_SECRET: string;
}

/**
 * 環境変数から OAuth1.0a 認証情報を組み立てる。
 * @param env Worker の環境バインディング。
 * @returns 署名に使う認証情報。
 */
export function credentialsOf(env: Env): OAuth1Credentials {
  return {
    consumerKey: env.ZAIM_CONSUMER_KEY,
    consumerSecret: env.ZAIM_CONSUMER_SECRET,
    accessToken: env.ZAIM_ACCESS_TOKEN,
    accessTokenSecret: env.ZAIM_ACCESS_TOKEN_SECRET,
  };
}
