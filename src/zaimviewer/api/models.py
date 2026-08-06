"""API のレスポンススキーマ。"""

from pydantic import BaseModel


class Transaction(BaseModel):
    """明細 1 件。マスタ名と ID の両方を持つ。

    名前は表示用、ID は UI が次のフィルタを組み立てるために使う。
    """

    id: int
    mode: str
    date: str
    amount: int
    category_id: int | None
    category: str | None
    genre_id: int | None
    genre: str | None
    from_account_id: int | None
    from_account: str | None
    to_account_id: int | None
    to_account: str | None
    name: str | None
    place: str | None
    comment: str | None
    currency_code: str | None


class TransactionPage(BaseModel):
    """明細一覧の 1 ページ分。

    Attributes:
        total: フィルタに一致した総件数（ページャ用）。
        total_amount: 一致した明細の金額合計。
        limit: 要求した取得件数。
        offset: スキップした件数。
        items: 明細（日付の新しい順）。
    """

    total: int
    total_amount: int
    limit: int
    offset: int
    items: list[Transaction]


class Category(BaseModel):
    """カテゴリマスタ 1 件。"""

    id: int
    mode: str | None
    name: str | None
    sort: int | None


class Genre(BaseModel):
    """ジャンル（カテゴリ内訳）マスタ 1 件。"""

    id: int
    category_id: int | None
    name: str | None
    sort: int | None


class Account(BaseModel):
    """口座マスタ 1 件。"""

    id: int
    name: str | None
    sort: int | None


class Masters(BaseModel):
    """フィルタ UI の選択肢に使うマスタ一式。

    件数が高々 200 程度なので、起動時に一括で取得して以降は使い回す前提。
    """

    categories: list[Category]
    genres: list[Genre]
    accounts: list[Account]


class Meta(BaseModel):
    """ミラーの鮮度情報。

    Attributes:
        synced_at: 最後に同期した時刻（ISO 8601、UTC）。
        counts: 同期時のテーブル別件数。
    """

    synced_at: str | None
    counts: dict[str, int]
