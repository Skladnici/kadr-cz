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
import base64
import logging
import re
import time
import uuid
from datetime import date, datetime
from io import BytesIO
from pathlib import Path
from typing import Optional

from docx import Document as DocxDocument
from docx.shared import Mm
from docxtpl import DocxTemplate, InlineImage
from PIL import Image as PILImage

from app.config import settings

logger = logging.getLogger(__name__)

# Files normally get deleted right after being downloaded (see
# main.py's /api/download), but a file the user never comes back for
# (closed the tab, only grabbed the PDF and not the Word copy, etc.)
# would otherwise sit on disk forever. Anything older than this is swept
# on the next generation request — no cron/queue needed for a handful of
# files a day.
STALE_GENERATED_FILE_MAX_AGE_HOURS = 24

# Default text for the {{PODPIS_ZAMESTNANCE}}/{{PODPIS_ZAMESTNAVATELE}}
# tags on an unsigned contract — the same dotted line dpp_template.docx
# originally had hardcoded before those tags existed.
SIGNATURE_PLACEHOLDER = "…" * 10 + "."


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
        # Signature lines on the four contract templates (dpp/hpp/dpc/
        # ukonceni) — plain placeholder dots by default. render_signed_
        # contract() below overrides either key with an InlineImage once
        # an actual signature exists; fill_blank() (ordinary, unsigned
        # generation) never does, so a freshly generated contract just
        # shows this same dotted line the templates always had.
        "PODPIS_ZAMESTNANCE": SIGNATURE_PLACEHOLDER,
        "PODPIS_ZAMESTNAVATELE": SIGNATURE_PLACEHOLDER,
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


# The only templates with a {{PODPIS_ZAMESTNANCE}} signature line at all
# (see the four *_template.docx edits made for the e-signature feature) —
# vyplatni_paska has no signature line, so offering "Vytvořit odkaz k
# podpisu" for it wouldn't have anywhere in the document to put one.
SIGNABLE_TEMPLATE_IDS = {"dpp_template", "hpp_template", "dpc_template", "ukonceni_pracovniho_pomeru"}

# DPP/DPČ/HPP are the three "employment onboarding" contract types that
# get the standard bundle (GDPR consent + health declaration + tax
# declaration, alongside the main contract) — the ukončení/výplatní
# paska blanks are standalone documents, not part of a new-hire packet.
# Single source of truth for both /api/fill's unsigned bundle (main.py)
# and render_signed_bundle()'s signed one below, so the two can never
# drift on which template_ids get bundle docs.
BUNDLE_TEMPLATE_IDS = {"dpp_template", "dpc_template", "hpp_template"}


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


def convert_to_pdf(docx_path: Path, timeout: int = 20) -> Optional[Path]:
    """`timeout` defaults to 20s — a simple one-page docx converts in a
    couple of seconds, and 60s of headroom used to just mean a stuck/hung
    LibreOffice process held the whole /api/fill request (and the user's
    browser) hostage for a full minute before finally giving up. That
    default is still right for /api/fill's own interactive, actively-
    waited-on call. It is NOT enough for every document, though: a real
    500 traced back to zdravotni_template.docx specifically — at 2.5MB
    with several embedded fonts (vs. ~16KB for the other bundle docs),
    it's plausibly slower to convert than this default accounts for,
    especially on Render's constrained CPU, and headless LibreOffice has
    its own known rough edges with Word's obfuscated embedded-font format
    that could independently be part of it. get_sign_link_pdf's own
    read-before-signing preview (backed by the frontend's already-generous
    retry/backoff — see SignPage.jsx) passes a longer timeout here for
    exactly that document, so a conversion that's merely slow (rather
    than genuinely hung) gets the chance to actually finish instead of
    being cut off at the interactive-path's tighter default."""
    import subprocess
    import shutil

    binary = shutil.which("soffice") or shutil.which("libreoffice")
    if not binary:
        return None
    try:
        subprocess.run(
            [binary, "--headless", "--convert-to", "pdf", "--outdir", str(settings.GENERATED_DIR), str(docx_path)],
            check=True, capture_output=True, timeout=timeout,
        )
        pdf_path = docx_path.with_suffix(".pdf")
        return pdf_path if pdf_path.exists() else None
    except subprocess.TimeoutExpired:
        logger.warning("LibreOffice conversion timed out (%ss) for %s", timeout, docx_path.name)
        return None
    except subprocess.CalledProcessError as e:
        # Not logged with exc_info — this is LibreOffice's own stderr, not
        # a Python traceback, and it's usually the actually useful part.
        logger.warning(
            "LibreOffice conversion failed for %s (exit %s): %s",
            docx_path.name, e.returncode, (e.stderr or b"").decode("utf-8", "replace")[:2000],
        )
        return None
    except Exception:
        logger.exception("LibreOffice conversion raised unexpectedly for %s", docx_path.name)
        return None


# ------------------------------------------------------------ E-signature
# Powers the /api/podepsat/{token}* public routes and the admin's
# /api/sign-links/{token}/download in main.py. Deliberately re-renders
# from scratch every time (the read-before-signing preview, the sign
# step itself, the employee's one-time download, and any later admin
# re-download) rather than persisting a rendered file anywhere: the only
# state that has to survive between those calls is `fields` (the exact
# FillRequest payload from the original /api/fill) and, once signed,
# `signature_image` — both plain data already sitting in Supabase's
# sign_links table. That sidesteps Render's ephemeral disk (a redeploy
# mid-flow would otherwise silently orphan a pending signing link) at
# the cost of one extra LibreOffice conversion per view/download.


# Fixed footprint for the signature on the printed line, in millimeters.
# A *height* cap is needed alongside the width one now that the frontend
# crops the signature tightly to just the drawn ink (see SignPage.jsx's
# croppedSignatureDataUrl) rather than exporting the whole signing
# canvas — that canvas was always a wide, mostly-empty rectangle, so a
# width-only size used to be enough; a tightly-cropped stroke can come
# out narrow-and-tall instead (a quick vertical mark, a stylized
# initial, ...), and a real report found exactly that: signing produced
# a signature rendered many times taller than the line it was meant to
# sit on, because width alone doesn't bound height when the image's
# native aspect ratio is left free to scale it. Rather than assume how
# wide vs. tall any given signature will be, both dimensions are capped
# and the image is scaled (up OR down) to fit inside that box while
# keeping its own aspect ratio — the tighter of the two axes wins.
SIGNATURE_MAX_WIDTH_MM = 35
SIGNATURE_MAX_HEIGHT_MM = 15


def _signature_or_placeholder(tpl: DocxTemplate, signature_b64: Optional[str]):
    """Returns an InlineImage for a base64-encoded signature PNG, or the
    same dotted-line placeholder fill_blank()'s unsigned contracts show,
    if there's no signature (yet) to draw."""
    if not signature_b64:
        return SIGNATURE_PLACEHOLDER
    try:
        image_bytes = base64.b64decode(signature_b64, validate=True)
        width_mm, height_mm = SIGNATURE_MAX_WIDTH_MM, SIGNATURE_MAX_HEIGHT_MM
        try:
            with PILImage.open(BytesIO(image_bytes)) as img:
                px_w, px_h = img.size
            if px_w > 0 and px_h > 0:
                scale = min(SIGNATURE_MAX_WIDTH_MM / px_w, SIGNATURE_MAX_HEIGHT_MM / px_h)
                width_mm = px_w * scale
                height_mm = px_h * scale
        except Exception:
            # Can't introspect this image's pixel size for some reason —
            # fall back to the fixed box above rather than let a sizing
            # hiccup turn into a failed generation.
            logger.warning("could not read signature image dimensions — using fixed box", exc_info=True)
        return InlineImage(tpl, BytesIO(image_bytes), width=Mm(width_mm), height=Mm(height_mm))
    except Exception:
        logger.warning("signature_image failed to decode — falling back to placeholder", exc_info=True)
        return SIGNATURE_PLACEHOLDER


def render_signed_contract(
    template_id: str,
    fields: dict,
    employee_signature_b64: Optional[str] = None,
    employer_signature_b64: Optional[str] = None,
) -> Path:
    """Re-renders one of the SIGNABLE_TEMPLATE_IDS contracts from a saved
    `fields` snapshot, with either signature drawn in if supplied.

    employer_signature_b64 has no caller yet — there's no UI for an
    employer to upload their own signature image. It's threaded through
    now so that future feature only has to start passing a value here;
    it doesn't need to touch this function, the employee-signing
    endpoints, or their own separate, independent {{PODPIS_ZAMESTNAVATELE}}
    tag in the templates.
    """
    if template_id not in SIGNABLE_TEMPLATE_IDS:
        raise ValueError(f"Šablona '{template_id}' nepodporuje podpis odkazem.")

    template_path = settings.TEMPLATES_DIR / f"{template_id}.docx"
    if not template_path.exists():
        raise FileNotFoundError(f"Šablona '{template_id}' nenalezena.")

    tpl = DocxTemplate(str(template_path))
    context = _build_context(fields, template_id)
    context["PODPIS_ZAMESTNANCE"] = _signature_or_placeholder(tpl, employee_signature_b64)
    context["PODPIS_ZAMESTNAVATELE"] = _signature_or_placeholder(tpl, employer_signature_b64)
    tpl.render(context)

    safe_last = _safe_filename_part(fields.get("last_name"), "dokument")
    safe_first = _safe_filename_part(fields.get("first_name"))
    unique = uuid.uuid4().hex
    out_name = f"podepsano_{safe_last}_{safe_first}_{unique}.docx".strip("_")
    out_path = (settings.GENERATED_DIR / out_name).resolve()

    if settings.GENERATED_DIR.resolve() not in out_path.parents:
        raise ValueError("Neplatná cesta k vygenerovanému souboru.")

    tpl.save(str(out_path))
    return out_path


# GDPR consent and the health declaration both got a {{PODPIS_ZAMESTNANCE}}
# tag added to their .docx (replacing what used to be a plain dotted/
# underscore line meant for a wet signature) specifically so the e-sign
# flow below can fill them in too — a signed packet with only the main
# contract signed and the other bundle docs still showing a blank line
# was confusing admins into thinking the employee hadn't actually signed
# everything. vyplatni_paska has no such tag (see SIGNABLE_TEMPLATE_IDS'
# own docstring) and poplatnik.pdf isn't a docxtpl document at all — its
# signature is overlaid separately, in pdf_fill.py's fill_poplatnik_pdf.
BUNDLE_SIGNABLE_DOCX = {"gdpr_template", "zdravotni_template"}


def _render_signed_bundle_docx(name: str, fields: dict, employee_signature_b64: Optional[str]) -> Optional[Path]:
    """Same idea as render_signed_contract(), for one bundle document
    instead of the main contract. Returns None (never raises) on any
    problem, same as _fill_bundle_docx's own best-effort contract — one
    bad bundle doc must never take down the whole signed packet."""
    template_path = BUNDLE_TEMPLATES_DIR / f"{name}.docx"
    if not template_path.exists():
        logger.warning("bundle template not found on disk: %s", template_path)
        return None
    try:
        tpl = DocxTemplate(str(template_path))
        context = _build_context(fields, name)
        context["PODPIS_ZAMESTNANCE"] = _signature_or_placeholder(tpl, employee_signature_b64)
        tpl.render(context)

        safe_last = _safe_filename_part(fields.get("last_name"), "dokument")
        safe_first = _safe_filename_part(fields.get("first_name"))
        unique = uuid.uuid4().hex
        out_name = f"podepsano_{name}_{safe_last}_{safe_first}_{unique}.docx".strip("_")
        out_path = (settings.GENERATED_DIR / out_name).resolve()
        if settings.GENERATED_DIR.resolve() not in out_path.parents:
            raise ValueError("Neplatná cesta k vygenerovanému souboru.")

        tpl.save(str(out_path))
        return out_path
    except Exception:
        logger.exception("failed to render signed bundle document %r", name)
        return None


def render_signed_bundle(
    template_id: str, fields: dict, employee_signature_b64: Optional[str] = None,
) -> list[tuple[str, Path]]:
    """Re-renders the *whole* signable packet for one sign_links row —
    the main contract plus, for a DPP/DPČ/HPP link (see
    BUNDLE_TEMPLATE_IDS), the GDPR consent and health declaration — each
    with the employee's signature dropped in wherever that document has
    a spot for one. Returns [(zip entry name, rendered path), ...],
    using the exact same entry names as the unsigned bundle's own zip
    (see frontend/src/utils/zipDownload.js's BUNDLE_FILE_SPECS) so a
    signed download looks the same shape as an unsigned one to whoever
    opens it. poplatnik.pdf is deliberately not produced here — it isn't
    a docxtpl document, so its signed version is rendered separately by
    the caller via pdf_fill.fill_poplatnik_pdf and appended to the same
    list (see main.py's _build_signed_zip_entries)."""
    entries: list[tuple[str, Path]] = [
        ("smlouva.docx", render_signed_contract(template_id, fields, employee_signature_b64)),
    ]
    if template_id in BUNDLE_TEMPLATE_IDS:
        for name, zip_name in (("gdpr_template", "souhlas_gdpr.docx"), ("zdravotni_template", "prohlaseni_zdravotni.docx")):
            path = _render_signed_bundle_docx(name, fields, employee_signature_b64)
            if path is not None:
                entries.append((zip_name, path))
    return entries
