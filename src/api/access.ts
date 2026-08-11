/**
 * Cloudflare Access のセッション切れを扱う `fetch` ラッパ。
 *
 * セッションが切れた状態で `/api/*` を叩くと、返るのは JSON ではなく
 * Access のログインへの 302 になる。リダイレクト先は
 * `rieslab.cloudflareaccess.com` という別オリジンなので、ブラウザが素直に
 * 追うと CORS に阻まれ、`fetch` は `TypeError` で落ちる。ステータスコードすら
 * 読めないため、そのままでは「原因不明の通信エラー」としか見えない。
 *
 * ホーム画面から起動した PWA では、これがアプリが黙って壊れたように見える形で
 * 出る。ブラウザタブなら再読み込みでログイン画面に飛べるが、standalone 表示では
 * 戻る手段が乏しい。そこで、リダイレクトを追わずに自分で検出し、
 * トップレベルの画面遷移に切り替える。
 */

/**
 * Access のセッションが切れていたことを表すエラー。
 *
 * これが投げられた時点で画面遷移を予約済みなので、呼び出し側は
 * リトライせず、握りつぶしてよい。
 */
export class SessionExpiredError extends Error {
  constructor() {
    super("Cloudflare Access のセッションが切れている");
    this.name = "SessionExpiredError";
  }
}

/**
 * ログインへの遷移を予約済みか。
 *
 * 遷移が始まってもページはすぐには消えず、走っている fetch は順に失敗する。
 * 都度 `location.reload()` を呼ぶと遷移が積み重なるので 1 回に抑える。
 */
let navigating = false;

/**
 * レスポンスが「追わなかったリダイレクト」かどうか。
 *
 * `redirect: "manual"` を指定すると、リダイレクトは追われず不透明な
 * レスポンスとして返る。中身もステータスも読めないので、判定材料は
 * `type` だけになる（`status` は 0）。
 *
 * @param res 判定するレスポンス。
 * @returns リダイレクトを止めた結果なら true。
 */
function isOpaqueRedirect(res: Response): boolean {
  return res.type === "opaqueredirect";
}

/**
 * Access のログインをブラウザに踏ませる。
 *
 * `fetch` のリトライでは解決しない。トップレベルの画面遷移なら CORS の
 * 制約を受けずにリダイレクトを追えるので、Access のログインに到達できる。
 */
function navigateToLogin(): void {
  if (navigating) return;
  navigating = true;
  location.reload();
}

/**
 * Access のセッション切れを検出する `fetch`。
 *
 * 検出したら画面遷移を起こしたうえで {@link SessionExpiredError} を投げる。
 * 正常時は素の `fetch` と同じレスポンスを返す。
 *
 * @param input 取得先。
 * @param init `fetch` に渡す設定。`redirect` はここで上書きする。
 * @returns レスポンス。
 * @throws {SessionExpiredError} Access のセッションが切れているとき。
 */
export async function accessAwareFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, { ...init, redirect: "manual" });
  if (isOpaqueRedirect(res)) {
    navigateToLogin();
    throw new SessionExpiredError();
  }
  return res;
}
