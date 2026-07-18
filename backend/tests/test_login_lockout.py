"""
Regression tests for the failed-login brute-force lockout in
_require_site_auth (main.py): 5 wrong-password attempts from one IP
within a 5-minute window lock that IP out for 15 minutes (429), on top
of (and independent from) the plain per-route request-count limits
covered in test_rate_limiting.py. Real wall-clock time isn't used —
app.main's `time` module is monkeypatched to a controllable fake clock
so the 5-minute window and 15-minute lockout can be exercised without
actually sleeping.
"""
import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.config import settings
from app.main import app

client = TestClient(app)


@pytest.fixture
def configured_auth(monkeypatch):
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")


@pytest.fixture
def fake_clock(monkeypatch):
    state = {"now": 1_000_000.0}
    monkeypatch.setattr(main_module.time, "time", lambda: state["now"])
    return state


def _wrong_login():
    return client.get("/api/blanks", auth=("hr", "wrong-password"))


def _correct_login():
    return client.get("/api/blanks", auth=("hr", "test123"))


def test_ordinary_user_with_one_or_two_mistakes_is_not_locked_out(configured_auth, fake_clock):
    assert _wrong_login().status_code == 401
    assert _wrong_login().status_code == 401
    assert _correct_login().status_code == 200


def test_fifth_failure_within_window_locks_out_with_429(configured_auth, fake_clock):
    for _ in range(4):
        assert _wrong_login().status_code == 401
    resp = _wrong_login()
    assert resp.status_code == 429
    assert "Retry-After" in resp.headers
    assert resp.json()["detail"] == main_module.LOGIN_LOCKOUT_MESSAGE


def test_locked_out_ip_is_blocked_even_with_correct_credentials(configured_auth, fake_clock):
    for _ in range(5):
        _wrong_login()
    resp = _correct_login()
    assert resp.status_code == 429


def test_lockout_clears_after_15_minutes(configured_auth, fake_clock):
    for _ in range(5):
        _wrong_login()
    assert _correct_login().status_code == 429

    fake_clock["now"] += main_module.LOGIN_LOCKOUT_SECONDS + 1
    assert _correct_login().status_code == 200


def test_successful_login_resets_the_failure_count(configured_auth, fake_clock):
    for _ in range(3):
        assert _wrong_login().status_code == 401
    assert _correct_login().status_code == 200

    # Fresh count after the successful login — 3 more wrong attempts alone
    # must not trip the 5-failure threshold.
    for _ in range(3):
        assert _wrong_login().status_code == 401
    assert _correct_login().status_code == 200


def test_old_failures_outside_the_5_minute_window_do_not_count(configured_auth, fake_clock):
    for _ in range(4):
        assert _wrong_login().status_code == 401

    fake_clock["now"] += main_module.LOGIN_ATTEMPT_WINDOW_SECONDS + 1
    # The 4 earlier failures have aged out — this attempt is only the 1st
    # within the current window, so it must not lock out.
    assert _wrong_login().status_code == 401
