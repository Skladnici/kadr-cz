"""
Regression tests for the site-wide security response headers added in
main.py's `_security_headers` middleware: Content-Security-Policy,
X-Content-Type-Options, X-Frame-Options, and Referrer-Policy. These are
plain HTTP response headers, not something that changes the JSON body of
any route, so this doesn't duplicate test_auth.py's coverage of what each
route actually returns — it only asserts the headers are present and
correctly shaped, on both a public and a protected route, and on both a
success and an error response (since the middleware wraps call_next()
universally, an error response must carry the same headers as a normal
one).
"""
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app

client = TestClient(app)


def test_public_route_has_security_headers():
    resp = client.get("/")
    assert resp.headers["X-Content-Type-Options"] == "nosniff"
    assert resp.headers["X-Frame-Options"] == "DENY"
    assert resp.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"


def test_public_route_csp_allows_self_and_google_fonts_only():
    resp = client.get("/")
    csp = resp.headers["Content-Security-Policy"]
    assert "default-src 'self'" in csp
    # No 'unsafe-inline' anywhere — inline scripts must stay blocked.
    assert "unsafe-inline" not in csp
    assert "script-src 'self'" in csp
    assert "https://fonts.googleapis.com" in csp
    assert "https://fonts.gstatic.com" in csp


def test_error_response_still_carries_security_headers(monkeypatch):
    # A 401 (missing/invalid credentials) goes through FastAPI's exception
    # handling rather than a normal route return — must not skip the
    # middleware that adds these headers.
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    resp = client.get("/api/blanks")
    assert resp.status_code == 401
    assert resp.headers["X-Content-Type-Options"] == "nosniff"
    assert resp.headers["X-Frame-Options"] == "DENY"
    assert "Content-Security-Policy" in resp.headers


def test_authenticated_route_also_has_security_headers(monkeypatch):
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    resp = client.get("/api/blanks", auth=("hr", "test123"))
    assert resp.status_code == 200
    assert resp.headers["X-Frame-Options"] == "DENY"
    assert "Content-Security-Policy" in resp.headers


def test_docs_route_is_exempt_from_strict_csp():
    # FastAPI's bundled Swagger UI loads its JS/CSS from a CDN, not from
    # this app's own origin — a strict script-src 'self' would silently
    # break the /docs page. It still gets the other, unconditional
    # headers (nosniff/frame-options/referrer-policy), just not the CSP.
    resp = client.get("/docs")
    assert resp.status_code == 200
    assert "Content-Security-Policy" not in resp.headers
    assert resp.headers["X-Content-Type-Options"] == "nosniff"
