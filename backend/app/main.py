"""
KADR.CZ — simplified, stateless document filler.

Flow: upload a document -> AI extracts fields -> pick a blank -> fill ->
download as .docx or .pdf. Nothing is stored between requests; there is
no database. Run:

    uvicorn app.main:app --reload --port 8000
"""
import secrets
import uuid
from pathlib import Path

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel
from typing import Optional

from app.config import settings
from app.ocr_service import recognize_document
from app.blank_service import list_templates, fill_blank, convert_to_pdf

app = FastAPI(title=settings.APP_NAME)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {"app": settings.APP_NAME, "status": "running", "ocr_mode": settings.OCR_MODE}


@app.get("/api/blanks")
def get_blanks():
    """Returns the list of available fillable Word blanks (auto-discovered
    from app/templates/ — add a new .docx there to add a new blank)."""
    return list_templates()


@app.post("/api/recognize")
async def recognize(file: UploadFile = File(...)):
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


@app.post("/api/recognize-text")
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


@app.post("/api/fill")
def fill(payload: FillRequest):
    """Fills the chosen blank with the given fields and returns a
    download token; nothing is saved to a database."""
    try:
        docx_path = fill_blank(payload.template_id, payload.model_dump())
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, f"Chyba při vyplňování: {e}")

    pdf_path = convert_to_pdf(docx_path)

    return {
        "docx_token": docx_path.name,
        "pdf_token": pdf_path.name if pdf_path else None,
    }


@app.get("/api/download/{filename}")
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

    # This endpoint has no auth — the unguessable token in the filename
    # (see blank_service.fill_blank) is the only thing protecting the PII
    # inside. Deleting the file right after it's served makes each token
    # single-use, shrinking the window an attacker would have to guess it.
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
# endpoints return a clear error rather than crashing.

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


_companies_security = HTTPBasic()


def _require_companies_auth(credentials: HTTPBasicCredentials = Depends(_companies_security)):
    """Gates every /api/companies* route behind a shared username/password
    (browser shows its native login prompt) — this data is shared across
    all visitors and feeds directly into real employment contracts, so it
    must not be writable/readable by anonymous requests."""
    if not settings.COMPANIES_USERNAME or not settings.COMPANIES_PASSWORD:
        raise HTTPException(
            503,
            "Přihlašovací údaje pro sdílené firmy nejsou nastavené — chybí "
            "COMPANIES_USERNAME / COMPANIES_PASSWORD na serveru.",
        )
    valid_username = secrets.compare_digest(credentials.username, settings.COMPANIES_USERNAME)
    valid_password = secrets.compare_digest(credentials.password, settings.COMPANIES_PASSWORD)
    if not (valid_username and valid_password):
        raise HTTPException(
            401,
            "Neplatné přihlašovací údaje.",
            headers={"WWW-Authenticate": "Basic"},
        )


@app.get("/api/companies", dependencies=[Depends(_require_companies_auth)])
async def list_companies():
    _require_supabase()
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{settings.SUPABASE_URL}/rest/v1/companies",
            headers=_supabase_headers(),
            params={"select": "*", "order": "name.asc"},
        )
    if resp.status_code >= 400:
        raise HTTPException(502, f"Supabase chyba: {resp.text}")
    return resp.json()


@app.post("/api/companies", status_code=201, dependencies=[Depends(_require_companies_auth)])
async def create_company(payload: CompanyIn):
    _require_supabase()
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{settings.SUPABASE_URL}/rest/v1/companies",
            headers={**_supabase_headers(), "Prefer": "return=representation"},
            json=payload.model_dump(),
        )
    if resp.status_code >= 400:
        raise HTTPException(502, f"Supabase chyba: {resp.text}")
    result = resp.json()
    return result[0] if isinstance(result, list) else result


@app.put("/api/companies/{company_id}", dependencies=[Depends(_require_companies_auth)])
async def update_company(company_id: str, payload: CompanyIn):
    _require_supabase()
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.patch(
            f"{settings.SUPABASE_URL}/rest/v1/companies",
            headers={**_supabase_headers(), "Prefer": "return=representation"},
            params={"id": f"eq.{company_id}"},
            json=payload.model_dump(),
        )
    if resp.status_code >= 400:
        raise HTTPException(502, f"Supabase chyba: {resp.text}")
    result = resp.json()
    return result[0] if isinstance(result, list) else result


@app.delete("/api/companies/{company_id}", status_code=204, dependencies=[Depends(_require_companies_auth)])
async def delete_company(company_id: str):
    _require_supabase()
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.delete(
            f"{settings.SUPABASE_URL}/rest/v1/companies",
            headers=_supabase_headers(),
            params={"id": f"eq.{company_id}"},
        )
    if resp.status_code >= 400:
        raise HTTPException(502, f"Supabase chyba: {resp.text}")
    return None
