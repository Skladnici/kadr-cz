"""
Regression tests for the per-IP rate limits on /api/recognize (backed by
OCR.space's free tier, ~500 requests/day for the whole site) and
/api/fill (real disk writes + a LibreOffice subprocess) — both capped at
10 requests/minute in main.py via slowapi. Deliberately NOT covering
/api/companies, /api/blanks, or /api/download here: they aren't rate
limited (no external quota behind them, or a separate concern) and
test_auth.py already covers their auth behavior.

The `reset_limiter` fixture clears slowapi's in-memory hit counters
before every test in this file — without it, tests would inherit
leftover counts from whatever else in the suite already called these two
endpoints (e.g. test_full_user_cycle.py), making pass/fail depend on
test execution order.
"""
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app, limiter

client = TestClient(app)

_TINY_JPEG = (
    b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    b"\xff\xdb\x00C\x00" + b"\x01" * 64 + b"\xff\xd9"
)


@pytest.fixture(autouse=True)
def reset_limiter():
    limiter.reset()
    yield
    limiter.reset()


@pytest.fixture
def configured_auth(monkeypatch):
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    return ("hr", "test123")


def _recognize_once(auth):
    return client.post(
        "/api/recognize",
        auth=auth,
        files={"file": ("passport.jpg", _TINY_JPEG, "image/jpeg")},
    )


def _fill_once(auth, tmp_path):
    return client.post(
        "/api/fill",
        auth=auth,
        json={"template_id": "dpp_template", "first_name": "Jan", "last_name": "Novak"},
    )


def test_recognize_allows_ordinary_burst_within_limit(configured_auth, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "OCR_MODE", "mock")
    monkeypatch.setattr(settings, "UPLOAD_DIR", tmp_path)
    for _ in range(5):
        resp = _recognize_once(configured_auth)
        assert resp.status_code == 200


def test_recognize_blocks_after_exceeding_limit_with_czech_message(configured_auth, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "OCR_MODE", "mock")
    monkeypatch.setattr(settings, "UPLOAD_DIR", tmp_path)

    responses = [_recognize_once(configured_auth) for _ in range(10)]
    assert all(r.status_code == 200 for r in responses), (
        "the 10 requests within the limit must all succeed normally"
    )

    over_limit_resp = _recognize_once(configured_auth)
    assert over_limit_resp.status_code == 429
    assert over_limit_resp.json()["detail"] == (
        "Příliš mnoho požadavků z vaší adresy — zkuste to prosím znovu za minutu."
    )
    assert "Retry-After" in over_limit_resp.headers

    # Still limited on the very next attempt too — not a one-off fluke.
    still_blocked_resp = _recognize_once(configured_auth)
    assert still_blocked_resp.status_code == 429


def test_fill_allows_ordinary_burst_within_limit(configured_auth, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)
    for _ in range(5):
        resp = _fill_once(configured_auth, tmp_path)
        assert resp.status_code == 200


def test_fill_blocks_after_exceeding_limit_with_czech_message(configured_auth, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)

    responses = [_fill_once(configured_auth, tmp_path) for _ in range(10)]
    assert all(r.status_code == 200 for r in responses), (
        "the 10 requests within the limit must all succeed normally"
    )

    over_limit_resp = _fill_once(configured_auth, tmp_path)
    assert over_limit_resp.status_code == 429
    assert over_limit_resp.json()["detail"] == (
        "Příliš mnoho požadavků z vaší adresy — zkuste to prosím znovu za minutu."
    )
    assert "Retry-After" in over_limit_resp.headers


def test_recognize_and_fill_limits_are_independent(configured_auth, monkeypatch, tmp_path):
    # Exhausting one endpoint's quota must not affect the other's — they
    # are two separate resource concerns (OCR.space quota vs. disk/CPU).
    monkeypatch.setattr(settings, "OCR_MODE", "mock")
    monkeypatch.setattr(settings, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)

    for _ in range(10):
        assert _recognize_once(configured_auth).status_code == 200
    assert _recognize_once(configured_auth).status_code == 429

    # /api/fill must still work normally — its own quota is untouched.
    assert _fill_once(configured_auth, tmp_path).status_code == 200


def test_recognize_text_is_not_rate_limited(configured_auth):
    # /api/recognize-text was intentionally left out of scope (pasted
    # text, not an OCR.space call or a document generation) — it must
    # keep working past 10 requests/minute.
    for _ in range(12):
        resp = client.post(
            "/api/recognize-text",
            auth=configured_auth,
            json={"text": "CESTOVNÍ PAS\nNOVÁK JAN"},
        )
        assert resp.status_code == 200
