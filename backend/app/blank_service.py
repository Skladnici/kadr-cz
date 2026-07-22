"""
Blank/template filling service — no database involved.

Any .docx file dropped into app/templates/ with {{PLACEHOLDER}} tags is
automatically picked up and offered as a fillable blank. To add a new
blank type: just add a new .docx file to that folder — no code change.

The filename (without extension) becomes the blank's internal id; a
human-readable title is read from the first heading in the document if
present, otherwise the filename is used.

hpp_template.docx (pracovní smlouva na hlavní pracovní poměr) is an
original draft based on publicly available §34 zákoníku práce 2026
requirements — it is not legal advice, and a lawyer or mzdová účetní
should review it before real use (the template text itself carries the
same note). dpp_template.docx and dpc_template.docx are digitized from
the user's own real-world templates.
"""
from datetime import date, datetime
from pathlib import Path
from typing import Optional
import logging
import re
import time
import uuid

from docx import Document as DocxDocument
from docxtpl import DocxTemplate

from app.config import settings

logger = logging.getLogger(__name__)

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


def _s(fields: dict, key: str, default: str = "") -> str:
    """Same as fields.get(key, default), except a key that's *present*
    with value None also falls back to default. FillRequest (main.py)
    declares every field Optional[str] = None, so payload.model_dump()
    always includes every key — any field the frontend didn't send comes
    through as None rather than missing, and plain fields.get(key,
    default) doesn't catch that (the key IS there, just with value None).
    Left uncaught, docxtpl/Jinja2 renders str(None) as the literal text
    "None" in the generated document — a real bug users hit whenever an
    optional field they left blank happened not to get sent at all."""
    v = fields.get(key)
    return v if v is not None else default


def _build_context(fields: dict, template_id: str = "") -> dict:
    """Normalizes the raw `fields` dict (from FillRequest.model_dump())
    into the {{PLACEHOLDER}} context every template — the three main
    contracts and the bundle docs (GDPR/health declaration) alike — is
    rendered with. Shared by fill_blank() and _fill_bundle_docx() so
    both read the exact same fields the person filled in once, rather
    than each maintaining its own (and inevitably drifting) mapping."""
    context = {
        "JMENO": _s(fields, "first_name"),
        "PRIJMENI": _s(fields, "last_name"),
        "ADRESA": _s(fields, "address"),
        "ADRESA_PUVODU": _s(fields, "address_origin"),
        "DATUM_NAROZENI": _fmt_date(fields.get("birth_date")),
        "CISLO_DOKLADU": _s(fields, "doc_number"),
        "STATNI_PRISLUSNOST": _s(fields, "nationality"),
        "POZICE": _s(fields, "position"),
        "MISTO_VYKONU": _s(fields, "workplace"),
        "MZDA": _s(fields, "salary"),
        "HODIN_TYDNE": _s(fields, "hours_per_week"),
        "DATUM_NASTUPU": _fmt_date(fields.get("start_date")),
        "DATUM_UKONCENI": _fmt_date(fields.get("end_date")),
        "BANKOVNI_UCET": _s(fields, "bank_account"),
        "FIRMA": _s(fields, "company_name"),
        "ICO": _s(fields, "company_ico"),
        "DIC": _s(fields, "company_dic"),
        "ADRESA_FIRMY": _s(fields, "company_address"),
        "ZASTUPCE_FIRMY": _s(fields, "company_representative"),
        "DATUM_DNES": _fmt_date(date.today()),
        # DPP/DPČ/HPP-specific: foreign worker residence/visa info + auto years
        "CISLO_VIZA": _s(fields, "visa_number"),
        "PLATNOST_VIZA": _fmt_date(fields.get("visa_validity")) or _s(fields, "visa_validity"),
        "DRUH_POBYTU": _s(fields, "residence_type"),
        "MISTO_PODPISU": _s(fields, "signing_place", "Praze"),
        "ROK_AKTUALNI": str(date.today().year),
        "ROK_PRISTI": str(date.today().year + 1),
        # HPP-specific: optional probation period + fixed-term/indefinite switch
        "ZKUSEBNI_DOBA": _s(fields, "probation_period"),
        "DOBA_NEURCITA": bool(fields.get("contract_indefinite")),
        # Ukončení pracovního poměru (termination)
        "DUVOD_UKONCENI": _s(fields, "termination_reason"),
        "POSLEDNI_DEN": _fmt_date(fields.get("last_working_day")),
        # Výplatní páska (payslip)
        "OBDOBI": _s(fields, "pay_period"),
        "HRUBA_MZDA": _s(fields, "gross_salary"),
        "ZDRAVOTNI_POJISTENI": _s(fields, "health_insurance"),
        "SOCIALNI_POJISTENI": _s(fields, "social_insurance"),
        "DAN_ZE_MZDY": _s(fields, "income_tax"),
        "CISTA_MZDA": _s(fields, "net_salary"),
    }

    # DPP's "Místo výkonu práce" is always Czechia, regardless of whatever
    # the workplace field was filled with (e.g. a specific employer
    # address) — fixed per business requirement rather than left to input.
    if template_id == "dpp_template":
        context["MISTO_VYKONU"] = "ČR"

    return context


def _render_and_save(template_path: Path, fields: dict, out_prefix: str) -> Path:
    """Shared render+save core for both a public (template_id-based)
    blank and an internal bundle document — same context, same
    filename/path-safety handling, only the template file and output
    name prefix differ."""
    doc = DocxTemplate(str(template_path))
    doc.render(_build_context(fields, out_prefix))

    safe_last = _safe_filename_part(fields.get("last_name"), "dokument")
    safe_first = _safe_filename_part(fields.get("first_name"))
    # Full 128-bit token — this is the *only* thing standing between an
    # anonymous request and a document full of PII (birth date, ID number,
    # address, salary, bank account), since /api/download has no auth.
    # A short 6-hex-char suffix (24 bits, ~16.7M values) was brute-forceable;
    # a full UUID4 is not.
    unique = uuid.uuid4().hex
    out_name = f"{out_prefix}_{safe_last}_{safe_first}_{unique}.docx".strip("_")
    out_path = (settings.GENERATED_DIR / out_name).resolve()

    # Defense in depth: even though every input above is now sanitized,
    # refuse to write anywhere outside GENERATED_DIR.
    if settings.GENERATED_DIR.resolve() not in out_path.parents:
        raise ValueError("Neplatná cesta k vygenerovanému souboru.")

    doc.save(str(out_path))
    return out_path


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

    return _render_and_save(template_path, fields, template_id)


# Documents auto-generated alongside a DPP/DPČ/HPP contract (see
# main.py's /api/fill) — GDPR consent + health declaration. Kept in a
# subfolder rather than TEMPLATES_DIR itself so list_templates()'s
# non-recursive glob never picks them up as a user-selectable "Typ
# smlouvy" — they're only ever reachable through _fill_bundle_docx().
BUNDLE_TEMPLATES_DIR = Path(__file__).resolve().parent / "templates" / "bundle"


def _fill_bundle_docx(name: str, fields: dict) -> Optional[Path]:
    """Fills one of the fixed bundle documents (see BUNDLE_TEMPLATES_DIR)
    with the same fields as the main contract. Returns None (rather than
    raising) if the template file is missing, so a bundle doc issue
    never turns a successful contract generation into a failed request —
    same reasoning as convert_to_pdf()'s best-effort PDF conversion.
    Both failure paths are logged (at warning/exception level) rather
    than silently swallowed — a real production report of "only the
    main contract downloaded, no bundle docs" turned out to have left no
    trace anywhere to diagnose from, since this used to return None with
    no logging at all."""
    template_path = BUNDLE_TEMPLATES_DIR / f"{name}.docx"
    if not template_path.exists():
        logger.warning("bundle template not found on disk: %s", template_path)
        return None
    try:
        return _render_and_save(template_path, fields, name)
    except Exception:
        logger.exception("failed to render bundle document %r", name)
        return None


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
