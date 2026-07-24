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
3. A signed link is re-downloadable by the employee any number of times
   (not one-time) — what actually ends its life is the 24h TTL
   (_sign_link_is_expired) or the admin's own download, which deletes the
   row outright. Signing itself, though, IS one-time: a second
   POST .../sign 400s and never overwrites the first signature.
4. vyplatni_paska (no signature line in that template) can't get a link.
5. Expiry (_sign_link_is_expired) is checked lazily, in _fetch_sign_link,
   on whatever request happens to touch a given token — there's no
   separate scheduler, just that check plus the opportunistic sweep
   piggybacked on link creation and GET /api/sign-links/recent.
"""
import base64
from datetime import datetime, timedelta, timezone

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
        # Real Supabase sets this via `default now()` — the fake has to
        # supply its own, since _sign_link_is_expired reads it for any
        # never-signed row.
        row.setdefault("created_at", datetime.now(timezone.utc).isoformat())
        self.rows[row["token"]] = row
        return 201, [row]

    def _token_from_params(self, params):
        raw = (params or {}).get("token", "")
        return raw[len("eq."):] if raw.startswith("eq.") else raw

    def select(self, params):
        params = params or {}
        if "token" in params:
            row = self.rows.get(self._token_from_params(params))
            return 200, ([row] if row else [])
        # GET /api/sign-links/recent's query shape: signed_at=gt.<cutoff>,
        # order=signed_at.desc, limit=... — mirrors main.py's own filter
        # closely enough to prove it builds the right query, not a general
        # PostgREST filter parser. A plain `gt` comparison already excludes
        # NULL signed_at (SQL semantics), same as main.py relies on.
        signed_at_filter = params.get("signed_at", "")
        assert signed_at_filter.startswith("gt."), params
        cutoff = signed_at_filter[len("gt."):]
        rows = [r for r in self.rows.values() if r.get("signed_at") and r["signed_at"] > cutoff]
        rows.sort(key=lambda r: r["signed_at"], reverse=True)
        limit = int(params.get("limit", len(rows)))
        return 200, rows[:limit]

    def patch(self, params, json_body):
        row = self.rows.get(self._token_from_params(params))
        if row is None:
            return 200, []
        row.update(json_body)
        return 200, [row]

    def delete(self, params):
        params = params or {}
        if "token" in params:
            self.rows.pop(self._token_from_params(params), None)
            return 200, []
        # _cleanup_expired_sign_links's two compound filters — mirrors
        # main.py's own PostgREST "and=(...)" syntax closely enough to
        # prove it builds the right query, not a general filter parser.
        parts = params.get("and", "").strip("()").split(",")
        assert parts, params
        for token in list(self.rows):
            row = self.rows[token]
            matches = True
            for part in parts:
                if part == "signed_at.not.is.null":
                    matches = matches and bool(row.get("signed_at"))
                elif part == "signed_at.is.null":
                    matches = matches and not row.get("signed_at")
                elif part.startswith("signed_at.lte."):
                    cutoff = part[len("signed_at.lte."):]
                    matches = matches and bool(row.get("signed_at")) and row["signed_at"] <= cutoff
                elif part.startswith("created_at.lte."):
                    cutoff = part[len("created_at.lte."):]
                    matches = matches and row["created_at"] <= cutoff
                else:
                    raise AssertionError(f"unexpected and-filter part: {part!r}")
            if matches:
                del self.rows[token]
        return 200, []


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
            elif method == "DELETE":
                status, body = sign_links.delete(params)
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


def test_employee_can_download_multiple_times_after_signing(fake_supabase):
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

    # Not one-time for the employee anymore — a phone dying or a browser
    # closing mid-download shouldn't cost them their only copy. What
    # actually ends the link is the 24h TTL or the admin's own download.
    second = client.get(f"/api/podepsat/{token}/download")
    assert second.status_code == 200
    assert client.get(f"/api/podepsat/{token}").json()["signed"] is True


def test_revisiting_after_signing_shows_signed_not_a_blank_form(fake_supabase):
    # What SignPage.jsx polls on every load — must keep saying "signed",
    # not flip back to an unsigned/blank state or report the link as dead,
    # so a repeat visit shows the download screen, never the signing form
    # again.
    token = _create_link().json()["token"]
    client.post(f"/api/podepsat/{token}/sign", json={"signature_image": TINY_PNG_B64})

    status = client.get(f"/api/podepsat/{token}").json()
    assert status == {
        "valid": True, "signed": True,
        "company_name": "ACME s.r.o.", "employee_name": "Jan Novak", "template_id": "dpp_template",
    }


def test_signing_twice_is_rejected(fake_supabase):
    token = _create_link().json()["token"]
    first = client.post(f"/api/podepsat/{token}/sign", json={"signature_image": TINY_PNG_B64})
    assert first.status_code == 200

    second = client.post(f"/api/podepsat/{token}/sign", json={"signature_image": TINY_PNG_B64})
    assert second.status_code == 400

    # Rejecting the second attempt doesn't undo the first.
    assert client.get(f"/api/podepsat/{token}").json()["signed"] is True


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


def test_admin_download_deletes_the_link_for_everyone(fake_supabase):
    token = _create_link().json()["token"]
    client.post(f"/api/podepsat/{token}/sign", json={"signature_image": TINY_PNG_B64})
    # Employee already has their own copy — doesn't affect what happens next.
    assert client.get(f"/api/podepsat/{token}/download").status_code == 200

    admin = client.get(f"/api/sign-links/{token}/download", auth=AUTH)
    assert admin.status_code == 200
    assert len(admin.content) > 0

    # One-time for the admin too now: the row is gone, for everyone.
    admin_again = client.get(f"/api/sign-links/{token}/download", auth=AUTH)
    assert admin_again.status_code == 404
    assert client.get(f"/api/podepsat/{token}").json() == {"valid": False}
    assert client.get(f"/api/podepsat/{token}/download").status_code == 404


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


# --------------------------------------------- Recent signings (notifier)

def test_recent_signed_links_start_empty(fake_supabase):
    resp = client.get("/api/sign-links/recent", auth=AUTH)
    assert resp.status_code == 200
    assert resp.json() == []


def test_recent_signed_links_excludes_unsigned_links(fake_supabase):
    _create_link()  # never signed
    resp = client.get("/api/sign-links/recent", auth=AUTH)
    assert resp.status_code == 200
    assert resp.json() == []


def test_recent_signed_links_includes_a_signed_one(fake_supabase):
    token = _create_link(company_name="ACME s.r.o.", first_name="Jan", last_name="Novak").json()["token"]
    client.post(f"/api/podepsat/{token}/sign", json={"signature_image": TINY_PNG_B64})

    resp = client.get("/api/sign-links/recent", auth=AUTH)
    assert resp.status_code == 200
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["token"] == token
    assert rows[0]["company_name"] == "ACME s.r.o."
    assert rows[0]["employee_name"] == "Jan Novak"
    assert rows[0]["signed_at"] is not None


def test_recent_signed_links_orders_newest_first(fake_supabase):
    import time

    token1 = _create_link(first_name="First", last_name="Person").json()["token"]
    client.post(f"/api/podepsat/{token1}/sign", json={"signature_image": TINY_PNG_B64})
    time.sleep(0.01)
    token2 = _create_link(first_name="Second", last_name="Person").json()["token"]
    client.post(f"/api/podepsat/{token2}/sign", json={"signature_image": TINY_PNG_B64})

    rows = client.get("/api/sign-links/recent", auth=AUTH).json()
    assert [r["token"] for r in rows] == [token2, token1]


def test_recent_signed_links_requires_site_auth(fake_supabase):
    resp = client.get("/api/sign-links/recent")
    assert resp.status_code == 401


def test_recent_signed_links_503s_when_supabase_is_unconfigured(monkeypatch):
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    monkeypatch.setattr(settings, "SUPABASE_URL", "")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "")

    resp = client.get("/api/sign-links/recent", auth=AUTH)
    assert resp.status_code == 503


# --------------------------------------------------- 24h TTL / expiry

def _age_field(fake_supabase, token, field, hours_ago):
    fake_supabase["sign_links"].rows[token][field] = (
        datetime.now(timezone.utc) - timedelta(hours=hours_ago)
    ).isoformat()


def test_unsigned_link_expires_24h_after_creation(fake_supabase):
    token = _create_link().json()["token"]
    _age_field(fake_supabase, token, "created_at", 25)

    assert client.get(f"/api/podepsat/{token}").json() == {"valid": False}
    # Lazily deleted by that same fetch.
    assert token not in fake_supabase["sign_links"].rows


def test_unsigned_link_within_24h_is_still_valid(fake_supabase):
    token = _create_link().json()["token"]
    _age_field(fake_supabase, token, "created_at", 1)

    assert client.get(f"/api/podepsat/{token}").json()["valid"] is True
    assert token in fake_supabase["sign_links"].rows


def test_signed_link_expires_24h_after_signing_even_if_never_downloaded(fake_supabase):
    token = _create_link().json()["token"]
    client.post(f"/api/podepsat/{token}/sign", json={"signature_image": TINY_PNG_B64})
    _age_field(fake_supabase, token, "signed_at", 25)

    assert client.get(f"/api/podepsat/{token}").json() == {"valid": False}
    assert token not in fake_supabase["sign_links"].rows


def test_signed_link_within_24h_of_signing_is_still_valid_even_if_created_long_ago(fake_supabase):
    # The 24h clock restarts at signed_at, not created_at, once signed —
    # an old, slow-to-be-signed link shouldn't die the instant it's
    # finally signed.
    token = _create_link().json()["token"]
    _age_field(fake_supabase, token, "created_at", 23)
    client.post(f"/api/podepsat/{token}/sign", json={"signature_image": TINY_PNG_B64})

    status = client.get(f"/api/podepsat/{token}").json()
    assert status["valid"] is True
    assert status["signed"] is True


def test_recent_signed_links_sweeps_an_expired_signed_entry(fake_supabase):
    token = _create_link().json()["token"]
    client.post(f"/api/podepsat/{token}/sign", json={"signature_image": TINY_PNG_B64})
    _age_field(fake_supabase, token, "signed_at", 25)

    rows = client.get("/api/sign-links/recent", auth=AUTH).json()
    assert rows == []
    # GET /api/sign-links/recent's own opportunistic sweep should have
    # deleted it too, not just excluded it from this one response.
    assert token not in fake_supabase["sign_links"].rows


def test_creating_a_link_sweeps_an_expired_unsigned_one(fake_supabase):
    stale_token = _create_link(first_name="Stale", last_name="One").json()["token"]
    _age_field(fake_supabase, stale_token, "created_at", 25)

    _create_link(first_name="Fresh", last_name="One")  # triggers the sweep as a side effect

    assert stale_token not in fake_supabase["sign_links"].rows
