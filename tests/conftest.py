"""テスト用のミラー DB とテストクライアントを用意する。"""

import json
import sqlite3
from collections.abc import Iterator
from importlib import resources
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from zaimviewer.api.db import get_connection
from zaimviewer.api.main import app

# 本番のマスタ構成を小さく模した固定データ。
# 実データの特徴（未来日付の家賃、コンビニの少額決済、振替、NULL の place）を
# 意図的に含めてある。フィルタが実運用で効くかをここで検証するため。
CATEGORIES = [
    (101, "payment", "Food", 1),
    (102, "payment", "Home", 2),
    (201, "income", "Salary", 1),
]
GENRES = [
    (1001, 101, "昼食", 1),
    (1002, 101, "カフェ", 2),
    (1003, 102, "Rent", 1),
    (2001, 201, "給与", 1),
]
ACCOUNTS = [
    (11, "みんなの銀行", 1),
    (12, "PayPay残高", 2),
    (13, "現金", 3),
]

# (id, mode, date, amount, category_id, genre_id, from_account_id, to_account_id,
#  name, place, comment)
TRANSACTIONS = [
    (1, "payment", "2026-08-01", 320, 101, 1001, 12, None, "おにぎり", "セブンイレブン", None),
    (2, "payment", "2026-08-01", 150, 101, 1002, 12, None, None, "セブンイレブン", "ついで"),
    (3, "payment", "2026-07-15", 12800, 101, 1001, 11, None, "会食", "焼肉店", None),
    (4, "payment", "2026-07-01", 35000, 102, 1003, 11, None, None, None, None),
    (5, "payment", "2029-12-01", 35000, 102, 1003, 11, None, None, None, None),
    (6, "income", "2026-07-25", 280000, 201, 2001, None, 11, "給料", None, None),
    (7, "transfer", "2026-07-26", 50000, None, None, 11, 12, None, None, None),
    (8, "payment", "2026-06-10", 980, 101, 1002, 13, None, "100%ジュース", "喫茶 _店_", None),
]


def _build_db(path: Path) -> None:
    """schema.sql からテスト用 DB を構築し、固定データを投入する。

    本番と同じ schema.sql を使うことで、スキーマ変更がテストにも反映される。

    Args:
        path: 構築先のファイルパス。
    """
    conn = sqlite3.connect(path)
    conn.executescript(resources.files("zaimviewer").joinpath("schema.sql").read_text())

    def insert(table: str, columns: list[str], rows: list[tuple[Any, ...]]) -> None:
        placeholders = ", ".join(["?"] * (len(columns) + 1))
        sql = f"INSERT INTO {table} ({', '.join(columns)}, raw) VALUES ({placeholders})"
        conn.executemany(sql, [(*row, json.dumps({})) for row in rows])

    insert("categories", ["id", "mode", "name", "sort"], CATEGORIES)
    insert("genres", ["id", "category_id", "name", "sort"], GENRES)
    insert("accounts", ["id", "name", "sort"], ACCOUNTS)
    insert(
        "transactions",
        [
            "id", "mode", "date", "amount", "category_id", "genre_id",
            "from_account_id", "to_account_id", "name", "place", "comment",
        ],
        TRANSACTIONS,
    )
    conn.executemany(
        "INSERT INTO sync_meta (key, value) VALUES (?, ?)",
        [
            ("synced_at", "2026-08-06T09:41:22.566560+00:00"),
            ("counts", json.dumps({"transactions": len(TRANSACTIONS)})),
        ],
    )
    conn.commit()
    conn.close()


@pytest.fixture(scope="session")
def db_path(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """固定データを投入したテスト用 DB のパス。"""
    path = tmp_path_factory.mktemp("zaimviewer") / "zaim.db"
    _build_db(path)
    return path


@pytest.fixture
def conn(db_path: Path) -> Iterator[sqlite3.Connection]:
    """テスト用 DB への読み取り専用接続。

    check_same_thread=False にしているのは、TestClient がリクエストを別スレッドで
    処理するため。本番の接続はリクエストごとに同一スレッドで開くので不要。
    """
    connection = sqlite3.connect(
        f"file:{db_path}?mode=ro", uri=True, check_same_thread=False
    )
    connection.row_factory = sqlite3.Row
    try:
        yield connection
    finally:
        connection.close()


@pytest.fixture
def client(conn: sqlite3.Connection) -> Iterator[TestClient]:
    """テスト用 DB を見る API クライアント。"""
    app.dependency_overrides[get_connection] = lambda: conn
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
