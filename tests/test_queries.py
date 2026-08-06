"""フィルタの SQL 変換を検証する。"""

import sqlite3

import pytest

from zaimviewer.api.queries import (
    TransactionFilter,
    count_transactions,
    fetch_transactions,
)


def ids(conn: sqlite3.Connection, filt: TransactionFilter) -> list[int]:
    """フィルタに一致した明細の ID を順序どおりに返す。

    Args:
        conn: 読み取り用の接続。
        filt: 絞り込み条件。

    Returns:
        明細 ID のリスト（日付の新しい順）。
    """
    return [row["id"] for row in fetch_transactions(conn, filt, limit=100, offset=0)]


def test_フィルタ未指定なら全件が日付降順で返る(conn: sqlite3.Connection) -> None:
    # 同日（2026-08-01 の id=1,2）は id の降順。新しい順で一貫させている
    assert ids(conn, TransactionFilter()) == [5, 2, 1, 7, 6, 3, 4, 8]


def test_振替を除外できる(conn: sqlite3.Connection) -> None:
    result = ids(conn, TransactionFilter(modes=("payment", "income")))
    assert 7 not in result
    assert len(result) == 7


def test_期間で絞り込める(conn: sqlite3.Connection) -> None:
    # 境界日を含むこと（07-01 と 07-26 の両方が残る）
    filt = TransactionFilter(date_from="2026-07-01", date_to="2026-07-26")
    assert ids(conn, filt) == [7, 6, 3, 4]


def test_日付上限で未来の明細を隠せる(conn: sqlite3.Connection) -> None:
    # 実データでは 2029 年まで繰り返し登録の家賃が入っている
    assert 5 not in ids(conn, TransactionFilter(date_to="2026-08-06"))


def test_カテゴリとジャンルで絞り込める(conn: sqlite3.Connection) -> None:
    assert ids(conn, TransactionFilter(category_ids=(102,))) == [5, 4]
    assert ids(conn, TransactionFilter(genre_ids=(1001, 1002))) == [2, 1, 3, 8]


def test_口座は出金元と入金先のどちらの一致でも該当する(conn: sqlite3.Connection) -> None:
    # 11 は payment の from（3,4,5）、income の to（6）、transfer の from（7）
    assert ids(conn, TransactionFilter(account_ids=(11,))) == [5, 7, 6, 3, 4]


def test_金額の下限で少額ノイズを除ける(conn: sqlite3.Connection) -> None:
    # 自動連携の細かい履歴を落とす主力フィルタ。振替（id=7）も金額では残る
    assert ids(conn, TransactionFilter(amount_min=1000)) == [5, 7, 6, 3, 4]


def test_金額の上下限は境界値を含む(conn: sqlite3.Connection) -> None:
    assert ids(conn, TransactionFilter(amount_min=320, amount_max=980)) == [1, 8]


def test_キーワードは品名と店舗とメモを横断する(conn: sqlite3.Connection) -> None:
    assert ids(conn, TransactionFilter(q="セブン")) == [2, 1]
    assert ids(conn, TransactionFilter(q="おにぎり")) == [1]
    assert ids(conn, TransactionFilter(q="ついで")) == [2]


def test_キーワードのアンダースコアはワイルドカードにならない(conn: sqlite3.Connection) -> None:
    # "_店_" が任意 1 文字として解釈されると別の行まで拾ってしまう
    assert ids(conn, TransactionFilter(q="_店_")) == [8]
    assert ids(conn, TransactionFilter(q="喫茶 _店_")) == [8]


def test_キーワードのパーセントはワイルドカードにならない(conn: sqlite3.Connection) -> None:
    assert ids(conn, TransactionFilter(q="100%")) == [8]


def test_店舗を除外しても店舗未設定の明細は残る(conn: sqlite3.Connection) -> None:
    # place が NULL の行は NOT IN で消えやすい。COALESCE で守っている
    result = ids(conn, TransactionFilter(exclude_places=("セブンイレブン",)))
    assert result == [5, 7, 6, 3, 4, 8]


def test_ジャンルを除外しても未設定の明細は残る(conn: sqlite3.Connection) -> None:
    # 振替（id=7）は genre_id が NULL
    assert ids(conn, TransactionFilter(exclude_genre_ids=(1003,))) == [2, 1, 7, 6, 3, 8]


def test_条件を重ねると_AND_で効く(conn: sqlite3.Connection) -> None:
    filt = TransactionFilter(
        modes=("payment",),
        date_to="2026-08-06",
        amount_min=500,
        exclude_places=("セブンイレブン",),
    )
    assert ids(conn, filt) == [3, 4, 8]


def test_件数と金額合計はフィルタ後の値になる(conn: sqlite3.Connection) -> None:
    total, total_amount = count_transactions(conn, TransactionFilter(category_ids=(102,)))
    assert (total, total_amount) == (2, 70000)


def test_一致0件でも合計は0を返す(conn: sqlite3.Connection) -> None:
    assert count_transactions(conn, TransactionFilter(q="存在しない")) == (0, 0)


@pytest.mark.parametrize(
    ("offset", "expected"),
    [(0, [5, 2]), (2, [1, 7]), (6, [4, 8]), (8, [])],
)
def test_ページ送りで重複も欠落もしない(
    conn: sqlite3.Connection, offset: int, expected: list[int]
) -> None:
    # 同日 2 件（id=1,2）をまたぐ位置を含めて確認する
    page = fetch_transactions(conn, TransactionFilter(), limit=2, offset=offset)
    assert [row["id"] for row in page] == expected


def test_明細はマスタ名と_ID_の両方を持つ(conn: sqlite3.Connection) -> None:
    row = fetch_transactions(conn, TransactionFilter(q="おにぎり"), limit=1, offset=0)[0]
    assert row["category_id"] == 101
    assert row["category"] == "Food"
    assert row["genre"] == "昼食"
    assert row["from_account"] == "PayPay残高"
    assert row["to_account"] is None
