"""
Integration test for POST /api/fill through the real HTTP layer — no
prior test exercised this route end-to-end. Also covers the fix that
made fill() async and offloaded convert_to_pdf() (a blocking LibreOffice
subprocess call) via asyncio.to_thread(), since a TestClient round-trip
is the simplest way to confirm that change didn't break anything.
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
    # Unconfigured makes _log_generation() no-op — without this, every
    # /api/fill call below would use the real .env SUPABASE_URL/KEY and
    # actually write a "Bez firmy" row into production on each test run.
    monkeypatch.setattr(settings, "SUPABASE_URL", "")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "")


def test_fill_generates_a_downloadable_document(configured_auth, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)

    resp = client.post(
        "/api/fill",
        auth=("hr", "test123"),
        json={"template_id": "dpp_template", "last_name": "Novak", "first_name": "Jan"},
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["docx_token"].endswith(".docx")
    assert (tmp_path / data["docx_token"]).exists()
    # pdf_token depends on LibreOffice being installed (it isn't in this
    # test environment), so it may legitimately be null — only its type
    # is asserted here, not a specific value.
    assert data["pdf_token"] is None or data["pdf_token"].endswith(".pdf")


@pytest.mark.parametrize("template_id", ["dpp_template", "dpc_template", "hpp_template"])
def test_fill_bundle_templates_also_generate_the_onboarding_packet(
    configured_auth, tmp_path, monkeypatch, template_id
):
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)

    resp = client.post(
        "/api/fill",
        auth=("hr", "test123"),
        json={"template_id": template_id, "last_name": "Novak", "first_name": "Jan"},
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["gdpr_docx_token"].endswith(".docx")
    assert data["zdravotni_docx_token"].endswith(".docx")
    assert data["poplatnik_pdf_token"].endswith(".pdf")
    for token in (data["gdpr_docx_token"], data["zdravotni_docx_token"], data["poplatnik_pdf_token"]):
        assert (tmp_path / token).exists()


def test_fill_non_bundle_template_has_no_packet_tokens(configured_auth, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)

    resp = client.post(
        "/api/fill",
        auth=("hr", "test123"),
        json={"template_id": "ukonceni_pracovniho_pomeru", "last_name": "Novak", "first_name": "Jan"},
    )

    assert resp.status_code == 200
    data = resp.json()
    assert "gdpr_docx_token" not in data
    assert "zdravotni_docx_token" not in data
    assert "poplatnik_pdf_token" not in data


def test_fill_rejects_unknown_template(configured_auth):
    resp = client.post(
        "/api/fill",
        auth=("hr", "test123"),
        json={"template_id": "does-not-exist"},
    )
    assert resp.status_code == 404
