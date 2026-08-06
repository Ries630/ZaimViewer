"""HTTP レイヤ（パラメータの受け渡しと検証）を確認する。"""

from fastapi.testclient import TestClient


def test_明細一覧はページ情報付きで返る(client: TestClient) -> None:
    body = client.get("/api/transactions", params={"limit": 3}).json()
    assert body["total"] == 8
    assert body["limit"] == 3
    assert body["offset"] == 0
    assert [item["id"] for item in body["items"]] == [5, 2, 1]


def test_複数指定のパラメータが配列として届く(client: TestClient) -> None:
    body = client.get(
        "/api/transactions", params={"mode": ["payment", "income"]}
    ).json()
    assert {item["mode"] for item in body["items"]} == {"payment", "income"}


def test_合計金額はフィルタ後の値になる(client: TestClient) -> None:
    body = client.get("/api/transactions", params={"category_id": 102}).json()
    assert body["total_amount"] == 70000


def test_不正な日付書式は422で弾く(client: TestClient) -> None:
    assert client.get("/api/transactions", params={"date_from": "2026/08/01"}).status_code == 422


def test_上限を超える_limit_は422で弾く(client: TestClient) -> None:
    assert client.get("/api/transactions", params={"limit": 9999}).status_code == 422


def test_マスタ一式が取得できる(client: TestClient) -> None:
    body = client.get("/api/masters").json()
    assert len(body["categories"]) == 3
    assert len(body["genres"]) == 4
    assert [a["name"] for a in body["accounts"]] == ["みんなの銀行", "PayPay残高", "現金"]


def test_同期メタ情報が取得できる(client: TestClient) -> None:
    body = client.get("/api/meta").json()
    assert body["synced_at"] == "2026-08-06T09:41:22.566560+00:00"
    assert body["counts"]["transactions"] == 8
