"""明細フィルタを SQL に変換する。

CLAUDE.md の設計決定「除外は行ごとのフラグではなくクエリのルールで表現する」の
実装箇所。ルールの追加・変更はすべてこのモジュールに閉じる。
将来「よく使う除外条件に名前を付ける」層を載せる場合も、
その層は TransactionFilter を組み立てるだけでよく、SQL を書く必要はない。
"""

import sqlite3
from dataclasses import dataclass, field
from typing import Any

# 明細一覧の SELECT 句。マスタ名と ID の両方を返す
# （名前は表示用、ID は UI がフィルタを組み立てるために使う）。
#
# v_transactions VIEW を使わず自前で JOIN しているのは、VIEW が ID 列を持たないため。
# VIEW を変更するには schema.sql の変更と再同期が要る一方、API 側の JOIN なら
# ミラーの構造に触れずに済む。VIEW は Grafana 用として現状のまま残す。
_SELECT_COLUMNS = """
    t.id,
    t.mode,
    t.date,
    t.amount,
    t.category_id,
    c.name  AS category,
    t.genre_id,
    g.name  AS genre,
    t.from_account_id,
    fa.name AS from_account,
    t.to_account_id,
    ta.name AS to_account,
    t.name,
    t.place,
    t.comment,
    t.currency_code
"""

_FROM_JOIN = """
FROM transactions t
LEFT JOIN categories c  ON c.id  = t.category_id
LEFT JOIN genres g      ON g.id  = t.genre_id
LEFT JOIN accounts fa   ON fa.id = t.from_account_id
LEFT JOIN accounts ta   ON ta.id = t.to_account_id
"""

# LIKE 検索でワイルドカードとして解釈させないための退避文字
_LIKE_ESCAPE = "\\"


@dataclass(frozen=True)
class TransactionFilter:
    """明細の絞り込み条件。

    未指定（None または空タプル）の項目は条件を課さない。
    「振替を除外」「今日以前だけ」といった既定値は API 側には持たせず、
    呼び出し側（PWA）が明示的に指定する。

    Attributes:
        date_from: 開始日（YYYY-MM-DD、この日を含む）。
        date_to: 終了日（YYYY-MM-DD、この日を含む）。
        modes: 含める mode（payment / income / transfer）。
        category_ids: 含めるカテゴリ ID。
        genre_ids: 含めるジャンル ID。
        account_ids: 含める口座 ID（出金元・入金先のいずれかが一致すれば該当）。
        amount_min: 金額の下限（この値を含む）。
        amount_max: 金額の上限（この値を含む）。
        q: 品名・店舗・メモへの部分一致キーワード。
        exclude_places: 除外する店舗名（完全一致）。
        exclude_genre_ids: 除外するジャンル ID。
    """

    date_from: str | None = None
    date_to: str | None = None
    modes: tuple[str, ...] = ()
    category_ids: tuple[int, ...] = ()
    genre_ids: tuple[int, ...] = ()
    account_ids: tuple[int, ...] = ()
    amount_min: int | None = None
    amount_max: int | None = None
    q: str | None = None
    exclude_places: tuple[str, ...] = ()
    exclude_genre_ids: tuple[int, ...] = ()


@dataclass
class _Where:
    """組み立て中の WHERE 句とバインド値。"""

    clauses: list[str] = field(default_factory=list)
    params: list[Any] = field(default_factory=list)

    def add(self, clause: str, *params: Any) -> None:
        """条件を 1 つ追加する。

        Args:
            clause: SQL の条件式（プレースホルダを含む）。
            *params: プレースホルダにバインドする値。
        """
        self.clauses.append(clause)
        self.params.extend(params)

    def add_in(self, column: str, values: tuple[Any, ...], *, negate: bool = False) -> None:
        """IN / NOT IN 条件を追加する。値が空なら何もしない。

        Args:
            column: 対象の列式。
            values: 候補値。空タプルなら条件を追加しない。
            negate: True なら NOT IN にする。
        """
        if not values:
            return
        placeholders = ", ".join(["?"] * len(values))
        op = "NOT IN" if negate else "IN"
        self.add(f"{column} {op} ({placeholders})", *values)

    def render(self) -> str:
        """WHERE 句の文字列を返す。条件が無ければ空文字。"""
        return " WHERE " + " AND ".join(self.clauses) if self.clauses else ""


def _escape_like(term: str) -> str:
    """LIKE のワイルドカード（% _）と退避文字自体をエスケープする。

    Args:
        term: 利用者が入力した検索語。

    Returns:
        LIKE パターンに埋め込める文字列。
    """
    for char in (_LIKE_ESCAPE, "%", "_"):
        term = term.replace(char, _LIKE_ESCAPE + char)
    return term


def build_where(filt: TransactionFilter) -> tuple[str, list[Any]]:
    """フィルタを WHERE 句とバインド値に変換する。

    Args:
        filt: 絞り込み条件。

    Returns:
        (WHERE 句, バインド値のリスト)。条件が無い場合 WHERE 句は空文字。
    """
    where = _Where()

    if filt.date_from:
        where.add("t.date >= ?", filt.date_from)
    if filt.date_to:
        where.add("t.date <= ?", filt.date_to)

    where.add_in("t.mode", filt.modes)
    where.add_in("t.category_id", filt.category_ids)
    where.add_in("t.genre_id", filt.genre_ids)

    # 口座は payment なら from、income なら to に入る。
    # 利用者から見れば「その口座の明細」なので、どちらか一致で該当とする。
    if filt.account_ids:
        placeholders = ", ".join(["?"] * len(filt.account_ids))
        where.add(
            f"(t.from_account_id IN ({placeholders})"
            f" OR t.to_account_id IN ({placeholders}))",
            *filt.account_ids,
            *filt.account_ids,
        )

    if filt.amount_min is not None:
        where.add("t.amount >= ?", filt.amount_min)
    if filt.amount_max is not None:
        where.add("t.amount <= ?", filt.amount_max)

    if filt.q:
        pattern = f"%{_escape_like(filt.q)}%"
        where.add(
            "(COALESCE(t.name, '') LIKE ? ESCAPE ?"
            " OR COALESCE(t.place, '') LIKE ? ESCAPE ?"
            " OR COALESCE(t.comment, '') LIKE ? ESCAPE ?)",
            pattern, _LIKE_ESCAPE, pattern, _LIKE_ESCAPE, pattern, _LIKE_ESCAPE,
        )

    # place が NULL の行を NOT IN が取りこぼさないよう COALESCE を挟む
    # （NULL NOT IN (...) は NULL になり、行が消えてしまう）。
    where.add_in("COALESCE(t.place, '')", filt.exclude_places, negate=True)
    where.add_in("COALESCE(t.genre_id, -1)", filt.exclude_genre_ids, negate=True)

    return where.render(), where.params


def fetch_transactions(
    conn: sqlite3.Connection, filt: TransactionFilter, *, limit: int, offset: int
) -> list[dict[str, Any]]:
    """フィルタに一致する明細を日付の新しい順に取得する。

    Args:
        conn: 読み取り用の接続。
        filt: 絞り込み条件。
        limit: 取得件数の上限。
        offset: スキップする件数。

    Returns:
        明細の dict のリスト。
    """
    where_sql, params = build_where(filt)
    # 同日内の順序を安定させるため id を第 2 キーにする
    # （不安定だとページ送りで明細が重複・欠落する）。
    sql = (
        f"SELECT {_SELECT_COLUMNS} {_FROM_JOIN} {where_sql}"
        " ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?"
    )
    rows = conn.execute(sql, [*params, limit, offset]).fetchall()
    return [dict(row) for row in rows]


def count_transactions(
    conn: sqlite3.Connection, filt: TransactionFilter
) -> tuple[int, int]:
    """フィルタに一致する明細の件数と金額合計を返す。

    件数はページャに、合計は「この条件で総額いくらか」の確認に使う。
    1 回の集計クエリで両方を得る。

    Args:
        conn: 読み取り用の接続。
        filt: 絞り込み条件。

    Returns:
        (件数, 金額合計)。一致 0 件なら (0, 0)。
    """
    where_sql, params = build_where(filt)
    sql = f"SELECT COUNT(*), COALESCE(SUM(t.amount), 0) {_FROM_JOIN} {where_sql}"
    total, total_amount = conn.execute(sql, params).fetchone()
    return total, total_amount
