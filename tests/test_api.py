"""
API tests: Neo4j is mocked so CI does not need a live database.
"""

import pytest
from fastapi.testclient import TestClient

from api import main


@pytest.fixture
def client() -> TestClient:
    return TestClient(main.app)


def test_health(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_get_tickers_empty(client: TestClient, monkeypatch) -> None:
    def fake_run_query(query: str, params: dict = None) -> list[dict]:
        return []

    monkeypatch.setattr(main, "run_query", fake_run_query)
    r = client.get("/api/tickers")
    assert r.status_code == 200
    assert r.json() == []


def test_get_tickers_returns_symbols(client: TestClient, monkeypatch) -> None:
    def fake_run_query(query: str, params: dict = None) -> list[dict]:
        return [{"symbol": "AAPL"}, {"symbol": "MSFT"}]

    monkeypatch.setattr(main, "run_query", fake_run_query)
    r = client.get("/api/tickers")
    assert r.status_code == 200
    assert r.json() == ["AAPL", "MSFT"]


def test_get_prices_404(client: TestClient, monkeypatch) -> None:
    def fake_run_query(query: str, params: dict = None) -> list[dict]:
        return []

    monkeypatch.setattr(main, "run_query", fake_run_query)
    r = client.get("/api/prices/FAKE")
    assert r.status_code == 404


def test_get_graph_404(client: TestClient, monkeypatch) -> None:
    def fake_run_query(query: str, params: dict = None) -> list[dict]:
        return []

    monkeypatch.setattr(main, "run_query", fake_run_query)
    r = client.get("/api/graph/FAKE")
    assert r.status_code == 404


def test_get_articles_with_mock(client: TestClient, monkeypatch) -> None:
    def fake_run_query(query: str, params: dict = None) -> list[dict]:
        return [
            {
                "id": 1,
                "headline": "Test",
                "abstract": "Abs",
                "url": "https://example.com",
                "published_date": "2024-01-01",
                "sentiment": 0.1,
                "section": "Business",
                "entities": [{"text": "Apple", "label": "ORG"}],
            }
        ]

    monkeypatch.setattr(main, "run_query", fake_run_query)
    r = client.get("/api/articles?limit=5")
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 1
    assert data[0]["headline"] == "Test"


def test_correlate_no_articles_404(client: TestClient, monkeypatch) -> None:
    def fake_run_query(query: str, params: dict = None) -> list[dict]:
        return []

    monkeypatch.setattr(main, "run_query", fake_run_query)
    r = client.get("/api/correlate/FAKE")
    assert r.status_code == 404


@pytest.mark.parametrize(
    "x,y,expected",
    [
        ([1.0, 2.0, 3.0], [2.0, 4.0, 6.0], 1.0),
        ([0.0, 1.0], [0.0, 0.0], None),
    ],
)
def test_pearson(
    x: list[float], y: list[float], expected: float | None
) -> None:
    assert main._pearson(x, y) == expected


def test_correlation_summary(client: TestClient) -> None:
    del client
    assert "Strong positive" in main._correlation_summary(0.6)
    assert "Insufficient" in main._correlation_summary(None)
"""
API tests: Neo4j is mocked so CI does not need a live database.
"""

import pytest
from fastapi.testclient import TestClient

from api import main


@pytest.fixture
def client() -> TestClient:
    return TestClient(main.app)


def test_health(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_get_tickers_empty(client: TestClient, monkeypatch) -> None:
    def fake_run_query(query: str, params: dict = None) -> list[dict]:
        return []

    monkeypatch.setattr(main, "run_query", fake_run_query)
    r = client.get("/api/tickers")
    assert r.status_code == 200
    assert r.json() == []


def test_get_tickers_returns_symbols(client: TestClient, monkeypatch) -> None:
    def fake_run_query(query: str, params: dict = None) -> list[dict]:
        return [{"symbol": "AAPL"}, {"symbol": "MSFT"}]

    monkeypatch.setattr(main, "run_query", fake_run_query)
    r = client.get("/api/tickers")
    assert r.status_code == 200
    assert r.json() == ["AAPL", "MSFT"]


def test_get_prices_404(client: TestClient, monkeypatch) -> None:
    def fake_run_query(query: str, params: dict = None) -> list[dict]:
        return []

    monkeypatch.setattr(main, "run_query", fake_run_query)
    r = client.get("/api/prices/FAKE")
    assert r.status_code == 404


def test_get_graph_404(client: TestClient, monkeypatch) -> None:
    def fake_run_query(query: str, params: dict = None) -> list[dict]:
        return []

    monkeypatch.setattr(main, "run_query", fake_run_query)
    r = client.get("/api/graph/FAKE")
    assert r.status_code == 404


def test_get_articles_with_mock(client: TestClient, monkeypatch) -> None:
    def fake_run_query(query: str, params: dict = None) -> list[dict]:
        return [
            {
                "id": 1,
                "headline": "Test",
                "abstract": "Abs",
                "url": "https://example.com",
                "published_date": "2024-01-01",
                "sentiment": 0.1,
                "section": "Business",
                "entities": [{"text": "Apple", "label": "ORG"}],
            }
        ]

    monkeypatch.setattr(main, "run_query", fake_run_query)
    r = client.get("/api/articles?limit=5")
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 1
    assert data[0]["headline"] == "Test"


def test_correlate_no_articles_404(client: TestClient, monkeypatch) -> None:
    def fake_run_query(query: str, params: dict = None) -> list[dict]:
        return []

    monkeypatch.setattr(main, "run_query", fake_run_query)
    r = client.get("/api/correlate/FAKE")
    assert r.status_code == 404


@pytest.mark.parametrize(
    "x,y,expected",
    [
        ([1.0, 2.0, 3.0], [2.0, 4.0, 6.0], 1.0),
        ([0.0, 1.0], [0.0, 0.0], None),
    ],
)
def test_pearson(
    x: list[float], y: list[float], expected: float | None
) -> None:
    assert main._pearson(x, y) == expected


def test_correlation_summary(client: TestClient) -> None:
    del client
    assert "Strong positive" in main._correlation_summary(0.6)
    assert "Insufficient" in main._correlation_summary(None)
