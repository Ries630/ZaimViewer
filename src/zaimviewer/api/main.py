"""ミラー DB を読む FastAPI アプリケーション。

PWA の静的ファイルも同じアプリから配信する。iPhone から Tailscale 経由で
叩く口をひとつにするためで、結果として CORS の設定も不要になる。
"""

import json
import sqlite3
from typing import Annotated

from fastapi import Depends, FastAPI, Query
from fastapi.staticfiles import StaticFiles

from zaimviewer.api import queries
from zaimviewer.api.db import get_connection
from zaimviewer.api.models import Masters, Meta, TransactionPage
from zaimviewer.api.queries import TransactionFilter
from zaimviewer.config import PROJECT_ROOT

# PWA のビルド成果物。存在するときだけ配信する（工程②前半では未生成）
WEB_DIST = PROJECT_ROOT / "web" / "dist"

# 1 リクエストで返す明細の上限。無限スクロール 1 ページ分を想定
DEFAULT_LIMIT = 100
MAX_LIMIT = 1000

# 日付パラメータの書式
DATE_PATTERN = r"^\d{4}-\d{2}-\d{2}$"

app = FastAPI(
    title="ZaimViewer API",
    description="Zaim のミラー DB を読み取り専用で公開する",
    version="0.1.0",
)

Conn = Annotated[sqlite3.Connection, Depends(get_connection)]


@app.get("/api/transactions", response_model=TransactionPage)
def list_transactions(
    conn: Conn,
    date_from: Annotated[str | None, Query(pattern=DATE_PATTERN)] = None,
    date_to: Annotated[str | None, Query(pattern=DATE_PATTERN)] = None,
    mode: Annotated[list[str] | None, Query()] = None,
    category_id: Annotated[list[int] | None, Query()] = None,
    genre_id: Annotated[list[int] | None, Query()] = None,
    account_id: Annotated[list[int] | None, Query()] = None,
    amount_min: Annotated[int | None, Query(ge=0)] = None,
    amount_max: Annotated[int | None, Query(ge=0)] = None,
    q: Annotated[str | None, Query()] = None,
    exclude_place: Annotated[list[str] | None, Query()] = None,
    exclude_genre_id: Annotated[list[int] | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> TransactionPage:
    """明細を日付の新しい順に返す。

    すべてのフィルタは未指定なら条件を課さない。「振替を除外」「今日以前だけ」
    といった既定は API 側に持たせず、呼び出し側が明示する。

    Args:
        conn: 読み取り用の接続。
        date_from: 開始日（この日を含む）。
        date_to: 終了日（この日を含む）。
        mode: 含める mode（payment / income / transfer）。複数指定可。
        category_id: 含めるカテゴリ ID。複数指定可。
        genre_id: 含めるジャンル ID。複数指定可。
        account_id: 含める口座 ID。出金元・入金先のいずれかが一致すれば該当。
        amount_min: 金額の下限。
        amount_max: 金額の上限。
        q: 品名・店舗・メモへの部分一致キーワード。
        exclude_place: 除外する店舗名（完全一致）。複数指定可。
        exclude_genre_id: 除外するジャンル ID。複数指定可。
        limit: 取得件数。
        offset: スキップ件数。

    Returns:
        明細のページと、フィルタ一致の総件数・金額合計。
    """
    filt = TransactionFilter(
        date_from=date_from,
        date_to=date_to,
        modes=tuple(mode or ()),
        category_ids=tuple(category_id or ()),
        genre_ids=tuple(genre_id or ()),
        account_ids=tuple(account_id or ()),
        amount_min=amount_min,
        amount_max=amount_max,
        q=q,
        exclude_places=tuple(exclude_place or ()),
        exclude_genre_ids=tuple(exclude_genre_id or ()),
    )
    total, total_amount = queries.count_transactions(conn, filt)
    items = queries.fetch_transactions(conn, filt, limit=limit, offset=offset)
    return TransactionPage(
        total=total,
        total_amount=total_amount,
        limit=limit,
        offset=offset,
        items=items,
    )


@app.get("/api/masters", response_model=Masters)
def get_masters(conn: Conn) -> Masters:
    """フィルタ UI の選択肢に使うマスタ一式を返す。

    Args:
        conn: 読み取り用の接続。

    Returns:
        カテゴリ・ジャンル・口座の一覧（表示順）。
    """
    return Masters(
        categories=[
            dict(r)
            for r in conn.execute(
                "SELECT id, mode, name, sort FROM categories ORDER BY mode, sort, id"
            )
        ],
        genres=[
            dict(r)
            for r in conn.execute(
                "SELECT id, category_id, name, sort FROM genres ORDER BY category_id, sort, id"
            )
        ],
        accounts=[
            dict(r)
            for r in conn.execute(
                "SELECT id, name, sort FROM accounts ORDER BY sort, id"
            )
        ],
    )


@app.get("/api/meta", response_model=Meta)
def get_meta(conn: Conn) -> Meta:
    """ミラーの同期時刻と件数を返す。UI に鮮度を表示するために使う。

    Args:
        conn: 読み取り用の接続。

    Returns:
        同期時刻とテーブル別件数。
    """
    meta = {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM sync_meta")}
    return Meta(
        synced_at=meta.get("synced_at"),
        counts=json.loads(meta.get("counts") or "{}"),
    )


# PWA の配信。API のルート定義より後に置くことで /api/* が食われないようにする
if WEB_DIST.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")


def run() -> None:
    """開発用サーバを起動する（`uv run zaim-api`）。

    Tailscale 経由で iPhone から届くよう 0.0.0.0 で待ち受ける。
    インターネットには公開せず、Tailnet 内からのみ到達する前提。
    """
    import uvicorn

    uvicorn.run("zaimviewer.api.main:app", host="0.0.0.0", port=8000, reload=True)
