"""
/api/companies had zero test coverage beyond "requires auth" (see
test_auth.py::test_companies_route_requires_auth) — nothing had ever
exercised list/create/update/delete against the actual Supabase-proxying
logic in main.py. That matters here specifically because the frontend
(CompanyPicker.jsx) relies on the server round-trip to reflect changes
without a page reload: after a save/delete it calls loadCompanies(force=
True) and trusts that a subsequent GET reflects the mutation it just
made. A bug in _supabase_companies_request's method/params/json wiring
(wrong filter, wrong body, swallowed response) would silently break that
"no F5 needed" behavior while every existing test still passed.

Supabase itself isn't run locally, so httpx.AsyncClient.request is
monkeypatched to an in-memory fake that mimics PostgREST's relevant
behavior (?select=&order= on GET, id=eq.<id> filters on PATCH/DELETE,
Prefer: return=representation on POST/PATCH) closely enough to prove the
endpoint's own logic — not Supabase's — is correct.
"""
import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app

client = TestClient(app)


class FakeCompaniesTable:
    """Mimics just enough of PostgREST's /companies resource for these
    tests: GET (?select=*&order=name.asc), POST, PATCH ?id=eq.<id>,
    DELETE ?id=eq.<id>."""

    def __init__(self):
        self.rows = []
        self._next_id = 1

    def handle(self, method, params, json_body):
        params = params or {}
        if method == "GET":
            return 200, sorted(self.rows, key=lambda r: r["name"])
        if method == "POST":
            new_row = {"id": str(self._next_id), **json_body}
            self._next_id += 1
            self.rows.append(new_row)
            return 201, [new_row]
        if method in ("PATCH", "DELETE"):
            target_id = params["id"].removeprefix("eq.")
            match = next((r for r in self.rows if r["id"] == target_id), None)
            if method == "DELETE":
                if match:
                    self.rows.remove(match)
                return 204, []
            if match:
                match.update(json_body)
                return 200, [match]
            return 200, []
        raise AssertionError(f"unexpected method {method}")


@pytest.fixture
def fake_supabase(monkeypatch):
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://fake.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "fake-anon-key")

    table = FakeCompaniesTable()

    async def fake_request(self, method, url, *, headers=None, params=None, json=None):
        status, body = table.handle(method, params, json)
        return httpx.Response(status, json=body, request=httpx.Request(method, url))

    monkeypatch.setattr(httpx.AsyncClient, "request", fake_request)
    return table


AUTH = ("hr", "test123")


def test_list_starts_empty(fake_supabase):
    resp = client.get("/api/companies", auth=AUTH)
    assert resp.status_code == 200
    assert resp.json() == []


def test_created_company_immediately_appears_in_list(fake_supabase):
    create_resp = client.post(
        "/api/companies", auth=AUTH,
        json={"name": "ACME s.r.o.", "ico": "27074358", "dic": "CZ27074358"},
    )
    assert create_resp.status_code == 201
    created = create_resp.json()
    assert created["name"] == "ACME s.r.o."
    assert "id" in created

    list_resp = client.get("/api/companies", auth=AUTH)
    assert [c["name"] for c in list_resp.json()] == ["ACME s.r.o."]


def test_updated_company_is_reflected_on_next_list_fetch(fake_supabase):
    created = client.post(
        "/api/companies", auth=AUTH, json={"name": "Old Name", "ico": "27074358"},
    ).json()

    update_resp = client.put(
        f"/api/companies/{created['id']}", auth=AUTH,
        json={"name": "New Name", "ico": "27074358"},
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["name"] == "New Name"

    # This is exactly the round-trip CompanyPicker.jsx's handleSaveCurrent
    # relies on: PUT succeeds, then loadCompanies(force=True) re-fetches
    # and must see the update, not the stale pre-edit row.
    list_resp = client.get("/api/companies", auth=AUTH)
    names = [c["name"] for c in list_resp.json()]
    assert names == ["New Name"], f"stale data still in list: {names}"


def test_deleted_company_disappears_from_list(fake_supabase):
    created = client.post("/api/companies", auth=AUTH, json={"name": "Temp Co"}).json()
    other = client.post("/api/companies", auth=AUTH, json={"name": "Keep Co"}).json()

    delete_resp = client.delete(f"/api/companies/{created['id']}", auth=AUTH)
    assert delete_resp.status_code == 204

    list_resp = client.get("/api/companies", auth=AUTH)
    names = [c["name"] for c in list_resp.json()]
    assert names == ["Keep Co"], f"deleted company still present, or wrong row removed: {names}"


# "Sdílené firmy se nepodařilo načíst" was reported as an intermittent,
# unreproducible frontend error. Before _supabase_companies_request wrapped
# the httpx call in a try/except, a network-level failure here (simulated
# below by monkeypatching httpx.AsyncClient.request to raise, the same way
# a real DNS hiccup or a bad SUPABASE_URL would) propagated as an unhandled
# exception: Starlette's default error middleware turned it into a bare 500
# with no detail, logged outside our configured format — invisible in
# Render logs. These prove both halves of the fix: the client gets a
# specific status + message instead of a blank 500, and the failure is
# actually captured by `logging` (caplog only sees records that went
# through the `logging` module, so this also confirms nothing here is
# silently print()'d or swallowed).
def test_network_error_returns_502_and_is_logged(monkeypatch, fake_supabase, caplog):
    async def raise_connect_error(self, method, url, *, headers=None, params=None, json=None):
        raise httpx.ConnectError("[Errno 11001] getaddrinfo failed", request=httpx.Request(method, url))

    monkeypatch.setattr(httpx.AsyncClient, "request", raise_connect_error)

    with caplog.at_level("ERROR"):
        resp = client.get("/api/companies", auth=AUTH)

    assert resp.status_code == 502
    assert "ConnectError" in resp.json()["detail"]
    assert any("NETWORK ERROR" in r.message and "ConnectError" in r.message for r in caplog.records)


def test_timeout_returns_504_and_is_logged(monkeypatch, fake_supabase, caplog):
    async def raise_timeout(self, method, url, *, headers=None, params=None, json=None):
        raise httpx.ConnectTimeout("timed out", request=httpx.Request(method, url))

    monkeypatch.setattr(httpx.AsyncClient, "request", raise_timeout)

    with caplog.at_level("ERROR"):
        resp = client.get("/api/companies", auth=AUTH)

    assert resp.status_code == 504
    assert "timeout" in resp.json()["detail"].lower()
    assert any("TIMEOUT" in r.message for r in caplog.records)
