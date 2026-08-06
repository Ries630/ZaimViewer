"""Zaim REST API v2 のクライアント（OAuth1.0a 認証）。"""

import time
from collections.abc import Iterator
from typing import Any

from requests_oauthlib import OAuth1Session

from zaimviewer.config import Settings

BASE_URL = "https://api.zaim.net/v2"

# ページング 1 回あたりの取得件数（API 上限）
PAGE_LIMIT = 100

# 連続リクエスト間の待機秒数（レート制限への配慮）
REQUEST_INTERVAL = 0.3


class ZaimClient:
    """Zaim API v2 を呼び出すクライアント。

    読み取り系（明細・マスタ取得）のみを持つ。更新系は編集プロキシ実装時に追加する。
    """

    def __init__(self, settings: Settings) -> None:
        """認証情報から OAuth1 セッションを構築する。

        Args:
            settings: Zaim API の認証情報を含む設定。
        """
        self._session = OAuth1Session(
            settings.consumer_key,
            client_secret=settings.consumer_secret,
            resource_owner_key=settings.access_token,
            resource_owner_secret=settings.access_token_secret,
        )

    def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """GET リクエストを送り JSON を返す。

        Args:
            path: BASE_URL からの相対パス（先頭 / 付き）。
            params: クエリパラメータ。

        Returns:
            レスポンス JSON。

        Raises:
            RuntimeError: HTTP ステータスが 200 以外の場合。
        """
        res = self._session.get(BASE_URL + path, params=params or {})
        if res.status_code != 200:
            raise RuntimeError(f"Zaim API error {res.status_code}: {res.text[:500]}")
        return res.json()

    def verify(self) -> dict[str, Any]:
        """認証確認とユーザー情報の取得。"""
        return self._get("/home/user/verify")["me"]

    def categories(self) -> list[dict[str, Any]]:
        """ユーザーのカテゴリ一覧を取得する。"""
        return self._get("/home/category", {"mapping": 1})["categories"]

    def genres(self) -> list[dict[str, Any]]:
        """ユーザーのジャンル（カテゴリ内訳）一覧を取得する。"""
        return self._get("/home/genre", {"mapping": 1})["genres"]

    def accounts(self) -> list[dict[str, Any]]:
        """ユーザーの口座一覧を取得する。"""
        return self._get("/home/account", {"mapping": 1})["accounts"]

    def iter_money(self) -> Iterator[list[dict[str, Any]]]:
        """全明細をページ単位で順に返す。

        日付フィルタを付けず全期間を新しい順に走査する。
        呼び出し側はページ（最大 PAGE_LIMIT 件のリスト）ごとに処理する。

        Yields:
            明細 dict のリスト（1 ページ分）。
        """
        page = 1
        while True:
            data = self._get(
                "/home/money",
                {"mapping": 1, "limit": PAGE_LIMIT, "page": page},
            )
            chunk = data["money"]
            if not chunk:
                return
            yield chunk
            if len(chunk) < PAGE_LIMIT:
                return
            page += 1
            time.sleep(REQUEST_INTERVAL)
