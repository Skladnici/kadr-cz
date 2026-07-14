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
import logging
import secrets
import uuid
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
from app.blank_service import list_templates, fill_blank, convert_to_pdf

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


# Rate limiting for the two endpoints that hit an external, quota-limited
# service (OCR.space, free tier: ~500 requests/day for the whole site) or
# that do real disk/CPU work generating documents (LibreOffice PDF
# conversion) — a runaway client (buggy retry loop, or someone hammering
# the upload button) could otherwise burn through the daily OCR quota or
# pile up disk writes well before the site-wide auth would ever stop them,
# since auth just proves *who* is asking, not how fast. Keyed by IP rather
# than by logged-in identity — everyone shares one SITE_USERNAME/PASSWORD,
# so there's no per-user identity to key on anyway.
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


def _require_site_auth(credentials: HTTPBasicCredentials = Depends(_site_security)):
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
    valid_username = secrets.compare_digest(credentials.username, settings.SITE_USERNAME)
    valid_password = secrets.compare_digest(credentials.password, settings.SITE_PASSWORD)
    if not (valid_username and valid_password):
        raise HTTPException(
            401,
            "Neplatné přihlašovací údaje.",
            headers={"WWW-Authenticate": "Basic"},
        )


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
    termination_reason: Optional[str] = None
    last_working_day: Optional[str] = None
    pay_period: Optional[str] = None
    gross_salary: Optional[str] = None
    health_insurance: Optional[str] = None
    social_insurance: Optional[str] = None
    income_tax: Optional[str] = None
    net_salary: Optional[str] = None


@app.post("/api/fill", dependencies=[Depends(_require_site_auth)])
@limiter.limit("10/minute")
async def fill(request: Request, payload: FillRequest):
    """Fills the chosen blank with the given fields and returns a
    download token; nothing is saved to a database."""
    try:
        docx_path = fill_blank(payload.template_id, payload.model_dump())
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, f"Chyba při vyplňování: {e}")

    # convert_to_pdf() shells out to LibreOffice and can take real
    # wall-clock seconds — offload it so it doesn't tie up this request's
    # thread any longer than the subprocess call itself needs.
    pdf_path = await asyncio.to_thread(convert_to_pdf, docx_path)

    return {
        "docx_token": docx_path.name,
        "pdf_token": pdf_path.name if pdf_path else None,
    }


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
