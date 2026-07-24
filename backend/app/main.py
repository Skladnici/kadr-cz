"""
KADR.CZ — document filler for Czech employment contracts.

Flow: log in -> upload a document -> AI extracts fields -> pick a blank
-> fill -> download as .docx or .pdf. Uploaded photos and generated
documents are not retained (the source photo is deleted right after
recognition; the generated file is deleted right after download, or
after 24h if never downloaded). The one persistent exception is the
shared companies list, stored in Supabase so employer details can be
reused across contracts and visitors. Run:

    uvicorn app.main:app --reload --port 8000
"""
import asyncio
import base64
import logging
import secrets
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, Request, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel
from typing import Optional
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.config import settings
from app.ocr_service import recognize_document
from app.blank_service import (
    list_templates, fill_blank, convert_to_pdf, _fill_bundle_docx,
    render_signed_contract, SIGNABLE_TEMPLATE_IDS,
)
from app.pdf_fill import fill_poplatnik_pdf

logging.basicConfig(
    level=settings.LOG_LEVEL,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

app = FastAPI(title=settings.APP_NAME)

# No cookies or browser-managed credentials are used anywhere — the
# frontend sends its own Authorization: Basic header explicitly on every
# request (see LoginForm/apiFetch in SimpleDocFiller.jsx) instead of
# relying on the browser's native Basic Auth prompt, which turned out not
# to fire reliably for cross-site fetch() requests (notably in Incognito
# mode). Since nothing is credentialed, allow_credentials must stay off —
# combined with a wildcard origin it would let any website read
# credentialed responses from a visitor's browser.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Applies to every response this API sends. This backend itself only ever
# serves JSON (plus FastAPI's own /docs, /redoc, /openapi.json) — the
# actual product UI is a separate frontend origin, so this CSP has no
# bearing on that page's own Google Fonts loading. It's still allowed
# through here (font-src/style-src) so that if this backend ever serves
# HTML of its own directly, an existing site-wide reference wouldn't need
# rediscovering. /docs and /redoc are exempted from the strict
# script-src/style-src rules below since FastAPI's bundled Swagger/ReDoc UI
# loads its JS/CSS from a CDN, not from this app's own origin.
_DOCS_PATHS = {"/docs", "/redoc", "/openapi.json"}


@app.middleware("http")
async def _security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    # Only sent once the request has actually arrived over TLS. Render
    # terminates TLS at its edge proxy and forwards to this container over
    # plain HTTP, setting X-Forwarded-Proto: https on the way — uvicorn's
    # own request.url.scheme stays "http" regardless, so that header is the
    # only reliable signal. Localhost dev (plain http://, no proxy) never
    # sets it, so HSTS is naturally skipped there — sending it locally
    # would make the browser force https:// on localhost afterwards.
    if request.headers.get("x-forwarded-proto") == "https" or request.url.scheme == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    if request.url.path not in _DOCS_PATHS:
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com; "
            "img-src 'self' data:; "
            "object-src 'none'; "
            "base-uri 'self'; "
            "frame-ancestors 'none'"
        )
    return response


# Rate limiting. /api/recognize and /api/fill get a tight 10/minute cap —
# they hit an external, quota-limited service (OCR.space, free tier: ~500
# requests/day for the whole site) or do real disk/CPU work (LibreOffice
# PDF conversion) — a runaway client (buggy retry loop, or someone
# hammering the upload button) could otherwise burn through the daily OCR
# quota or pile up disk writes well before the site-wide auth would ever
# stop them, since auth just proves *who* is asking, not how fast.
# /api/stats gets a looser 60/minute general-purpose cap — it's cheap
# (a single Supabase read), so it just needs a sane ceiling against
# accidental or deliberate hammering, not a quota-driven one. Keyed by IP
# rather than by logged-in identity — everyone shares one
# SITE_USERNAME/PASSWORD, so there's no per-user identity to key on
# anyway.
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter

RATE_LIMIT_MESSAGE = (
    "Příliš mnoho požadavků z vaší adresy — zkuste to prosím znovu za minutu."
)


@app.exception_handler(RateLimitExceeded)
async def _rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    return JSONResponse(
        status_code=429,
        content={"detail": RATE_LIMIT_MESSAGE},
        headers={"Retry-After": "60"},
    )


_site_security = HTTPBasic()

# Brute-force protection for the shared SITE_USERNAME/SITE_PASSWORD: 5 wrong
# guesses from one IP within 5 minutes locks that IP out for 15 minutes.
# Everyone shares one login, so an attacker only needs to guess one
# password — without this, slowapi's plain request-count limits above
# would still let them try five wrong passwords a minute indefinitely.
# In-memory and per-process (matches limiter's own in-memory store) — this
# app runs as a single Render instance, no multi-worker/Redis setup to
# share state across.
LOGIN_ATTEMPT_WINDOW_SECONDS = 5 * 60
LOGIN_MAX_FAILURES = 5
LOGIN_LOCKOUT_SECONDS = 15 * 60
LOGIN_LOCKOUT_MESSAGE = (
    "Příliš mnoho neúspěšných pokusů o přihlášení z vaší adresy — "
    "zkuste to prosím znovu za 15 minut."
)

_login_attempts: dict = {}  # ip -> {"failures": [timestamp, ...], "locked_until": float | None}


def _login_lockout_remaining(ip: str, now: float) -> float:
    """Seconds left in ip's lockout, or 0 if it isn't currently locked.
    Also prunes failures older than the attempt window so a lockout can't
    be re-triggered by stale attempts once it has expired."""
    entry = _login_attempts.get(ip)
    if not entry:
        return 0
    if entry["locked_until"] and now < entry["locked_until"]:
        return entry["locked_until"] - now
    entry["locked_until"] = None
    entry["failures"] = [t for t in entry["failures"] if now - t < LOGIN_ATTEMPT_WINDOW_SECONDS]
    if not entry["failures"]:
        del _login_attempts[ip]
    return 0


def _record_login_failure(ip: str, now: float) -> float:
    """Records a failed attempt and returns the resulting lockout's
    remaining seconds (0 if this failure didn't trigger one)."""
    entry = _login_attempts.setdefault(ip, {"failures": [], "locked_until": None})
    entry["failures"] = [t for t in entry["failures"] if now - t < LOGIN_ATTEMPT_WINDOW_SECONDS]
    entry["failures"].append(now)
    if len(entry["failures"]) >= LOGIN_MAX_FAILURES:
        entry["locked_until"] = now + LOGIN_LOCKOUT_SECONDS
        return LOGIN_LOCKOUT_SECONDS
    return 0


def _clear_login_failures(ip: str) -> None:
    _login_attempts.pop(ip, None)


def _require_site_auth(request: Request, credentials: HTTPBasicCredentials = Depends(_site_security)):
    """Gates every /api/* route behind a single shared username/password.
    FastAPI's HTTPBasic only inspects the Authorization: Basic header — it
    doesn't care whether a browser's native prompt put it there or the
    frontend's own login form did (see SimpleDocFiller.jsx). Anonymous
    visitors must not be able to upload documents, run OCR, generate
    contracts, or touch the shared companies list."""
    if not settings.SITE_USERNAME or not settings.SITE_PASSWORD:
        raise HTTPException(
            503,
            "Přístup na server není nastaven — chybí SITE_USERNAME / "
            "SITE_PASSWORD na serveru.",
        )

    ip = get_remote_address(request)
    now = time.time()
    remaining = _login_lockout_remaining(ip, now)
    if remaining > 0:
        raise HTTPException(
            429,
            LOGIN_LOCKOUT_MESSAGE,
            headers={"Retry-After": str(int(remaining))},
        )

    valid_username = secrets.compare_digest(credentials.username, settings.SITE_USERNAME)
    valid_password = secrets.compare_digest(credentials.password, settings.SITE_PASSWORD)
    if not (valid_username and valid_password):
        remaining = _record_login_failure(ip, now)
        if remaining > 0:
            raise HTTPException(
                429,
                LOGIN_LOCKOUT_MESSAGE,
                headers={"Retry-After": str(int(remaining))},
            )
        raise HTTPException(
            401,
            "Neplatné přihlašovací údaje.",
            headers={"WWW-Authenticate": "Basic"},
        )
    _clear_login_failures(ip)


@app.get("/")
def root():
    return {"app": settings.APP_NAME, "status": "running", "ocr_mode": settings.OCR_MODE}


@app.get("/api/blanks", dependencies=[Depends(_require_site_auth)])
def get_blanks():
    """Returns the list of available fillable Word blanks (auto-discovered
    from app/templates/ — add a new .docx there to add a new blank)."""
    return list_templates()


@app.post("/api/recognize", dependencies=[Depends(_require_site_auth)])
@limiter.limit("10/minute")
async def recognize(request: Request, file: UploadFile = File(...)):
    """Upload a document photo/scan/PDF -> get back AI-extracted fields."""
    ext = Path(file.filename).suffix.lower()
    if ext not in settings.ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Nepodporovaný formát: {ext}")

    contents = await file.read()
    if len(contents) > settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024:
        raise HTTPException(400, f"Soubor je příliš velký (max {settings.MAX_UPLOAD_SIZE_MB} MB)")

    stored_path = settings.UPLOAD_DIR / f"{uuid.uuid4()}{ext}"
    stored_path.write_bytes(contents)

    extracted = await recognize_document(stored_path, file.filename)

    # Clean up the uploaded file immediately — nothing is retained.
    try:
        stored_path.unlink()
    except Exception:
        pass

    return extracted


class RecognizeTextRequest(BaseModel):
    text: str


@app.post("/api/recognize-text", dependencies=[Depends(_require_site_auth)])
async def recognize_text(payload: RecognizeTextRequest):
    """Runs the same field-extraction rules used for photos, but on text
    the person pastes in directly — useful when they already have the
    document's text (e.g. copied from a chat message or email) instead
    of a photo to upload."""
    from app.ocr_service import _extract_fields_from_text, _parse_name_from_text

    text = payload.text or ""
    if not text.strip():
        raise HTTPException(400, "Vložený text je prázdný")

    fields = _extract_fields_from_text(text, quality=100, mode="pasted-text")
    first, last = _parse_name_from_text(text)
    fields["first_name"] = first
    fields["last_name"] = last
    fields["ocr_raw_text"] = text
    return fields


class FillRequest(BaseModel):
    template_id: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    address: Optional[str] = None
    address_origin: Optional[str] = None
    birth_date: Optional[str] = None
    doc_number: Optional[str] = None
    nationality: Optional[str] = None
    position: Optional[str] = None
    workplace: Optional[str] = None
    salary: Optional[str] = None
    hours_per_week: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    bank_account: Optional[str] = None
    company_name: Optional[str] = None
    company_ico: Optional[str] = None
    company_dic: Optional[str] = None
    company_address: Optional[str] = None
    company_representative: Optional[str] = None
    visa_number: Optional[str] = None
    visa_validity: Optional[str] = None
    residence_type: Optional[str] = None
    signing_place: Optional[str] = None
    # HPP-specific: optional probation period + fixed-term/indefinite switch
    probation_period: Optional[str] = None
    contract_indefinite: Optional[bool] = None
    termination_reason: Optional[str] = None
    last_working_day: Optional[str] = None
    pay_period: Optional[str] = None
    gross_salary: Optional[str] = None
    health_insurance: Optional[str] = None
    social_insurance: Optional[str] = None
    income_tax: Optional[str] = None
    net_salary: Optional[str] = None


# DPP/DPČ/HPP are the three "employment onboarding" contract types that
# get the standard 4-document packet (see BUNDLE_DOCS below) — the
# ukončení/výplatní páska blanks are standalone documents, not part of
# a new-hire packet, so they're deliberately left out.
_BUNDLE_TEMPLATE_IDS = {"dpp_template", "dpc_template", "hpp_template"}


@app.post("/api/fill", dependencies=[Depends(_require_site_auth)])
@limiter.limit("10/minute")
async def fill(request: Request, payload: FillRequest):
    """Fills the chosen blank with the given fields and returns a
    download token; nothing is saved to a database.

    For DPP/DPČ/HPP specifically, also auto-generates the standard
    onboarding packet alongside the main contract — GDPR consent, health
    declaration, and the tax office declaration (overlaid onto the real
    government form, see pdf_fill.py) — using the exact same fields
    already submitted for the contract itself. Each bundle document is
    best-effort (see _fill_bundle_docx/fill_poplatnik_pdf): a problem
    generating one of them never fails the main contract's generation,
    it just comes back with that token as null. Single (non-batch) mode
    only — batch mode's own per-card generation/zip-download is
    untouched by this."""
    fields = payload.model_dump()
    try:
        docx_path = fill_blank(payload.template_id, fields)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, f"Chyba při vyplňování: {e}")

    # convert_to_pdf() shells out to LibreOffice and can take real
    # wall-clock seconds — offload it so it doesn't tie up this request's
    # thread any longer than the subprocess call itself needs.
    pdf_path = await asyncio.to_thread(convert_to_pdf, docx_path)

    result = {
        "docx_token": docx_path.name,
        "pdf_token": pdf_path.name if pdf_path else None,
    }

    if payload.template_id in _BUNDLE_TEMPLATE_IDS:
        # Offloaded the same way as convert_to_pdf() above — three more
        # synchronous document renders otherwise run back-to-back on this
        # request's own thread, which (unlike the single-document path
        # this endpoint used to only ever take) is now enough combined
        # work to meaningfully hold up the event loop for other requests
        # in between.
        gdpr_path = await asyncio.to_thread(_fill_bundle_docx, "gdpr_template", fields)
        zdravotni_path = await asyncio.to_thread(_fill_bundle_docx, "zdravotni_template", fields)
        poplatnik_path = await asyncio.to_thread(fill_poplatnik_pdf, fields)
        result["gdpr_docx_token"] = gdpr_path.name if gdpr_path else None
        result["zdravotni_docx_token"] = zdravotni_path.name if zdravotni_path else None
        result["poplatnik_pdf_token"] = poplatnik_path.name if poplatnik_path else None

    # Best-effort usage counter (see _log_generation below) — logged only
    # once generation has actually succeeded, and never allowed to turn a
    # successful fill into a failed request.
    employee_name = f"{payload.first_name or ''} {payload.last_name or ''}".strip()
    await _log_generation(payload.template_id, payload.company_name, employee_name)

    return result


@app.get("/api/download/{filename}", dependencies=[Depends(_require_site_auth)])
def download(filename: str, background_tasks: BackgroundTasks):
    """Serves a generated file by its filename token. Files live only in
    the generated/ folder and aren't tracked anywhere else."""
    # Basic path-traversal guard — only allow plain filenames we generated.
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(400, "Neplatný název souboru")

    path = settings.GENERATED_DIR / filename
    if not path.exists():
        raise HTTPException(404, "Soubor nenalezen")

    media_type = (
        "application/pdf" if filename.endswith(".pdf")
        else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    # Explicitly forbid caching — filenames are deterministic (based on
    # employee name), so without this a browser can silently serve a
    # stale cached copy after the template was updated, even though the
    # server is generating fresh content on every request.
    headers = {"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"}

    # Deleting the file right after it's served makes each token single-use
    # in addition to the site-wide login now required to reach this route.
    background_tasks.add_task(path.unlink, missing_ok=True)

    return FileResponse(
        path, filename=filename, media_type=media_type, headers=headers,
        background=background_tasks,
    )


# ---------------------------------------------------------------- Companies
# Shared across everyone who uses the site — stored in a free Supabase
# Postgres database (not localStorage), so the same list of saved
# companies shows up no matter which computer/browser someone opens the
# site from. If Supabase isn't configured (env vars empty), these
# endpoints return a clear error rather than crashing. Table schema:
# create_companies_table.sql at the repo root.

class CompanyIn(BaseModel):
    name: str
    ico: Optional[str] = None
    dic: Optional[str] = None
    address: Optional[str] = None
    representative: Optional[str] = None


def _supabase_headers():
    return {
        "apikey": settings.SUPABASE_KEY,
        "Authorization": f"Bearer {settings.SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


def _require_supabase():
    if not settings.SUPABASE_URL or not settings.SUPABASE_KEY:
        raise HTTPException(
            503,
            "Sdílené firmy nejsou nastavené — chybí SUPABASE_URL / SUPABASE_KEY na serveru.",
        )


_companies_dependencies = [Depends(_require_site_auth), Depends(_require_supabase)]


async def _supabase_companies_request(
    method: str, *, params: Optional[dict] = None, json: Optional[dict] = None, extra_headers: Optional[dict] = None
):
    """Every /api/companies* route below does exactly this — build
    headers, call the Supabase REST API, surface its error text on
    failure — with only the HTTP method/params/body actually differing."""
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.request(
            method,
            f"{settings.SUPABASE_URL}/rest/v1/companies",
            headers={**_supabase_headers(), **(extra_headers or {})},
            params=params,
            json=json,
        )
    if resp.status_code >= 400:
        raise HTTPException(502, f"Supabase chyba: {resp.text}")
    return resp


@app.get("/api/companies", dependencies=_companies_dependencies)
async def list_companies():
    resp = await _supabase_companies_request("GET", params={"select": "*", "order": "name.asc"})
    return resp.json()


@app.post("/api/companies", status_code=201, dependencies=_companies_dependencies)
async def create_company(payload: CompanyIn):
    resp = await _supabase_companies_request(
        "POST", json=payload.model_dump(), extra_headers={"Prefer": "return=representation"},
    )
    result = resp.json()
    return result[0] if isinstance(result, list) else result


@app.put("/api/companies/{company_id}", dependencies=_companies_dependencies)
async def update_company(company_id: str, payload: CompanyIn):
    # Known limitation, accepted for this app's size: no optimistic
    # concurrency check. If two people edit the same company at once,
    # whoever's PATCH lands last silently wins — the other person's
    # changes are gone with no warning. Fixable by having the client send
    # the updated_at it last saw and rejecting the PATCH (409) if the row
    # has since changed (create_companies_table.sql already has
    # updated_at + a trigger, so the column exists) — not done here since
    # it wasn't worth the added complexity for a small shared team tool.
    resp = await _supabase_companies_request(
        "PATCH", params={"id": f"eq.{company_id}"}, json=payload.model_dump(),
        extra_headers={"Prefer": "return=representation"},
    )
    result = resp.json()
    return result[0] if isinstance(result, list) else result


@app.delete("/api/companies/{company_id}", status_code=204, dependencies=_companies_dependencies)
async def delete_company(company_id: str):
    await _supabase_companies_request("DELETE", params={"id": f"eq.{company_id}"})
    return None


# ---------------------------------------------------------------- Stats
# Lightweight, all-time usage counter: how many documents were generated
# per company (and, since employee_name was added for the per-person
# signing-status dots in StatsWidget.jsx, per person too) — see
# create_generation_log_table.sql. Logged best-effort from fill() above
# on every successful generation: if Supabase isn't configured, or the
# insert itself fails, the document is still generated and served
# normally — only the counter silently misses that one entry, since a
# stats widget is not worth failing a real document request over.

_DOCUMENT_TYPE_LABELS = {
    "dpp_template": "DPP",
    "dpc_template": "DPČ",
    "hpp_template": "HPP",
    "ukonceni_pracovniho_pomeru": "Ukončení poměru",
    "vyplatni_paska": "Výplatní páska",
}


async def _log_generation(template_id: str, company_name: Optional[str], employee_name: Optional[str] = None) -> None:
    if not settings.SUPABASE_URL or not settings.SUPABASE_KEY:
        return
    document_type = _DOCUMENT_TYPE_LABELS.get(template_id, template_id)
    name = (company_name or "").strip() or None
    person = (employee_name or "").strip() or None
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{settings.SUPABASE_URL}/rest/v1/generation_log",
                headers=_supabase_headers(),
                json={"company_name": name, "employee_name": person, "document_type": document_type},
            )
        if resp.status_code >= 400:
            logging.getLogger(__name__).warning(
                "generation_log insert failed (%s): %s", resp.status_code, resp.text
            )
    except Exception:
        logging.getLogger(__name__).warning("generation_log insert failed", exc_info=True)


@app.get("/api/stats", dependencies=[Depends(_require_site_auth), Depends(_require_supabase)])
@limiter.limit("60/minute")
async def get_stats(request: Request):
    """Per-company document counts, all-time, no date breakdown, plus an
    all_signed flag (true only if every document logged for that company
    has a signed_at) — powers the corner stats widget's per-company status
    dot (StatsWidget.jsx). Reads the generation_stats view (a plain GROUP
    BY that PostgREST's REST API can't express directly) rather than
    aggregating every row in Python."""
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{settings.SUPABASE_URL}/rest/v1/generation_stats",
            headers=_supabase_headers(),
            params={"select": "*"},
        )
    if resp.status_code >= 400:
        raise HTTPException(502, f"Supabase chyba: {resp.text}")
    return resp.json()


@app.get("/api/stats/by-type", dependencies=[Depends(_require_site_auth), Depends(_require_supabase)])
@limiter.limit("60/minute")
async def get_stats_by_type(request: Request):
    """Per-company document counts broken down by document_type as well —
    powers StatsWidget.jsx's click-to-expand detail under each company row
    (e.g. "DPP: 1 · HPP: 3"). Reads the generation_stats_by_type view (see
    create_generation_log_table.sql) for the same reason get_stats() reads
    a view instead of aggregating in Python: PostgREST's REST API has no
    query-string syntax for GROUP BY."""
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{settings.SUPABASE_URL}/rest/v1/generation_stats_by_type",
            headers=_supabase_headers(),
            params={"select": "*"},
        )
    if resp.status_code >= 400:
        raise HTTPException(502, f"Supabase chyba: {resp.text}")
    return resp.json()


@app.get("/api/stats/by-person", dependencies=[Depends(_require_site_auth), Depends(_require_supabase)])
@limiter.limit("60/minute")
async def get_stats_by_person(request: Request):
    """Per-person document counts and signing status under each company —
    powers StatsWidget.jsx's per-person status dots in the expanded detail
    view. Reads the generation_stats_by_person view (see
    create_generation_log_table.sql); rows with no employee_name on record
    (blank at generation time, or predating that column) are excluded by
    the view itself, not here."""
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{settings.SUPABASE_URL}/rest/v1/generation_stats_by_person",
            headers=_supabase_headers(),
            params={"select": "*"},
        )
    if resp.status_code >= 400:
        raise HTTPException(502, f"Supabase chyba: {resp.text}")
    return resp.json()


async def _apply_signed_status(company_name: str, employee_name: str, signed: bool) -> None:
    """Marks/unmarks every generation_log row for one person at one
    company as signed — the per-person dot (StatsWidget.jsx) always
    reflects "all of this person's documents", so both callers below act
    on that whole set at once rather than one document at a time:
    the admin's manual toggle (POST /api/stats/sign) AND the employee's
    own real signature (POST /api/podepsat/{token}/sign) go through this
    same helper and the same signed_at column — an employee actually
    signing and an admin manually overriding the dot are two ways of
    setting the same fact, not two competing mechanisms. company_name/
    employee_name are matched against the same coalesce(...)'d values
    generation_stats_by_person returns, not necessarily the raw column
    (company_name can be NULL in the table but show up here as the
    'Bez firmy' bucket the frontend already displays)."""
    params: dict = {"employee_name": f"eq.{employee_name}"}
    if company_name == "Bez firmy":
        params["or"] = f"(company_name.is.null,company_name.eq.{company_name})"
    else:
        params["company_name"] = f"eq.{company_name}"
    body = {"signed_at": datetime.now(timezone.utc).isoformat() if signed else None}
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.patch(
            f"{settings.SUPABASE_URL}/rest/v1/generation_log",
            headers=_supabase_headers(),
            params=params,
            json=body,
        )
    if resp.status_code >= 400:
        raise HTTPException(502, f"Supabase chyba: {resp.text}")


class SignIn(BaseModel):
    company_name: str
    employee_name: str
    signed: bool


@app.post("/api/stats/sign", dependencies=[Depends(_require_site_auth), Depends(_require_supabase)])
@limiter.limit("60/minute")
async def set_signed_status(request: Request, payload: SignIn):
    await _apply_signed_status(payload.company_name, payload.employee_name, payload.signed)
    return {"ok": True}


# --------------------------------------------------------- E-signature
# One-time-link employee signing flow. sign_links (see
# create_sign_links_table.sql) never stores a rendered file — only the
# exact FillRequest `fields` snapshot and, once signed, the signature
# image — so every one of these routes re-renders the contract on
# demand via blank_service.render_signed_contract(). See that function's
# own docstring for why.
#
# The /api/podepsat/* routes below are the one deliberate exception to
# this file's "every route sits behind _require_site_auth" rule: an
# employee has no site login, so the token itself (128 bits, see
# create_sign_links_table.sql) is what stands in for auth. Each of them
# calls _require_supabase() directly instead of via Depends(), precisely
# so a stray copy-paste can't silently reattach a site-auth dependency.

async def _fetch_sign_link(token: str) -> Optional[dict]:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{settings.SUPABASE_URL}/rest/v1/sign_links",
            headers=_supabase_headers(),
            params={"token": f"eq.{token}", "select": "*"},
        )
    if resp.status_code >= 400:
        raise HTTPException(502, f"Supabase chyba: {resp.text}")
    rows = resp.json()
    return rows[0] if rows else None


def _sign_link_is_usable(link: Optional[dict]) -> bool:
    # Once the employee has downloaded their signed copy, the link is
    # spent for them — every public route below treats a not-found and an
    # already-downloaded token identically (a 404), so a stale link can't
    # be used to distinguish "never existed" from "already used".
    return link is not None and not link.get("employee_downloaded_at")


@app.post("/api/sign-links", dependencies=[Depends(_require_site_auth), Depends(_require_supabase)])
@limiter.limit("20/minute")
async def create_sign_link(request: Request, payload: FillRequest):
    """Called right after a successful /api/fill, with the exact same
    payload — "Vytvořit odkaz k podpisu" in SimpleDocFiller/
    BatchDocFiller already has these fields in hand, so there's no need
    for the backend to look up or remember anything from that earlier
    /api/fill call."""
    if payload.template_id not in SIGNABLE_TEMPLATE_IDS:
        raise HTTPException(400, "Tento typ dokumentu nelze podepsat odkazem.")
    token = uuid.uuid4().hex
    row = {
        "token": token,
        "template_id": payload.template_id,
        "fields": payload.model_dump(),
        "company_name": (payload.company_name or "").strip() or None,
        "employee_name": f"{payload.first_name or ''} {payload.last_name or ''}".strip() or None,
    }
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{settings.SUPABASE_URL}/rest/v1/sign_links",
            headers=_supabase_headers(),
            json=row,
        )
    if resp.status_code >= 400:
        raise HTTPException(502, f"Supabase chyba: {resp.text}")
    return {"token": token}


@app.get("/api/sign-links/{token}/download", dependencies=[Depends(_require_site_auth), Depends(_require_supabase)])
@limiter.limit("30/minute")
async def admin_download_signed_contract(request: Request, token: str, background_tasks: BackgroundTasks):
    """The admin-facing re-download (e.g. the download icon next to a
    green person's dot in StatsWidget.jsx). Deliberately a separate route
    from /api/podepsat/{token}/download: this one never touches
    employee_downloaded_at, so it can be called any number of times and
    never interferes with — or is blocked by — the employee's own
    one-time download."""
    link = await _fetch_sign_link(token)
    if link is None:
        raise HTTPException(404, "Odkaz nenalezen.")
    if not link.get("signed_at"):
        raise HTTPException(400, "Dokument ještě není podepsán.")
    docx_path = await asyncio.to_thread(
        render_signed_contract, link["template_id"], link["fields"], link.get("signature_image"),
    )
    background_tasks.add_task(docx_path.unlink, missing_ok=True)
    return FileResponse(
        docx_path, filename=docx_path.name,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
        background=background_tasks,
    )


@app.get("/api/podepsat/{token}")
@limiter.limit("30/minute")
async def get_sign_link_status(request: Request, token: str):
    _require_supabase()
    link = await _fetch_sign_link(token)
    if not _sign_link_is_usable(link):
        return {"valid": False}
    return {
        "valid": True,
        "company_name": link.get("company_name"),
        "employee_name": link.get("employee_name"),
        "template_id": link.get("template_id"),
        "signed": bool(link.get("signed_at")),
    }


@app.get("/api/podepsat/{token}/pdf")
@limiter.limit("30/minute")
async def get_sign_link_pdf(request: Request, token: str, background_tasks: BackgroundTasks):
    """Powers both the "read before signing" preview and, after signing,
    reviewing what was actually signed — same route either way, since
    render_signed_contract() always reflects sign_links' current
    signature_image (null beforehand, the real one afterwards)."""
    _require_supabase()
    link = await _fetch_sign_link(token)
    if not _sign_link_is_usable(link):
        raise HTTPException(404, "Odkaz nenalezen nebo již není platný.")
    docx_path = await asyncio.to_thread(
        render_signed_contract, link["template_id"], link["fields"], link.get("signature_image"),
    )
    pdf_path = await asyncio.to_thread(convert_to_pdf, docx_path)
    docx_path.unlink(missing_ok=True)
    if pdf_path is None:
        raise HTTPException(500, "Nepodařilo se vygenerovat náhled.")
    background_tasks.add_task(pdf_path.unlink, missing_ok=True)
    return FileResponse(
        pdf_path, media_type="application/pdf",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
        background=background_tasks,
    )


class SubmitSignatureIn(BaseModel):
    signature_image: str  # base64 PNG, optionally with a data: URL prefix


@app.post("/api/podepsat/{token}/sign")
@limiter.limit("10/minute")
async def submit_signature(request: Request, token: str, payload: SubmitSignatureIn):
    _require_supabase()
    link = await _fetch_sign_link(token)
    if not _sign_link_is_usable(link):
        raise HTTPException(404, "Odkaz nenalezen nebo již není platný.")

    b64 = payload.signature_image.split(",", 1)[-1].strip()
    try:
        if not b64:
            raise ValueError("empty signature")
        base64.b64decode(b64, validate=True)
    except Exception:
        raise HTTPException(400, "Neplatný obrázek podpisu.")

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.patch(
            f"{settings.SUPABASE_URL}/rest/v1/sign_links",
            headers=_supabase_headers(),
            params={"token": f"eq.{token}"},
            json={"signature_image": b64, "signed_at": datetime.now(timezone.utc).isoformat()},
        )
    if resp.status_code >= 400:
        raise HTTPException(502, f"Supabase chyba: {resp.text}")

    # Same field, same helper the admin's manual dot-click uses (see
    # _apply_signed_status's own docstring) — an employee really signing
    # is just another way of setting the fact "this person is signed",
    # not a separate parallel status.
    if link.get("company_name") and link.get("employee_name"):
        await _apply_signed_status(link["company_name"], link["employee_name"], True)

    return {"ok": True}


async def _mark_employee_downloaded(token: str) -> None:
    async with httpx.AsyncClient(timeout=15) as client:
        await client.patch(
            f"{settings.SUPABASE_URL}/rest/v1/sign_links",
            headers=_supabase_headers(),
            params={"token": f"eq.{token}"},
            json={"employee_downloaded_at": datetime.now(timezone.utc).isoformat()},
        )


@app.get("/api/podepsat/{token}/download")
@limiter.limit("10/minute")
async def download_signed_contract(request: Request, token: str, background_tasks: BackgroundTasks):
    """The employee's own one-time download. employee_downloaded_at is
    stamped as a background task — same pattern as /api/download's
    delete-after-serve — so a connection that drops mid-transfer doesn't
    burn the employee's one shot at a file they never actually received."""
    _require_supabase()
    link = await _fetch_sign_link(token)
    if not _sign_link_is_usable(link):
        raise HTTPException(404, "Odkaz nenalezen nebo již není platný.")
    if not link.get("signed_at"):
        raise HTTPException(400, "Dokument ještě není podepsán.")

    docx_path = await asyncio.to_thread(
        render_signed_contract, link["template_id"], link["fields"], link.get("signature_image"),
    )
    background_tasks.add_task(docx_path.unlink, missing_ok=True)
    background_tasks.add_task(_mark_employee_downloaded, token)
    return FileResponse(
        docx_path, filename=docx_path.name,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
        background=background_tasks,
    )


# ------------------------------------------------------------- Keep-alive
# Supabase's free plan pauses a project after ~7 days with no activity —
# unlike Render's own free-tier sleep (which any request wakes up on its
# own after a 30-60s cold start), a paused Supabase project needs someone
# to click "Restore" in the Supabase dashboard by hand; no request can
# wake it back up. .github/workflows/supabase-ping.yml hits this endpoint
# every few days so Supabase never sees the project go quiet long enough
# to pause it, and — since that can still happen (abuse flag, owner
# request, a run the ping missed, etc.) — tells the caller plainly when
# it already has, so that workflow can fail loudly (GitHub emails the
# repo owner on a failed scheduled run) instead of the outage being
# discovered only when someone opens the site and it's broken.

_SUPABASE_PAUSED_HTTP_STATUS = 540  # Supabase's own custom code for "this project is paused"


def _require_ping_token(request: Request):
    """Separate from _require_site_auth: this endpoint is meant to be hit
    unattended by a scheduled job, not a logged-in person, so it can't
    require the site's username/password. With no PING_TOKEN configured
    it's left open — it only ever runs one cheap, read-only Supabase
    query with no PII, which isn't worth locking down further for a small
    internal tool — but setting one keeps random internet traffic from
    needlessly poking Supabase and waking a sleeping Render instance."""
    if not settings.PING_TOKEN:
        return
    token = request.query_params.get("token") or request.headers.get("X-Ping-Token")
    if not secrets.compare_digest(token or "", settings.PING_TOKEN):
        raise HTTPException(401, "Neplatny ping token.")


@app.get("/api/ping/supabase", dependencies=[Depends(_require_ping_token)])
@limiter.limit("30/hour")
async def ping_supabase(request: Request):
    """Runs one real Supabase query (resetting its inactivity clock) and
    reports whether the project is healthy, merely slow/erroring, or has
    actually been paused outright.

    Supabase's API gateway answers a *paused* project with its own custom
    540 status — a real HTTP response, not a dropped connection — so
    that's the only signal treated as the hard "needs a human to click
    Restore" case (503 here, which a `curl --fail`-style check in the cron
    workflow can key off). A network-level failure (timeout, connection
    refused, DNS hiccup) is NOT the same thing — a paused project still
    answers 540 rather than dropping the connection — so those, along with
    any other unexpected status Supabase might return, are logged for
    visibility but reported back as 200: nothing here needs to page
    anyone over an ordinary blip.
    Reference: https://supabase.com/docs/guides/troubleshooting/http-status-codes
    """
    if not settings.SUPABASE_URL or not settings.SUPABASE_KEY:
        return {"status": "not_configured"}

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{settings.SUPABASE_URL}/rest/v1/companies",
                headers=_supabase_headers(),
                params={"select": "id", "limit": 1},
            )
    except httpx.RequestError as e:
        logging.getLogger(__name__).warning("supabase ping: network error (not a confirmed pause): %s", e)
        return {"status": "network_error", "detail": str(e)}

    if resp.status_code == _SUPABASE_PAUSED_HTTP_STATUS:
        logging.getLogger(__name__).error(
            "supabase ping: project is PAUSED (HTTP 540) — needs a manual Restore in the Supabase dashboard"
        )
        raise HTTPException(
            503,
            "Supabase projekt je pozastaven (HTTP 540) — je potreba rucne kliknout Restore v Supabase dashboardu.",
        )

    if resp.status_code >= 400:
        logging.getLogger(__name__).warning(
            "supabase ping: unexpected status %s (not a confirmed pause): %s", resp.status_code, resp.text
        )
        return {"status": "error", "http_status": resp.status_code}

    return {"status": "ok"}
