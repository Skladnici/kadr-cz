import pytest

from app.main import _login_attempts


@pytest.fixture(autouse=True)
def reset_login_attempts():
    """Every test file shares one TestClient/app instance, and TestClient's
    requests all come from the same fake client IP — without this, wrong
    -credentials attempts in one test file (test_auth.py,
    test_security_headers.py) would accumulate toward another file's
    lockout threshold, making pass/fail depend on test execution order."""
    _login_attempts.clear()
    yield
    _login_attempts.clear()
