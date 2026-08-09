/**
 * OAuth 1.0a (HMAC-SHA1) の署名生成。RFC 5849 準拠。
 *
 * Workers 上で動かすため Node の crypto ではなく Web Crypto のみを使う。
 * 外部ライブラリに依存しない（oauth-1.0a は同期 API 前提で、
 * 非同期の crypto.subtle と噛み合わないため採用しない）。
 */

/** OAuth1.0a のクライアント認証情報とユーザー認証情報。 */
export interface OAuth1Credentials {
  /** Zaim アプリの Consumer Key。 */
  consumerKey: string;
  /** Zaim アプリの Consumer Secret。 */
  consumerSecret: string;
  /** ユーザーの Access Token。 */
  accessToken: string;
  /** ユーザーの Access Token Secret。 */
  accessTokenSecret: string;
}

/** 署名生成時に固定値を注入するための任意パラメータ（テスト用）。 */
export interface SignOptions {
  /** oauth_nonce。省略時はランダム生成。 */
  nonce?: string;
  /** oauth_timestamp（秒）。省略時は現在時刻。 */
  timestamp?: number;
}

/**
 * RFC 3986 のパーセントエンコード。
 *
 * encodeURIComponent は `!'()*` を非エスケープのまま残すが、
 * RFC 3986 の unreserved 集合は `A-Za-z0-9-._~` のみ。差分を手当てする。
 * ここがずれると署名ベース文字列が変わり、署名だけが静かに不一致になる。
 *
 * @param value エンコード対象の文字列。
 * @returns パーセントエンコード済みの文字列。
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * パラメータを正規化して署名ベース文字列の 3 要素目を組み立てる。
 *
 * 各キー・値をエンコードしたうえで、キー昇順（同一キーなら値昇順）に並べる。
 * 並び順の基準はエンコード後の文字列であってエンコード前ではない。
 *
 * @param params キーと値の組のリスト（同一キーの重複を許すため配列で受ける）。
 * @returns `k=v&k=v` 形式の正規化済みパラメータ文字列。
 */
function normalizeParameters(params: [string, string][]): string {
  return params
    .map(([k, v]): [string, string] => [percentEncode(k), percentEncode(v)])
    .toSorted(([ka, va], [kb, vb]) => (ka < kb ? -1 : ka > kb ? 1 : va < vb ? -1 : va > vb ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/**
 * 署名ベース文字列の 2 要素目となる基底 URL を取り出す。
 *
 * スキームとホストは小文字化し、クエリとフラグメントは除く。
 * 既定ポート（http:80 / https:443）は URL が正規化して落とすため明示的な処理は不要。
 *
 * @param url 対象 URL。
 * @returns クエリを含まない基底 URL。
 */
function baseStringUri(url: URL): string {
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname}`;
}

/**
 * HMAC-SHA1 で署名し Base64 で返す。
 *
 * @param signingKey 署名鍵（`consumerSecret&tokenSecret`）。
 * @param baseString 署名ベース文字列。
 * @returns Base64 エンコードされた署名。
 */
async function hmacSha1Base64(signingKey: string, baseString: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingKey),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(baseString));
  // Uint8Array をスプレッドせず 1 バイトずつ詰む（大きな配列でのスタック溢れを避ける定石）
  let binary = "";
  for (const byte of new Uint8Array(signature)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** 署名生成の中間結果。検証・デバッグのためベース文字列も返す。 */
export interface SignedRequest {
  /** Authorization ヘッダに載せる値。 */
  authorization: string;
  /** 署名ベース文字列（テストと突き合わせ用）。 */
  baseString: string;
  /** Base64 署名（テストと突き合わせ用）。 */
  signature: string;
}

/**
 * リクエストに対する OAuth1.0a 署名を生成する。
 *
 * @param method HTTP メソッド。
 * @param url クエリを含む完全な URL。
 * @param credentials 認証情報。
 * @param bodyParams application/x-www-form-urlencoded のボディパラメータ。
 *   POST 時はこれも署名対象に含める必要がある。
 * @param options nonce / timestamp の固定値（テスト用）。
 * @returns Authorization ヘッダ値と、検証用の中間結果。
 */
export async function signRequest(
  method: string,
  url: string,
  credentials: OAuth1Credentials,
  bodyParams: Record<string, string> = {},
  options: SignOptions = {},
): Promise<SignedRequest> {
  const parsed = new URL(url);
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: options.nonce ?? crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(options.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };

  // 署名対象はクエリ・ボディ・oauth_* の全て
  const params: [string, string][] = [
    ...parsed.searchParams.entries(),
    ...Object.entries(bodyParams),
    ...Object.entries(oauthParams),
  ];

  const baseString = [
    method.toUpperCase(),
    percentEncode(baseStringUri(parsed)),
    percentEncode(normalizeParameters(params)),
  ].join("&");

  const signingKey = `${percentEncode(credentials.consumerSecret)}&${percentEncode(
    credentials.accessTokenSecret,
  )}`;
  const signature = await hmacSha1Base64(signingKey, baseString);

  // Authorization ヘッダには oauth_* のみを載せる（クエリ・ボディは含めない）
  const authorization =
    "OAuth " +
    Object.entries({ ...oauthParams, oauth_signature: signature })
      .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
      .join(", ");

  return { authorization, baseString, signature };
}
