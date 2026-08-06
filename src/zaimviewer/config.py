"""環境変数（.env）から設定を読み込む。"""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# プロジェクトルート（src/zaimviewer/ の 2 つ上）
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


@dataclass(frozen=True)
class Settings:
    """Zaim API 認証情報とデータ配置の設定。

    Attributes:
        consumer_key: Zaim アプリの Consumer Key。
        consumer_secret: Zaim アプリの Consumer Secret。
        access_token: ユーザーの Access Token。
        access_token_secret: ユーザーの Access Token Secret。
        db_path: ミラー SQLite ファイルの配置先。
    """

    consumer_key: str
    consumer_secret: str
    access_token: str
    access_token_secret: str
    db_path: Path


def resolve_db_path() -> Path:
    """ミラー DB の配置先だけを解決する。

    読み取り API は Zaim の認証情報を必要としないため、
    load_settings() を呼ばずに DB パスだけを得られるようにしている。

    Returns:
        ミラー SQLite ファイルのパス。
    """
    load_dotenv(PROJECT_ROOT / ".env")
    return Path(os.environ.get("ZAIMVIEWER_DB", PROJECT_ROOT / "data" / "zaim.db"))


def load_settings() -> Settings:
    """.env と環境変数から設定を構築する。

    Returns:
        検証済みの Settings。

    Raises:
        RuntimeError: 必須の認証情報が欠けている場合。
    """
    load_dotenv(PROJECT_ROOT / ".env")

    values = {}
    for key in (
        "ZAIM_CONSUMER_KEY",
        "ZAIM_CONSUMER_SECRET",
        "ZAIM_ACCESS_TOKEN",
        "ZAIM_ACCESS_TOKEN_SECRET",
    ):
        value = os.environ.get(key, "")
        if not value:
            raise RuntimeError(f"環境変数 {key} が未設定です（.env を確認）")
        values[key] = value

    db_path = resolve_db_path()
    return Settings(
        consumer_key=values["ZAIM_CONSUMER_KEY"],
        consumer_secret=values["ZAIM_CONSUMER_SECRET"],
        access_token=values["ZAIM_ACCESS_TOKEN"],
        access_token_secret=values["ZAIM_ACCESS_TOKEN_SECRET"],
        db_path=db_path,
    )
