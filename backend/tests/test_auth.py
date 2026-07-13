"""
Regression tests for the site-wide HTTP Basic Auth gate. Covers the
behavior manually verified with curl while building it: every /api/*
route requires SITE_USERNAME/SITE_PASSWORD, GET / is the one public
route and always sends Clear-Site-Data, and a missing server-side
config degrades to 503 rather than silently allowing everyone through.
"""
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app

client = TestClient(app)


@pytest.fixture
def configured_auth(monkeypatch):
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")


@pytest.fixture
def unconfigured_auth(monkeypatch):
    monkeypatch.setattr(settings, "SITE_USERNAME", "")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "")


def test_root_is_public_and_sends_clear_site_data():
    resp = client.get("/")
    assert resp.status_code == 200
    assert resp.headers["clear-site-data"] == '"credentials"'


def test_protected_route_rejects_missing_credentials(configured_auth):
    resp = client.get("/api/blanks")
    assert resp.status_code == 401


def test_protected_route_rejects_wrong_credentials(configured_auth):
    resp = client.get("/api/blanks", auth=("hr", "wrong"))
    assert resp.status_code == 401


def test_protected_route_accepts_correct_credentials(configured_auth):
    resp = client.get("/api/blanks", auth=("hr", "test123"))
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


def test_protected_route_503s_when_server_has_no_credentials_configured(unconfigured_auth):
    resp = client.get("/api/blanks", auth=("anyone", "anything"))
    assert resp.status_code == 503


def test_download_route_requires_auth_before_checking_file_existence(configured_auth):
    # Auth must be enforced even for a filename that doesn't exist — the
    # response should be 401, not a 404 that would let an anonymous
    # request distinguish "wrong password" from "no such file".
    resp = client.get("/api/download/does-not-exist.docx")
    assert resp.status_code == 401


def test_companies_route_requires_auth(configured_auth):
    resp = client.get("/api/companies")
    assert resp.status_code == 401
