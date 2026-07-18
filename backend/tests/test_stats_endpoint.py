"""
GET /api/stats and the generation-logging side effect of POST /api/fill
had zero test coverage. Two things matter here specifically:

1. _log_generation's company_name normalization (None/""/whitespace all
   collapse to the same "Bez firmy" bucket the generation_stats view
   would produce via coalesce()) — get this wrong and the widget splits
   what should be one bucket into several, or shows a stray blank entry.
2. A successful /api/fill must never turn into a failure because
   logging failed — Supabase being unconfigured, or the insert itself
   erroring, has to be silently swallowed.

Supabase itself isn't run locally, so httpx.AsyncClient.request is
monkeypatched to an in-memory fake that mimics the two REST resources
_log_generation/get_stats actually touch (POST generation_log, GET
generation_stats) closely enough to prove main.py's own logic — not
Supabase's — is correct. The fake's stats() aggregation intentionally
mirrors create_generation_log_table.sql's view definition (coalesce to
"Bez firmy", order by count desc).
"""
import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app, limiter

client = TestClient(app)

AUTH = ("hr", "test123")


@pytest.fixture(autouse=True)
def reset_limiter():
    # /api/fill is capped at 10/minute (see test_rate_limiting.py) — this
    # file calls it repeatedly across several tests, which would
    # otherwise inherit leftover hit counts from whatever ran earlier in
    # the same minute and start failing with 429s unrelated to what's
    # actually being tested here.
    limiter.reset()
    yield
    limiter.reset()


class FakeGenerationLog:
    def __init__(self):
        self.rows = []  # each: {"company_name": str|None, "document_type": str}

    def insert(self, json_body):
        self.rows.append(json_body)
        return 201, [json_body]

    def stats(self):
        counts = {}
        for row in self.rows:
            name = row.get("company_name") or "Bez firmy"
            counts[name] = counts.get(name, 0) + 1
        rows = [{"company_name": name, "document_count": n} for name, n in counts.items()]
        rows.sort(key=lambda r: -r["document_count"])
        return 200, rows


@pytest.fixture
def fake_supabase(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://fake.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "fake-anon-key")
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)

    log = FakeGenerationLog()

    async def fake_request(self, method, url, *, headers=None, params=None, json=None, **_ignored):
        # main.py calls client.get()/client.post() (not the lower-level
        # .request() the companies fake mimics) — those convenience
        # wrappers always forward extra kwargs (cookies, auth,
        # follow_redirects, timeout, extensions) into request(), so this
        # signature has to swallow whatever it doesn't care about.
        if url.endswith("/generation_log"):
            assert method == "POST"
            status, body = log.insert(json)
        elif url.endswith("/generation_stats"):
            assert method == "GET"
            status, body = log.stats()
        else:
            raise AssertionError(f"unexpected Supabase URL: {url}")
        return httpx.Response(status, json=body, request=httpx.Request(method, url))

    monkeypatch.setattr(httpx.AsyncClient, "request", fake_request)
    return log


def _fill(company_name=None, template_id="dpp_template"):
    payload = {"template_id": template_id, "last_name": "Novak", "first_name": "Jan"}
    if company_name is not None:
        payload["company_name"] = company_name
    return client.post("/api/fill", auth=AUTH, json=payload)


def test_stats_start_empty(fake_supabase):
    resp = client.get("/api/stats", auth=AUTH)
    assert resp.status_code == 200
    assert resp.json() == []


def test_successful_fill_is_reflected_in_stats(fake_supabase):
    resp = _fill(company_name="ACME s.r.o.")
    assert resp.status_code == 200

    stats = client.get("/api/stats", auth=AUTH).json()
    assert stats == [{"company_name": "ACME s.r.o.", "document_count": 1}]


def test_multiple_companies_and_repeats_aggregate_correctly(fake_supabase):
    for _ in range(3):
        assert _fill(company_name="ACME s.r.o.").status_code == 200
    for _ in range(2):
        assert _fill(company_name="Beta Trading").status_code == 200
    assert _fill(company_name="Beta Trading", template_id="hpp_template").status_code == 200

    stats = client.get("/api/stats", auth=AUTH).json()
    by_name = {row["company_name"]: row["document_count"] for row in stats}
    assert by_name == {"ACME s.r.o.": 3, "Beta Trading": 3}
    # generation_stats orders by document_count desc — both companies tie
    # at 3 here, so just the aggregate counts are asserted above; the
    # descending-order guarantee itself is exercised by the next test
    # instead, where the counts actually differ.


def test_generation_stats_view_orders_by_count_descending(fake_supabase):
    assert _fill(company_name="Small Co").status_code == 200
    for _ in range(4):
        assert _fill(company_name="Big Co").status_code == 200

    stats = client.get("/api/stats", auth=AUTH).json()
    assert [row["company_name"] for row in stats] == ["Big Co", "Small Co"]


@pytest.mark.parametrize("company_name", [None, "", "   "])
def test_fill_without_a_company_is_logged_as_bez_firmy(fake_supabase, company_name):
    assert _fill(company_name=company_name).status_code == 200
    # A second, named generation must not be folded into the same bucket.
    assert _fill(company_name="Named Co").status_code == 200

    stats = client.get("/api/stats", auth=AUTH).json()
    by_name = {row["company_name"]: row["document_count"] for row in stats}
    assert by_name == {"Bez firmy": 1, "Named Co": 1}


def test_fill_still_succeeds_when_supabase_logging_itself_errors(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://fake.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "fake-anon-key")
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)

    async def broken_request(self, method, url, *, headers=None, params=None, json=None):
        raise httpx.ConnectError("Supabase is down", request=httpx.Request(method, url))

    monkeypatch.setattr(httpx.AsyncClient, "request", broken_request)

    resp = _fill(company_name="ACME s.r.o.")
    assert resp.status_code == 200
    assert resp.json()["docx_token"].endswith(".docx")


def test_fill_succeeds_without_logging_when_supabase_is_unconfigured(monkeypatch, tmp_path):
    # Explicitly blanked out, not just "left at the default" — config.py's
    # load_dotenv() picks up backend/.env, which (in this dev environment)
    # has real SUPABASE_URL/KEY, so an untouched settings.SUPABASE_URL is
    # NOT empty here. Without this, _log_generation() would actually POST
    # this test's "ACME s.r.o." fill into the real production
    # generation_log table instead of exercising the unconfigured path.
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)
    monkeypatch.setattr(settings, "SUPABASE_URL", "")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "")

    resp = _fill(company_name="ACME s.r.o.")
    assert resp.status_code == 200


def test_stats_route_503s_when_supabase_is_unconfigured(monkeypatch):
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    monkeypatch.setattr(settings, "SUPABASE_URL", "")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "")

    resp = client.get("/api/stats", auth=AUTH)
    assert resp.status_code == 503
