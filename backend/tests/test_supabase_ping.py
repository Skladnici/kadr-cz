"""
GET /api/ping/supabase (see main.py's ping_supabase / .github/workflows/
supabase-ping.yml) has one job: tell the caller whether Supabase is a
project that's merely being slow/erroring, versus one that's actually
been PAUSED and needs a human to click Restore in the dashboard. Getting
that distinction wrong in either direction defeats the whole feature —
too eager, and the cron's failed run trains everyone to ignore the alert
email; too lax, and a real pause goes unnoticed until someone opens the
site and it's broken.

Supabase itself isn't run locally, so httpx.AsyncClient.request is
monkeypatched the same way test_stats_endpoint.py does it, to return
canned responses standing in for Supabase's documented behavior:
- a paused project answers its own custom HTTP 540
  (https://supabase.com/docs/guides/troubleshooting/http-status-codes)
- a network-level failure (timeout/connection refused) is NOT that same
  signal — a paused project still answers 540 rather than dropping the
  connection — so it must NOT be treated as a confirmed pause
"""
import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app, limiter

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_limiter():
    limiter.reset()
    yield
    limiter.reset()


@pytest.fixture
def configured_supabase(monkeypatch):
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://fake.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "fake-anon-key")
    monkeypatch.setattr(settings, "PING_TOKEN", "")


def _fake_request(status_code):
    async def fake(self, method, url, *, headers=None, params=None, json=None, **_ignored):
        assert url.endswith("/companies")
        return httpx.Response(status_code, json=[], request=httpx.Request(method, url))
    return fake


def test_ok_when_supabase_responds_normally(configured_supabase, monkeypatch):
    monkeypatch.setattr(httpx.AsyncClient, "request", _fake_request(200))
    resp = client.get("/api/ping/supabase")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_540_is_reported_as_a_confirmed_pause(configured_supabase, monkeypatch):
    monkeypatch.setattr(httpx.AsyncClient, "request", _fake_request(540))
    resp = client.get("/api/ping/supabase")
    # The cron workflow keys off exactly this status to fail its run.
    assert resp.status_code == 503


@pytest.mark.parametrize("status_code", [500, 502, 503, 429])
def test_other_error_statuses_are_not_treated_as_a_confirmed_pause(configured_supabase, monkeypatch, status_code):
    monkeypatch.setattr(httpx.AsyncClient, "request", _fake_request(status_code))
    resp = client.get("/api/ping/supabase")
    # Reported back as 200 on purpose — an ordinary 5xx blip must not
    # fail the cron workflow and trigger a false-alarm email.
    assert resp.status_code == 200
    assert resp.json()["status"] == "error"


def test_network_error_is_not_treated_as_a_confirmed_pause(configured_supabase, monkeypatch):
    async def broken(self, method, url, *, headers=None, params=None, json=None, **_ignored):
        raise httpx.ConnectTimeout("timed out", request=httpx.Request(method, url))

    monkeypatch.setattr(httpx.AsyncClient, "request", broken)
    resp = client.get("/api/ping/supabase")
    assert resp.status_code == 200
    assert resp.json()["status"] == "network_error"


def test_not_configured_short_circuits_without_calling_supabase(monkeypatch):
    monkeypatch.setattr(settings, "SUPABASE_URL", "")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "")
    monkeypatch.setattr(settings, "PING_TOKEN", "")

    async def unexpected(self, *a, **k):
        raise AssertionError("should not call Supabase when unconfigured")

    monkeypatch.setattr(httpx.AsyncClient, "request", unexpected)
    resp = client.get("/api/ping/supabase")
    assert resp.status_code == 200
    assert resp.json() == {"status": "not_configured"}


def test_wrong_ping_token_is_rejected(configured_supabase, monkeypatch):
    monkeypatch.setattr(settings, "PING_TOKEN", "secret-123")
    resp = client.get("/api/ping/supabase")
    assert resp.status_code == 401


def test_correct_ping_token_via_query_param_is_accepted(configured_supabase, monkeypatch):
    monkeypatch.setattr(settings, "PING_TOKEN", "secret-123")
    monkeypatch.setattr(httpx.AsyncClient, "request", _fake_request(200))
    resp = client.get("/api/ping/supabase", params={"token": "secret-123"})
    assert resp.status_code == 200


def test_correct_ping_token_via_header_is_accepted(configured_supabase, monkeypatch):
    monkeypatch.setattr(settings, "PING_TOKEN", "secret-123")
    monkeypatch.setattr(httpx.AsyncClient, "request", _fake_request(200))
    resp = client.get("/api/ping/supabase", headers={"X-Ping-Token": "secret-123"})
    assert resp.status_code == 200
