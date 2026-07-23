"""
GET /api/stats and the generation-logging side effect of POST /api/fill
had zero test coverage. Two things matter here specifically:

1. _log_generation's company_name normalization (None/""/whitespace all
   collapse to the same "Bez firmy" bucket the generation_stats view
   would produce via coalesce()) — get this wrong and the widget splits
   what should be one bucket into several, or shows a stray blank entry.
2. A successful /api/fill must never turn into a failure because
   logging failed — Supabase being unconfigured, or the insert itself
   erroring, has to be silently swallowed.

Supabase itself isn't run locally, so httpx.AsyncClient.request is
monkeypatched to an in-memory fake that mimics the two REST resources
_log_generation/get_stats actually touch (POST generation_log, GET
generation_stats) closely enough to prove main.py's own logic — not
Supabase's — is correct. The fake's stats() aggregation intentionally
mirrors create_generation_log_table.sql's view definition (coalesce to
"Bez firmy", order by count desc).
"""
import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app, limiter

client = TestClient(app)

AUTH = ("hr", "test123")


@pytest.fixture(autouse=True)
def reset_limiter():
    # /api/fill is capped at 10/minute (see test_rate_limiting.py) — this
    # file calls it repeatedly across several tests, which would
    # otherwise inherit leftover hit counts from whatever ran earlier in
    # the same minute and start failing with 429s unrelated to what's
    # actually being tested here.
    limiter.reset()
    yield
    limiter.reset()


class FakeGenerationLog:
    def __init__(self):
        self.rows = []  # each: {"company_name": str|None, "employee_name": str|None, "document_type": str, "signed_at": str|None}

    def insert(self, json_body):
        row = {**json_body}
        row.setdefault("signed_at", None)  # matches the table's default — signed_at is never set at insert time
        self.rows.append(row)
        return 201, [row]

    def stats(self):
        counts = {}
        all_signed = {}
        for row in self.rows:
            name = row.get("company_name") or "Bez firmy"
            counts[name] = counts.get(name, 0) + 1
            all_signed[name] = all_signed.get(name, True) and row.get("signed_at") is not None
        rows = [
            {"company_name": name, "document_count": n, "all_signed": all_signed[name]}
            for name, n in counts.items()
        ]
        rows.sort(key=lambda r: -r["document_count"])
        return 200, rows

    def stats_by_type(self):
        counts = {}
        for row in self.rows:
            name = row.get("company_name") or "Bez firmy"
            doc_type = row["document_type"]
            key = (name, doc_type)
            counts[key] = counts.get(key, 0) + 1
        rows = [
            {"company_name": name, "document_type": doc_type, "document_count": n}
            for (name, doc_type), n in counts.items()
        ]
        rows.sort(key=lambda r: (r["company_name"], -r["document_count"]))
        return 200, rows

    def stats_by_person(self):
        counts = {}
        all_signed = {}
        for row in self.rows:
            person = (row.get("employee_name") or "").strip()
            if not person:
                continue
            name = row.get("company_name") or "Bez firmy"
            key = (name, person)
            counts[key] = counts.get(key, 0) + 1
            all_signed[key] = all_signed.get(key, True) and row.get("signed_at") is not None
        rows = [
            {"company_name": name, "employee_name": person, "document_count": n, "all_signed": all_signed[(name, person)]}
            for (name, person), n in counts.items()
        ]
        rows.sort(key=lambda r: (r["company_name"], r["employee_name"]))
        return 200, rows

    def patch_signed(self, params, json_body):
        # Mirrors set_signed_status()'s own filter construction closely
        # enough to prove main.py builds the right PostgREST query — not
        # a general-purpose PostgREST filter parser.
        employee_filter = params.get("employee_name", "")
        employee_name = employee_filter[len("eq."):] if employee_filter.startswith("eq.") else None
        or_filter = params.get("or")
        company_filter = params.get("company_name")
        updated = []
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
            updated.append(row)
        return 200, updated


@pytest.fixture
def fake_supabase(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://fake.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "fake-anon-key")
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)

    log = FakeGenerationLog()

    async def fake_request(self, method, url, *, headers=None, params=None, json=None, **_ignored):
        # main.py calls client.get()/client.post() (not the lower-level
        # .request() the companies fake mimics) — those convenience
        # wrappers always forward extra kwargs (cookies, auth,
        # follow_redirects, timeout, extensions) into request(), so this
        # signature has to swallow whatever it doesn't care about.
        if url.endswith("/generation_log"):
            if method == "POST":
                status, body = log.insert(json)
            elif method == "PATCH":
                status, body = log.patch_signed(params or {}, json)
            else:
                raise AssertionError(f"unexpected method for generation_log: {method}")
        elif url.endswith("/generation_stats_by_type"):
            assert method == "GET"
            status, body = log.stats_by_type()
        elif url.endswith("/generation_stats_by_person"):
            assert method == "GET"
            status, body = log.stats_by_person()
        elif url.endswith("/generation_stats"):
            assert method == "GET"
            status, body = log.stats()
        else:
            raise AssertionError(f"unexpected Supabase URL: {url}")
        return httpx.Response(status, json=body, request=httpx.Request(method, url))

    monkeypatch.setattr(httpx.AsyncClient, "request", fake_request)
    return log


def _fill(company_name=None, template_id="dpp_template", first_name="Jan", last_name="Novak"):
    payload = {"template_id": template_id, "last_name": last_name, "first_name": first_name}
    if company_name is not None:
        payload["company_name"] = company_name
    return client.post("/api/fill", auth=AUTH, json=payload)


def test_stats_start_empty(fake_supabase):
    resp = client.get("/api/stats", auth=AUTH)
    assert resp.status_code == 200
    assert resp.json() == []


def test_successful_fill_is_reflected_in_stats(fake_supabase):
    resp = _fill(company_name="ACME s.r.o.")
    assert resp.status_code == 200

    stats = client.get("/api/stats", auth=AUTH).json()
    assert stats == [{"company_name": "ACME s.r.o.", "document_count": 1, "all_signed": False}]


def test_multiple_companies_and_repeats_aggregate_correctly(fake_supabase):
    for _ in range(3):
        assert _fill(company_name="ACME s.r.o.").status_code == 200
    for _ in range(2):
        assert _fill(company_name="Beta Trading").status_code == 200
    assert _fill(company_name="Beta Trading", template_id="hpp_template").status_code == 200

    stats = client.get("/api/stats", auth=AUTH).json()
    by_name = {row["company_name"]: row["document_count"] for row in stats}
    assert by_name == {"ACME s.r.o.": 3, "Beta Trading": 3}
    # generation_stats orders by document_count desc — both companies tie
    # at 3 here, so just the aggregate counts are asserted above; the
    # descending-order guarantee itself is exercised by the next test
    # instead, where the counts actually differ.


def test_generation_stats_view_orders_by_count_descending(fake_supabase):
    assert _fill(company_name="Small Co").status_code == 200
    for _ in range(4):
        assert _fill(company_name="Big Co").status_code == 200

    stats = client.get("/api/stats", auth=AUTH).json()
    assert [row["company_name"] for row in stats] == ["Big Co", "Small Co"]


@pytest.mark.parametrize("company_name", [None, "", "   "])
def test_fill_without_a_company_is_logged_as_bez_firmy(fake_supabase, company_name):
    assert _fill(company_name=company_name).status_code == 200
    # A second, named generation must not be folded into the same bucket.
    assert _fill(company_name="Named Co").status_code == 200

    stats = client.get("/api/stats", auth=AUTH).json()
    by_name = {row["company_name"]: row["document_count"] for row in stats}
    assert by_name == {"Bez firmy": 1, "Named Co": 1}


def test_fill_still_succeeds_when_supabase_logging_itself_errors(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://fake.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "fake-anon-key")
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)

    async def broken_request(self, method, url, *, headers=None, params=None, json=None):
        raise httpx.ConnectError("Supabase is down", request=httpx.Request(method, url))

    monkeypatch.setattr(httpx.AsyncClient, "request", broken_request)

    resp = _fill(company_name="ACME s.r.o.")
    assert resp.status_code == 200
    assert resp.json()["docx_token"].endswith(".docx")


def test_fill_succeeds_without_logging_when_supabase_is_unconfigured(monkeypatch, tmp_path):
    # Explicitly blanked out, not just "left at the default" — config.py's
    # load_dotenv() picks up backend/.env, which (in this dev environment)
    # has real SUPABASE_URL/KEY, so an untouched settings.SUPABASE_URL is
    # NOT empty here. Without this, _log_generation() would actually POST
    # this test's "ACME s.r.o." fill into the real production
    # generation_log table instead of exercising the unconfigured path.
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)
    monkeypatch.setattr(settings, "SUPABASE_URL", "")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "")

    resp = _fill(company_name="ACME s.r.o.")
    assert resp.status_code == 200


def test_stats_by_type_start_empty(fake_supabase):
    resp = client.get("/api/stats/by-type", auth=AUTH)
    assert resp.status_code == 200
    assert resp.json() == []


def test_stats_by_type_breaks_down_per_company_and_document_type(fake_supabase):
    assert _fill(company_name="ACME s.r.o.", template_id="dpp_template").status_code == 200
    for _ in range(3):
        assert _fill(company_name="ACME s.r.o.", template_id="hpp_template").status_code == 200
    assert _fill(company_name="ACME s.r.o.", template_id="ukonceni_pracovniho_pomeru").status_code == 200
    assert _fill(company_name="Beta Trading", template_id="dpp_template").status_code == 200

    stats = client.get("/api/stats/by-type", auth=AUTH).json()
    by_company = {}
    for row in stats:
        by_company.setdefault(row["company_name"], {})[row["document_type"]] = row["document_count"]

    assert by_company == {
        "ACME s.r.o.": {"DPP": 1, "HPP": 3, "Ukončení poměru": 1},
        "Beta Trading": {"DPP": 1},
    }


def test_stats_by_type_folds_missing_company_into_bez_firmy(fake_supabase):
    assert _fill(company_name=None, template_id="dpp_template").status_code == 200
    assert _fill(company_name="", template_id="dpp_template").status_code == 200

    stats = client.get("/api/stats/by-type", auth=AUTH).json()
    assert stats == [{"company_name": "Bez firmy", "document_type": "DPP", "document_count": 2}]


def test_stats_by_type_route_503s_when_supabase_is_unconfigured(monkeypatch):
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    monkeypatch.setattr(settings, "SUPABASE_URL", "")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "")

    resp = client.get("/api/stats/by-type", auth=AUTH)
    assert resp.status_code == 503


def test_stats_route_503s_when_supabase_is_unconfigured(monkeypatch):
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    monkeypatch.setattr(settings, "SUPABASE_URL", "")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "")

    resp = client.get("/api/stats", auth=AUTH)
    assert resp.status_code == 503


# --------------------------------------------------- Signing status (dots)

def test_stats_by_person_start_empty(fake_supabase):
    resp = client.get("/api/stats/by-person", auth=AUTH)
    assert resp.status_code == 200
    assert resp.json() == []


def test_stats_by_person_breaks_down_per_company_and_person(fake_supabase):
    assert _fill(company_name="ACME s.r.o.", first_name="Jan", last_name="Novak").status_code == 200
    assert _fill(company_name="ACME s.r.o.", first_name="Jan", last_name="Novak", template_id="hpp_template").status_code == 200
    assert _fill(company_name="ACME s.r.o.", first_name="Eva", last_name="Svoboda").status_code == 200

    stats = client.get("/api/stats/by-person", auth=AUTH).json()
    by_person = {row["employee_name"]: row["document_count"] for row in stats}
    assert by_person == {"Jan Novak": 2, "Eva Svoboda": 1}
    assert all(row["company_name"] == "ACME s.r.o." for row in stats)
    # Nobody's been marked signed yet.
    assert all(row["all_signed"] is False for row in stats)


def test_stats_by_person_excludes_rows_with_no_employee_name(fake_supabase):
    assert _fill(company_name="ACME s.r.o.", first_name="", last_name="").status_code == 200
    assert _fill(company_name="ACME s.r.o.", first_name="Jan", last_name="Novak").status_code == 200

    stats = client.get("/api/stats/by-person", auth=AUTH).json()
    assert [row["employee_name"] for row in stats] == ["Jan Novak"]
    # The blank-name row is still counted at the company level, though.
    company_stats = client.get("/api/stats", auth=AUTH).json()
    assert company_stats[0]["document_count"] == 2


def test_company_all_signed_is_false_until_every_persons_documents_are_signed(fake_supabase):
    assert _fill(company_name="ACME s.r.o.", first_name="Jan", last_name="Novak").status_code == 200
    assert _fill(company_name="ACME s.r.o.", first_name="Eva", last_name="Svoboda").status_code == 200

    stats = client.get("/api/stats", auth=AUTH).json()
    assert stats[0]["all_signed"] is False

    sign = client.post(
        "/api/stats/sign", auth=AUTH,
        json={"company_name": "ACME s.r.o.", "employee_name": "Jan Novak", "signed": True},
    )
    assert sign.status_code == 200

    # Jan is fully signed now, but Eva isn't — the company is still red.
    by_person = {row["employee_name"]: row["all_signed"] for row in client.get("/api/stats/by-person", auth=AUTH).json()}
    assert by_person == {"Jan Novak": True, "Eva Svoboda": False}
    assert client.get("/api/stats", auth=AUTH).json()[0]["all_signed"] is False

    sign2 = client.post(
        "/api/stats/sign", auth=AUTH,
        json={"company_name": "ACME s.r.o.", "employee_name": "Eva Svoboda", "signed": True},
    )
    assert sign2.status_code == 200

    # Now everyone at the company is signed — green.
    assert client.get("/api/stats", auth=AUTH).json()[0]["all_signed"] is True


def test_marking_a_person_signed_covers_all_of_their_documents(fake_supabase):
    for _ in range(3):
        assert _fill(company_name="ACME s.r.o.", first_name="Jan", last_name="Novak").status_code == 200

    client.post(
        "/api/stats/sign", auth=AUTH,
        json={"company_name": "ACME s.r.o.", "employee_name": "Jan Novak", "signed": True},
    )

    by_person = client.get("/api/stats/by-person", auth=AUTH).json()
    assert by_person == [
        {"company_name": "ACME s.r.o.", "employee_name": "Jan Novak", "document_count": 3, "all_signed": True}
    ]


def test_unsigning_a_person_turns_the_company_red_again(fake_supabase):
    assert _fill(company_name="ACME s.r.o.", first_name="Jan", last_name="Novak").status_code == 200
    client.post(
        "/api/stats/sign", auth=AUTH,
        json={"company_name": "ACME s.r.o.", "employee_name": "Jan Novak", "signed": True},
    )
    assert client.get("/api/stats", auth=AUTH).json()[0]["all_signed"] is True

    unsign = client.post(
        "/api/stats/sign", auth=AUTH,
        json={"company_name": "ACME s.r.o.", "employee_name": "Jan Novak", "signed": False},
    )
    assert unsign.status_code == 200
    assert client.get("/api/stats", auth=AUTH).json()[0]["all_signed"] is False


def test_signing_matches_the_bez_firmy_bucket_for_a_null_company(fake_supabase):
    assert _fill(company_name=None, first_name="Jan", last_name="Novak").status_code == 200

    sign = client.post(
        "/api/stats/sign", auth=AUTH,
        json={"company_name": "Bez firmy", "employee_name": "Jan Novak", "signed": True},
    )
    assert sign.status_code == 200
    assert client.get("/api/stats", auth=AUTH).json()[0]["all_signed"] is True


def test_stats_by_person_route_503s_when_supabase_is_unconfigured(monkeypatch):
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    monkeypatch.setattr(settings, "SUPABASE_URL", "")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "")

    resp = client.get("/api/stats/by-person", auth=AUTH)
    assert resp.status_code == 503


def test_stats_sign_route_503s_when_supabase_is_unconfigured(monkeypatch):
    monkeypatch.setattr(settings, "SITE_USERNAME", "hr")
    monkeypatch.setattr(settings, "SITE_PASSWORD", "test123")
    monkeypatch.setattr(settings, "SUPABASE_URL", "")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "")

    resp = client.post(
        "/api/stats/sign", auth=AUTH,
        json={"company_name": "ACME s.r.o.", "employee_name": "Jan Novak", "signed": True},
    )
    assert resp.status_code == 503
