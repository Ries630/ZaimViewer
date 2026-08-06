"""Zaim の全データを SQLite に同期する。

一時ファイルに全件を構築し、整合性チェック後にアトミックな rename で
本体ファイルを差し替える。読み手（FastAPI / Grafana）とのロック競合を
構造的に避けるための方式。
"""

import json
import os
import sqlite3
import sys
from datetime import UTC, datetime
from importlib import resources
from typing import Any

from zaimviewer.config import load_settings
from zaimviewer.zaim_client import ZaimClient


def _insert_master(
    db: sqlite3.Connection, table: str, columns: list[str], rows: list[dict[str, Any]]
) -> None:
    """マスタテーブルへ一括 INSERT する。

    Args:
        db: 構築中の SQLite 接続。
        table: テーブル名。
        columns: raw 以外の列名（API レスポンスのキーと一致させる）。
        rows: API から取得した dict のリスト。
    """
    placeholders = ", ".join(["?"] * (len(columns) + 1))
    sql = f"INSERT INTO {table} ({', '.join(columns)}, raw) VALUES ({placeholders})"
    db.executemany(
        sql,
        [
            [row.get(col) for col in columns] + [json.dumps(row, ensure_ascii=False)]
            for row in rows
        ],
    )


def build_database(tmp_path: str) -> dict[str, int]:
    """Zaim API から全件取得し、一時ファイルに DB を構築する。

    Args:
        tmp_path: 構築先の一時ファイルパス。

    Returns:
        テーブル名 -> 件数 の dict（ログ用）。
    """
    settings = load_settings()
    client = ZaimClient(settings)

    # 認証確認（失敗時はここで止まり、既存 DB は無傷のまま残る）
    me = client.verify()
    print(f"認証OK: user={me.get('name')} (id={me.get('id')})")

    db = sqlite3.connect(tmp_path)
    schema = resources.files("zaimviewer").joinpath("schema.sql").read_text()
    db.executescript(schema)

    # マスタ同期
    counts: dict[str, int] = {}
    for table, columns, rows in (
        ("categories", ["id", "mode", "name", "sort", "active"], client.categories()),
        ("genres", ["id", "category_id", "name", "sort", "active"], client.genres()),
        ("accounts", ["id", "name", "sort", "active"], client.accounts()),
    ):
        _insert_master(db, table, columns, rows)
        counts[table] = len(rows)
        print(f"{table}: {len(rows)} 件")

    # 明細同期（全期間をページ走査）
    tx_columns = [
        "id", "mode", "date", "amount", "category_id", "genre_id",
        "from_account_id", "to_account_id", "name", "place", "comment",
        "currency_code", "receipt_id", "active", "created",
    ]
    total = 0
    for page_num, chunk in enumerate(client.iter_money(), start=1):
        _insert_master(db, "transactions", tx_columns, chunk)
        total += len(chunk)
        print(f"transactions: page {page_num} (+{len(chunk)}, 計 {total})")
    counts["transactions"] = total

    # 同期メタ情報
    db.executemany(
        "INSERT INTO sync_meta (key, value) VALUES (?, ?)",
        [
            ("synced_at", datetime.now(UTC).isoformat()),
            ("counts", json.dumps(counts)),
        ],
    )
    db.commit()

    # 整合性チェック（壊れた DB で本体を差し替えないための関門）
    result = db.execute("PRAGMA integrity_check").fetchone()[0]
    db.close()
    if result != "ok":
        raise RuntimeError(f"integrity_check 失敗: {result}")
    if total == 0:
        raise RuntimeError("明細が 0 件。API 異常の可能性があるため差し替えを中止")
    return counts


def main() -> None:
    """同期を実行し、成功時のみ本体 DB をアトミックに差し替える。"""
    settings = load_settings()
    db_path = settings.db_path
    db_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = str(db_path) + ".tmp"

    try:
        counts = build_database(tmp_path)
        # アトミック差し替え。読み手は常に完全な DB だけを見る
        os.replace(tmp_path, db_path)
    finally:
        # 失敗時に一時ファイルを残さない
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    print(f"同期完了: {db_path} ({counts})")


if __name__ == "__main__":
    sys.exit(main())
