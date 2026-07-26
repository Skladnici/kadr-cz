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
3. A signed link is re-downloadable by the employee — /download itself
   has no separate call-count limit — but *opening* the link (GET
   /api/podepsat/{token}, what SignPage.jsx hits on every page load) is
   capped at MAX_LINK_ACCESS_COUNT (3) visits over the link's whole
   life, signed or not (see _link_admits_new_visit/_register_link_access),
   independent of and in addition to the 24h TTL (_sign_link_is_expired)
   or the admin's own download, which deletes the row outright. Only
   that one GET route is gated by/increments this counter — the /pdf
   preview, POST .../sign, and GET .../download routes a page fires
   *after* that same GET already succeeded are deliberately not, so the
   visit whose own GET happens to be the 3rd and last one can still read,
   sign, and download within itself; only a 4th, separate visit's GET is
   refused. Signing itself IS one-time: a second POST .../sign 400s and
   never overwrites the first signature.
4. vyplatni_paska (no signature line in that template) can't get a link.
5. Expiry (_sign_link_is_expired) is checked lazily, in _fetch_sign_link,
   on whatever request happens to touch a given token — there's no
   separate scheduler, just that check plus the opportunistic sweep
   piggybacked on link creation and GET /api/sign-links/recent. The
   post-sign visit cap (#3) has no sweep at all — it's a plain read-time
   comparison, nothing to lazily delete on a timer.
"""
import base64
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app, limiter, MAX_LINK_ACCESS_COUNT

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
    assert first.headers["content-type"].startswith("application/zip")
    assert len(first.content) > 0

    # /download itself carries no separate counter — a phone dying or a
    # browser closing mid-download shouldn't cost the employee their only
    # copy. Calling it repeatedly, on its own, never trips the post-sign
    # visit cap (see the dedicated "post-sign access count cap" section
    # below) — only re-opening the link via GET /api/podepsat/{token}
    # does. Three more downloads here (well past MAX_POST_SIGN_ACCESS_
    # COUNT) all still succeed, proving that's a real distinction and not
    # just an untested assumption.
    for _ in range(3):
        again = client.get(f"/api/podepsat/{token}/download")
        assert again.status_code == 200
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


# ------------------------------------------------- link visit count cap
# See _sign_link_is_usable/_link_admits_new_visit/_register_link_access
# in main.py — a second, independent cap alongside the 24h TTL above: at
# most MAX_LINK_ACCESS_COUNT (3) visits to GET /api/podepsat/{token} over
# the link's whole life, signed or not — an unsigned link left lying
# around shouldn't be re-readable an unlimited number of times either,
# not just an already-signed one. Only that one route is gated by/
# increments the counter; /pdf, POST .../sign, and GET .../download are
# deliberately not, so the visit whose own GET happens to be the 3rd and
# last one can still read, sign, and download within itself.
# Added after a real gap was found manually testing the original
# (post-sign-only) version of this feature: the PATCH that increments
# access_count wasn't checked for failure, so a missing column (schema
# not yet migrated) failed silently and the counter always read back 0 —
# looking "fixed" indefinitely. These tests exist so a future regression
# in any direction (the cap never engaging, engaging too early within a
# single still-valid visit, or not engaging early enough pre-sign) fails
# loudly in CI instead of needing another manual production test to
# notice.

def test_pre_sign_visits_count_toward_the_same_cap(fake_supabase):
    # The core behavior change from this feature's original version:
    # opening the link to read never-signed documents now spends the
    # same budget signing/reopening always did.
    token = _create_link().json()["token"]
    for i in range(MAX_LINK_ACCESS_COUNT):
        resp = client.get(f"/api/podepsat/{token}").json()
        assert resp["valid"] is True, f"visit {i + 1} should still be within budget"

    refused = client.get(f"/api/podepsat/{token}").json()
    assert refused == {"valid": False}
    assert fake_supabase["sign_links"].rows[token]["access_count"] == MAX_LINK_ACCESS_COUNT

    # Never signed in this test at all — confirms the cap is hit purely
    # from pre-sign reads, not from anything sign-related.
    assert fake_supabase["sign_links"].rows[token]["signed_at"] is None


def test_post_sign_visits_count_toward_the_same_total_cap(fake_supabase):
    # Signing itself doesn't spend a visit (see
    # test_signing_and_downloading_work_within_the_visit_that_hits_the_cap
    # below) — but re-opening the link afterwards still draws from the
    # exact same MAX_LINK_ACCESS_COUNT budget as any pre-sign visit would.
    token = _create_link().json()["token"]
    client.post(f"/api/podepsat/{token}/sign", json={"signature_image": TINY_PNG_B64})

    for i in range(MAX_LINK_ACCESS_COUNT):
        resp = client.get(f"/api/podepsat/{token}").json()
        assert resp["valid"] is True, f"visit {i + 1} should still be within budget"

    refused = client.get(f"/api/podepsat/{token}").json()
    assert refused == {"valid": False}
    assert fake_supabase["sign_links"].rows[token]["access_count"] == MAX_LINK_ACCESS_COUNT


def test_mixed_pre_and_post_sign_visits_share_one_budget(fake_supabase):
    # Two read-only visits before ever signing, then signing on a third
    # visit, then one more re-open afterward — 4 total GETs against a
    # budget of 3 — must refuse the 4th regardless of when signing
    # happened in between.
    token = _create_link().json()["token"]
    assert client.get(f"/api/podepsat/{token}").json()["valid"] is True
    assert client.get(f"/api/podepsat/{token}").json()["valid"] is True

    sign_resp = client.post(f"/api/podepsat/{token}/sign", json={"signature_image": TINY_PNG_B64})
    assert sign_resp.status_code == 200

    assert client.get(f"/api/podepsat/{token}").json()["valid"] is True  # 3rd visit — still allowed
    assert client.get(f"/api/podepsat/{token}").json() == {"valid": False}  # 4th — refused


def test_signing_and_downloading_work_within_the_visit_that_hits_the_cap(fake_supabase):
    # The scenario the whole "only GET status increments/is gated"
    # design exists for: two prior read-only visits (budget now at
    # 2/3), then a third visit where the employee actually reads, signs,
    # and downloads — that visit's own opening GET is what brings the
    # counter to the cap (3/3), and everything that follows *within that
    # same visit* (pdf preview, sign, download) must still work. Only a
    # later, separate 4th visit gets refused.
    token = _create_link().json()["token"]
    client.get(f"/api/podepsat/{token}")
    client.get(f"/api/podepsat/{token}")

    third_visit = client.get(f"/api/podepsat/{token}").json()
    assert third_visit["valid"] is True
    assert fake_supabase["sign_links"].rows[token]["access_count"] == MAX_LINK_ACCESS_COUNT

    # doc=poplatnik rather than the default "contract" — fitz-only, no
    # LibreOffice dependency (see test_pdf_preview_poplatnik_works_for_a_
    # bundle_template's own comment), so this assertion is about the
    # visit cap, not about whether LibreOffice happens to be installed.
    preview = client.get(f"/api/podepsat/{token}/pdf?doc=poplatnik")
    assert preview.status_code == 200

    sign_resp = client.post(f"/api/podepsat/{token}/sign", json={"signature_image": TINY_PNG_B64})
    assert sign_resp.status_code == 200

    download = client.get(f"/api/podepsat/{token}/download")
    assert download.status_code == 200

    # A later, genuinely new (4th) visit is still refused.
    assert client.get(f"/api/podepsat/{token}").json() == {"valid": False}


def test_pdf_sign_and_download_are_not_directly_gated_by_the_visit_cap(fake_supabase):
    # Deliberate consequence of the design above: once the cap is
    # exhausted, reloading the actual page (GET status) is what a real
    # employee sees and gets refused with "Tento odkaz již není platný" —
    # but /pdf, sign, and download themselves don't re-check the same
    # counter (see _link_admits_new_visit's docstring for why re-checking
    # it there would break the last legitimate visit), so hitting them
    # directly, bypassing the status route, still works as long as the
    # link itself hasn't expired. Documented here so a future change
    # doesn't accidentally "fix" this into a regression.
    token = _create_link().json()["token"]
    for _ in range(MAX_LINK_ACCESS_COUNT):
        client.get(f"/api/podepsat/{token}")
    assert client.get(f"/api/podepsat/{token}").json() == {"valid": False}

    # doc=poplatnik — see the sibling test above for why not "contract".
    assert client.get(f"/api/podepsat/{token}/pdf?doc=poplatnik").status_code == 200
    sign_resp = client.post(f"/api/podepsat/{token}/sign", json={"signature_image": TINY_PNG_B64})
    assert sign_resp.status_code == 200
    assert client.get(f"/api/podepsat/{token}/download").status_code == 200


def test_admin_download_is_unaffected_by_the_employees_visit_cap(fake_supabase):
    # Deliberate scope boundary: the cap is on the EMPLOYEE opening
    # their own link, not on the admin's separate, already one-time-only
    # download route — an employee burning through their 3 visits must
    # never lock the admin out of the copy they're entitled to pull.
    token = _create_link().json()["token"]
    client.post(f"/api/podepsat/{token}/sign", json={"signature_image": TINY_PNG_B64})
    for _ in range(MAX_LINK_ACCESS_COUNT):
        client.get(f"/api/podepsat/{token}")
    assert client.get(f"/api/podepsat/{token}").json() == {"valid": False}

    admin = client.get(f"/api/sign-links/{token}/download", auth=AUTH)
    assert admin.status_code == 200


def test_access_count_cap_and_24h_ttl_are_independent(fake_supabase):
    # A link can die from either limit alone, regardless of the other —
    # this one is expired by time with access_count still at its default
    # (never even touched, since no post-sign visit happened yet).
    token = _create_link().json()["token"]
    client.post(f"/api/podepsat/{token}/sign", json={"signature_image": TINY_PNG_B64})
    _age_field(fake_supabase, token, "signed_at", 25)

    assert fake_supabase["sign_links"].rows[token].get("access_count", 0) == 0
    assert client.get(f"/api/podepsat/{token}").json() == {"valid": False}


def test_pdf_preview_rejects_unknown_doc_key(fake_supabase):
    token = _create_link().json()["token"]
    resp = client.get(f"/api/podepsat/{token}/pdf?doc=nonsense")
    assert resp.status_code == 404


def test_pdf_preview_rejects_bundle_doc_for_non_bundle_template(fake_supabase):
    # ukonceni_pracovniho_pomeru is signable (has its own contract
    # signature line) but never gets the GDPR/health/tax bundle — see
    # BUNDLE_TEMPLATE_IDS.
    token = _create_link(template_id="ukonceni_pracovniho_pomeru").json()["token"]
    resp = client.get(f"/api/podepsat/{token}/pdf?doc=gdpr")
    assert resp.status_code == 404


def test_pdf_preview_poplatnik_works_for_a_bundle_template(fake_supabase):
    # poplatnik doesn't need LibreOffice (fitz overlays directly onto the
    # source PDF — see pdf_fill.py), so unlike contract/gdpr/zdravotni
    # this is testable end-to-end even without LibreOffice installed.
    token = _create_link().json()["token"]
    resp = client.get(f"/api/podepsat/{token}/pdf?doc=poplatnik")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/pdf")
    assert resp.content.startswith(b"%PDF")
