"""
Blank/template filling service — no database involved.

Any .docx file dropped into app/templates/ with {{PLACEHOLDER}} tags is
automatically picked up and offered as a fillable blank. To add a new
blank type: just add a new .docx file to that folder — no code change.

The filename (without extension) becomes the blank's internal id; a
human-readable title is read from the first heading in the document if
present, otherwise the filename is used.
"""
from datetime import date, datetime
from pathlib import Path
from typing import Optional
import re
import time
import uuid

from docx import Document as DocxDocument
from docxtpl import DocxTemplate

from app.config import settings

# Files normally get deleted right after being downloaded (see
# main.py's /api/download), but a file the user never comes back for
# (closed the tab, only grabbed the PDF and not the Word copy, etc.)
# would otherwise sit on disk forever. Anything older than this is swept
# on the next generation request — no cron/queue needed for a handful of
# files a day.
STALE_GENERATED_FILE_MAX_AGE_HOURS = 24


def _cleanup_stale_generated_files() -> None:
    cutoff = time.time() - STALE_GENERATED_FILE_MAX_AGE_HOURS * 3600
    for path in settings.GENERATED_DIR.iterdir():
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            pass  # another request may have already removed it — fine


_templates_cache: Optional[list[dict]] = None
_templates_cache_signature: Optional[tuple] = None


def list_templates() -> list[dict]:
    """Scans the templates folder and returns available blanks.

    This runs on every /api/blanks call *and*, for the template_id
    whitelist check, on every /api/fill call — so the expensive part
    (opening each .docx with python-docx to read its title) is cached
    and only redone when a file was actually added, removed, or
    modified. The cheap stat()-based signature check that guards it
    still re-reflects a new/renamed/edited .docx immediately.
    """
    global _templates_cache, _templates_cache_signature

    paths = [
        p for p in sorted(settings.TEMPLATES_DIR.glob("*.docx"))
        if not p.name.startswith("~$")  # skip Word lock files
    ]
    signature = tuple((p.name, p.stat().st_mtime) for p in paths)

    if _templates_cache is not None and signature == _templates_cache_signature:
        return _templates_cache

    templates = [
        {"id": p.stem, "title": _read_title(p) or p.stem.replace("_", " ").title()}
        for p in paths
    ]
    _templates_cache = templates
    _templates_cache_signature = signature
    return templates


def _read_title(path: Path) -> Optional[str]:
    try:
        doc = DocxDocument(str(path))
        for para in doc.paragraphs[:3]:
            if para.text.strip():
                return para.text.strip()
    except Exception:
        pass
    return None


def _fmt_date(d) -> str:
    if not d:
        return ""
    if isinstance(d, str):
        # Frontend sends ISO format (YYYY-MM-DD) or the user may type
        # dd.mm.yyyy directly — normalize either to Czech dd.mm.yyyy style.
        for fmt in ("%Y-%m-%d", "%d.%m.%Y"):
            try:
                return datetime.strptime(d, fmt).strftime("%d.%m.%Y")
            except ValueError:
                continue
        return d  # unrecognized format — show as typed rather than fail
    return d.strftime("%d.%m.%Y")


def _safe_filename_part(value: str, fallback: str = "") -> str:
    """Strips anything but letters/digits/underscore/hyphen so a value can
    never inject path separators or traversal sequences into a filename."""
    cleaned = re.sub(r"[^\w-]", "_", value or "", flags=re.UNICODE).strip("_")
    return cleaned or fallback


def fill_blank(template_id: str, fields: dict) -> Path:
    """
    Fills the given template with the provided field values and returns
    the output .docx path. `fields` keys should match the template's
    {{PLACEHOLDER}} names (case-insensitive match on common aliases below).
    """
    _cleanup_stale_generated_files()

    # template_id must be one of the ids we actually discovered on disk —
    # never trust the client's raw string when building a filesystem path
    # (e.g. an absolute path would otherwise override TEMPLATES_DIR entirely).
    valid_ids = {t["id"] for t in list_templates()}
    if template_id not in valid_ids:
        raise FileNotFoundError(f"Šablona '{template_id}' nenalezena.")

    template_path = settings.TEMPLATES_DIR / f"{template_id}.docx"
    if not template_path.exists():
        raise FileNotFoundError(f"Šablona '{template_id}' nenalezena.")

    doc = DocxTemplate(str(template_path))

    # Normalize context: fill both the raw keys given and today's date,
    # defaulting missing fields to empty strings so rendering never fails
    # on an unmapped placeholder.
    context = {
        "JMENO": fields.get("first_name", ""),
        "PRIJMENI": fields.get("last_name", ""),
        "ADRESA": fields.get("address", ""),
        "ADRESA_PUVODU": fields.get("address_origin", ""),
        "DATUM_NAROZENI": _fmt_date(fields.get("birth_date")),
        "CISLO_DOKLADU": fields.get("doc_number", ""),
        "STATNI_PRISLUSNOST": fields.get("nationality", ""),
        "POZICE": fields.get("position", ""),
        "MISTO_VYKONU": fields.get("workplace", ""),
        "MZDA": fields.get("salary", ""),
        "HODIN_TYDNE": fields.get("hours_per_week", ""),
        "DATUM_NASTUPU": _fmt_date(fields.get("start_date")),
        "DATUM_UKONCENI": _fmt_date(fields.get("end_date")),
        "BANKOVNI_UCET": fields.get("bank_account", ""),
        "FIRMA": fields.get("company_name", ""),
        "ICO": fields.get("company_ico", ""),
        "DIC": fields.get("company_dic", ""),
        "ADRESA_FIRMY": fields.get("company_address", ""),
        "ZASTUPCE_FIRMY": fields.get("company_representative", ""),
        "DATUM_DNES": _fmt_date(date.today()),
        # DPP-specific: foreign worker residence/visa info + auto years
        "CISLO_VIZA": fields.get("visa_number", ""),
        "PLATNOST_VIZA": _fmt_date(fields.get("visa_validity")) or fields.get("visa_validity", ""),
        "DRUH_POBYTU": fields.get("residence_type", ""),
        "MISTO_PODPISU": fields.get("signing_place", "Praze"),
        "ROK_AKTUALNI": str(date.today().year),
        "ROK_PRISTI": str(date.today().year + 1),
        # Ukončení pracovního poměru (termination)
        "DUVOD_UKONCENI": fields.get("termination_reason", ""),
        "POSLEDNI_DEN": _fmt_date(fields.get("last_working_day")),
        # Výplatní páska (payslip)
        "OBDOBI": fields.get("pay_period", ""),
        "HRUBA_MZDA": fields.get("gross_salary", ""),
        "ZDRAVOTNI_POJISTENI": fields.get("health_insurance", ""),
        "SOCIALNI_POJISTENI": fields.get("social_insurance", ""),
        "DAN_ZE_MZDY": fields.get("income_tax", ""),
        "CISTA_MZDA": fields.get("net_salary", ""),
    }
    doc.render(context)

    safe_last = _safe_filename_part(fields.get("last_name"), "dokument")
    safe_first = _safe_filename_part(fields.get("first_name"))
    # Full 128-bit token — this is the *only* thing standing between an
    # anonymous request and a document full of PII (birth date, ID number,
    # address, salary, bank account), since /api/download has no auth.
    # A short 6-hex-char suffix (24 bits, ~16.7M values) was brute-forceable;
    # a full UUID4 is not.
    unique = uuid.uuid4().hex
    out_name = f"{template_id}_{safe_last}_{safe_first}_{unique}.docx".strip("_")
    out_path = (settings.GENERATED_DIR / out_name).resolve()

    # Defense in depth: even though every input above is now sanitized,
    # refuse to write anywhere outside GENERATED_DIR.
    if settings.GENERATED_DIR.resolve() not in out_path.parents:
        raise ValueError("Neplatná cesta k vygenerovanému souboru.")

    doc.save(str(out_path))
    return out_path


def convert_to_pdf(docx_path: Path) -> Optional[Path]:
    import subprocess
    import shutil

    binary = shutil.which("soffice") or shutil.which("libreoffice")
    if not binary:
        return None
    try:
        # A simple one-page docx converts in a couple of seconds; 60s of
        # headroom just meant a stuck/hung LibreOffice process held the
        # whole /api/fill request (and the user's browser) hostage for a
        # full minute before finally giving up and offering the .docx
        # without a PDF anyway. 20s is still generous slack.
        subprocess.run(
            [binary, "--headless", "--convert-to", "pdf", "--outdir", str(settings.GENERATED_DIR), str(docx_path)],
            check=True, capture_output=True, timeout=20,
        )
        pdf_path = docx_path.with_suffix(".pdf")
        return pdf_path if pdf_path.exists() else None
    except Exception:
        return None
