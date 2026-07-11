"""
KADR.CZ — simplified, stateless document filler.

Flow: upload a document -> AI extracts fields -> pick a blank -> fill ->
download as .docx or .pdf. Nothing is stored between requests; there is
no database. Run:

    uvicorn app.main:app --reload --port 8000
"""
import uuid
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
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


class FillRequest(BaseModel):
    template_id: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    address: Optional[str] = None
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
def download(filename: str):
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
    return FileResponse(path, filename=filename, media_type=media_type)
