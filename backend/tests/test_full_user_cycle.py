"""
End-to-end regression test for the real user journey, driven entirely
through HTTP (TestClient) rather than calling internal functions directly
— login -> upload a document photo -> recognize -> fill a blank with the
recognized + company fields -> download the generated file -> confirm the
download token is single-use. Every prior test exercised these endpoints
in isolation (or not at all, for /api/companies); nothing had previously
proven the handoff between them actually works — e.g. that the field
names /api/recognize returns line up with what FillRequest accepts.
"""
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app

client = TestClient(app)

# Smallest possible valid JPEG (1x1 pixel) — content doesn't matter here,
# OCR_MODE=mock means recognize_document() never actually looks at it.
_TINY_JPEG = (
    b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    b"\xff\xdb\x00C\x00" + b"\x01" * 64 + b"\xff\xd9"
)


def test_full_cycle_upload_recognize_fill_download(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    monkeypatch.setattr(settings, "OCR_MODE", "mock")
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)
    monkeypatch.setattr(settings, "UPLOAD_DIR", tmp_path)
    # This test isn't about stats logging — it only cares that the
    # upload -> fill -> download handoff works. Leaving SUPABASE_URL/KEY
    # at their real .env values would make _log_generation() actually
    # POST this test's "ACME s.r.o." fill into the real production
    # generation_log table on every run (this is exactly how that table
    # accumulated test rows before). Unconfigured means _log_generation()
    # no-ops, same as test_fill_succeeds_without_logging_when_supabase_is_unconfigured
    # in test_stats_endpoint.py.
    monkeypatch.setattr(settings, "SUPABASE_URL", "")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "")
    auth = ("hr", "test123")

    # Step 1: log in / list available blanks (what LoginForm's probe hits).
    blanks_resp = client.get("/api/blanks", auth=auth)
    assert blanks_resp.status_code == 200
    template_id = blanks_resp.json()[0]["id"]

    # Step 2: upload a document photo.
    recognize_resp = client.post(
        "/api/recognize",
        auth=auth,
        files={"file": ("passport.jpg", _TINY_JPEG, "image/jpeg")},
    )
    assert recognize_resp.status_code == 200
    recognized = recognize_resp.json()
    assert recognized["ocr_mode"] == "mock"
    assert recognized["first_name"] and recognized["last_name"]

    # Step 3: fill the chosen blank with the recognized person + manually
    # entered company fields (mirrors applyRecognizedResults + CompanyPicker
    # in SimpleDocFiller.jsx — the recognized fields feed straight into the
    # /api/fill payload alongside fields the user typed).
    fill_resp = client.post(
        "/api/fill",
        auth=auth,
        json={
            "template_id": template_id,
            "first_name": recognized["first_name"],
            "last_name": recognized["last_name"],
            "birth_date": recognized["birth_date"],
            "doc_number": recognized["doc_number"],
            "company_name": "ACME s.r.o.",
            "company_ico": "27074358",
            "company_dic": "CZ27074358",
        },
    )
    assert fill_resp.status_code == 200
    tokens = fill_resp.json()
    assert tokens["docx_token"].endswith(".docx")
    assert (tmp_path / tokens["docx_token"]).exists()

    # Step 4: download the generated document.
    download_resp = client.get(f"/api/download/{tokens['docx_token']}", auth=auth)
    assert download_resp.status_code == 200
    assert download_resp.headers["content-type"] == (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    assert not (tmp_path / tokens["docx_token"]).exists(), (
        "file should be deleted server-side immediately after being served"
    )

    # Step 5: a second download of the same token must not silently
    # re-serve stale content — the file is gone, so this must 404 (this is
    # exactly what SimpleDocFiller.jsx's handleDownload() turns into the
    # "tento odkaz už byl použit" message instead of a raw browser error).
    repeat_download_resp = client.get(f"/api/download/{tokens['docx_token']}", auth=auth)
    assert repeat_download_resp.status_code == 404
