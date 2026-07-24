"""
Coverage for the employee e-signature flow: POST /api/sign-links (admin,
creates a token), the public /api/podepsat/{token}* routes an employee
uses without any login, and the admin's own /api/sign-links/{token}/download.

Supabase isn't run locally, so httpx.AsyncClient.request is monkeypatched
to an in-memory fake covering the two REST resources this flow touches
(sign_links, generation_log) — same approach as test_stats_endpoint.py's
FakeGenerationLog, extended here with a FakeSignLinks counterpart and a
combined dispatcher.

What actually matters here, beyond "the routes return 200":
1. The token is the only thing gating the public routes — they work with
   no Authorization header at all, and a wrong/unknown token 404s.
2. Signing propagates into generation_log's signed_at via the exact same
   _apply_signed_status() helper the admin's manual dot-click uses (see
   main.py's own comment on why that's intentional, not a duplicate
   mechanism) — GET /api/stats must reflect it.
3. employee_downloaded_at makes the link unusable for the employee after
   one successful download, but never for the admin's own separate
   re-download route.
4. vyplatni_paska (no signature line in that template) can't get a link.
"""
import base64

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app, limiter

client = TestClient(app)

AUTH = ("hr", "test123")

# A real 1x1 PNG — submit_signature() base64-decodes and validates it,
# and render_signed_contract() feeds it to docxtpl's InlineImage, so a
# fake non-image string wouldn't exercise the same code path.
TINY_PNG_B64 = base64.b64encode(base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)).decode()


@pytest.fixture(autouse=True)
def reset_limiter():
    limiter.reset()
    yield
    limiter.reset()


class FakeSignLinks:
    def __init__(self):
        self.rows: dict[str, dict] = {}

    def insert(self, json_body):
        row = {**json_body}
        row.setdefault("signature_image", None)
        row.setdefault("signed_at", None)
        row.setdefault("employee_downloaded_at", None)
        self.rows[row["token"]] = row
        return 201, [row]

    def _token_from_params(self, params):
        raw = (params or {}).get("token", "")
        return raw[len("eq."):] if raw.startswith("eq.") else raw

    def select(self, params):
        row = self.rows.get(self._token_from_params(params))
        return 200, ([row] if row else [])

    def patch(self, params, json_body):
        row = self.rows.get(self._token_from_params(params))
        if row is None:
            return 200, []
        row.update(json_body)
        return 200, [row]


class FakeGenerationLog:
    def __init__(self):
        self.rows = []

    def insert(self, json_body):
        row = {**json_body}
        row.setdefault("signed_at", None)
        self.rows.append(row)
        return 201, [row]

    def stats(self):
        counts, all_signed = {}, {}
        for row in self.rows:
            name = row.get("company_name") or "Bez firmy"
            counts[name] = counts.get(name, 0) + 1
            all_signed[name] = all_signed.get(name, True) and row.get("signed_at") is not None
        rows = [{"company_name": n, "document_count": c, "all_signed": all_signed[n]} for n, c in counts.items()]
        rows.sort(key=lambda r: -r["document_count"])
        return 200, rows

    def patch_signed(self, params, json_body):
        employee_filter = (params or {}).get("employee_name", "")
        employee_name = employee_filter[len("eq."):] if employee_filter.startswith("eq.") else None
        or_filter = (params or {}).get("or")
        company_filter = (params or {}).get("company_name")
        for row in self.rows:
            if employee_name is not None and row.get("employee_name") != employee_name:
                continue
            if or_filter is not None:
                if not (row.get("company_name") is None or row.get("company_name") == "Bez firmy"):
                    continue
            elif company_filter is not None:
                target = company_filter[len("eq."):] if company_filter.startswith("eq.") else company_filter
                if row.get("company_name") != target:
                    continue
            row["signed_at"] = json_body.get("signed_at")
        return 200, []


@pytest.fixture
def fake_supabase(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://fake.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "fake-anon-key")
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)

    sign_links = FakeSignLinks()
    gen_log = FakeGenerationLog()

    async def fake_request(self, method, url, *, headers=None, params=None, json=None, **_ignored):
        if url.endswith("/sign_links"):
            if method == "POST":
                status, body = sign_links.insert(json)
            elif method == "GET":
                status, body = sign_links.select(params)
            elif method == "PATCH":
                status, body = sign_links.patch(params, json)
            else:
                raise AssertionError(f"unexpected method for sign_links: {method}")
        elif url.endswith("/generation_log"):
            if method == "POST":
                status, body = gen_log.insert(json)
            elif method == "PATCH":
                status, body = gen_log.patch_signed(params, json)
            else:
                raise AssertionError(f"unexpected method for generation_log: {method}")
        elif url.endswith("/generation_stats"):
            assert method == "GET"
            status, body = gen_log.stats()
        else:
            raise AssertionError(f"unexpected Supabase URL: {url}")
        return httpx.Response(status, json=body, request=httpx.Request(method, url))

    monkeypatch.setattr(httpx.AsyncClient, "request", fake_request)
    return {"sign_links": sign_links, "gen_log": gen_log}


def _create_link(template_id="dpp_template", company_name="ACME s.r.o.", first_name="Jan", last_name="Novak"):
    return client.post(
        "/api/sign-links", auth=AUTH,
        json={
            "template_id": template_id, "company_name": company_name,
            "first_name": first_name, "last_name": last_name,
        },
    )


def test_create_sign_link_returns_a_token(fake_supabase):
    resp = _create_link()
    assert resp.status_code == 200
    token = resp.json()["token"]
    assert len(token) == 32  # uuid4().hex


def test_payslip_template_cannot_get_a_sign_link(fake_supabase):
    resp = _create_link(template_id="vyplatni_paska")
    assert resp.status_code == 400


def test_public_status_route_works_with_no_authorization_header(fake_supabase):
    token = _create_link().json()["token"]
    # Deliberately no `auth=` kwarg — this is the whole point of the flow.
    resp = client.get(f"/api/podepsat/{token}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["valid"] is True
    assert data["company_name"] == "ACME s.r.o."
    assert data["employee_name"] == "Jan Novak"
    assert data["signed"] is False


def test_unknown_token_is_reported_invalid_not_500(fake_supabase):
    resp = client.get("/api/podepsat/does-not-exist")
    assert resp.status_code == 200
    assert resp.json() == {"valid": False}


def test_sign_then_download_then_second_download_is_refused(fake_supabase):
    token = _create_link().json()["token"]

    # Can't download before signing.
    assert client.get(f"/api/podepsat/{token}/download").status_code == 400

    sign = client.post(f"/api/podepsat/{token}/sign", json={"signature_image": TINY_PNG_B64})
    assert sign.status_code == 200

    status = client.get(f"/api/podepsat/{token}").json()
    assert status["signed"] is True

    first = client.get(f"/api/podepsat/{token}/download")
    assert first.status_code == 200
    assert first.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    assert len(first.content) > 0

    # One-time: the exact same token is now dead for the employee.
    second = client.get(f"/api/podepsat/{token}/download")
    assert second.status_code == 404
    assert client.get(f"/api/podepsat/{token}").json() == {"valid": False}


def test_signing_marks_the_person_signed_in_stats(fake_supabase):
    # Issue the real request first, *then* seed a generation_log row
    # directly on the fake — not the other way around. (Mutating the fake
    # before this test's first TestClient call was observed to hang this
    # test's own function-scoped event loop in this environment; every
    # other test in this file makes its first move a real request, and
    # none of them showed the issue.)
    token = _create_link().json()["token"]
    fake_supabase["gen_log"].insert({
        "company_name": "ACME s.r.o.", "employee_name": "Jan Novak", "document_type": "DPP",
    })
    assert client.get("/api/stats", auth=AUTH).json()[0]["all_signed"] is False

    client.post(f"/api/podepsat/{token}/sign", json={"signature_image": TINY_PNG_B64})

    assert client.get("/api/stats", auth=AUTH).json()[0]["all_signed"] is True


def test_admin_can_redownload_after_employee_used_their_one_time_link(fake_supabase):
    token = _create_link().json()["token"]
    client.post(f"/api/podepsat/{token}/sign", json={"signature_image": TINY_PNG_B64})
    assert client.get(f"/api/podepsat/{token}/download").status_code == 200
    # Employee's token is now spent...
    assert client.get(f"/api/podepsat/{token}/download").status_code == 404

    # ...but the admin's own route is unaffected by that.
    admin = client.get(f"/api/sign-links/{token}/download", auth=AUTH)
    assert admin.status_code == 200
    assert len(admin.content) > 0

    # And works again a second time too — it's not one-time for the admin.
    admin2 = client.get(f"/api/sign-links/{token}/download", auth=AUTH)
    assert admin2.status_code == 200


def test_admin_download_requires_site_auth(fake_supabase):
    token = _create_link().json()["token"]
    client.post(f"/api/podepsat/{token}/sign", json={"signature_image": TINY_PNG_B64})
    resp = client.get(f"/api/sign-links/{token}/download")  # no auth=
    assert resp.status_code == 401


def test_admin_download_before_signing_is_rejected(fake_supabase):
    token = _create_link().json()["token"]
    resp = client.get(f"/api/sign-links/{token}/download", auth=AUTH)
    assert resp.status_code == 400


def test_sign_rejects_invalid_image_payload(fake_supabase):
    token = _create_link().json()["token"]
    resp = client.post(f"/api/podepsat/{token}/sign", json={"signature_image": "not-base64!!!"})
    assert resp.status_code == 400
    # Nothing should have been marked signed.
    assert client.get(f"/api/podepsat/{token}").json()["signed"] is False


def test_creating_a_sign_link_requires_site_auth(fake_supabase):
    resp = client.post(
        "/api/sign-links",
        json={"template_id": "dpp_template", "company_name": "ACME s.r.o.", "first_name": "Jan", "last_name": "Novak"},
    )
    assert resp.status_code == 401


def test_podepsat_routes_503_when_supabase_is_unconfigured(monkeypatch):
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    monkeypatch.setattr(settings, "SUPABASE_URL", "")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "")

    assert client.get("/api/podepsat/anything").status_code == 503
    assert client.post("/api/podepsat/anything/sign", json={"signature_image": TINY_PNG_B64}).status_code == 503
    assert client.get("/api/podepsat/anything/download").status_code == 503
