"""ミラー DB への読み取り専用アクセス。"""

import sqlite3
from collections.abc import Iterator
from pathlib import Path

from zaimviewer.config import resolve_db_path


def connect(db_path: Path | None = None) -> sqlite3.Connection:
    """ミラー DB を読み取り専用で開く。

    `mode=ro` で開くことで、書き込みは SQLite 側で拒否される。
    このプロセスが DB を壊すことは構造的に起こらない。

    Args:
        db_path: 開く DB。省略時は設定から解決する（テストでの差し替え用）。

    Returns:
        row_factory に sqlite3.Row を設定した接続。

    Raises:
        sqlite3.OperationalError: DB ファイルが存在しない場合。
    """
    path = db_path or resolve_db_path()
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def get_connection() -> Iterator[sqlite3.Connection]:
    """FastAPI の依存性注入用。リクエストごとに接続を開いて閉じる。

    接続を使い回さないのは、同期が `os.replace` で DB ファイルを差し替えるため。
    開きっぱなしの接続は差し替え前の古い inode を掴み続け、
    同期しても内容が更新されないように見えてしまう。

    Yields:
        読み取り専用の接続。
    """
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()
