"""Fills the official "Prohlášení poplatníka daně z příjmů..." tax form
(MFin 5457) by overlaying text next to its printed labels, rather than
form-filling — a check with pypdf confirmed this PDF has no AcroForm
fields (it's a flat scan/export), so there's nothing to fill
programmatically. Only the handful of header fields on page 1 that we
actually have data for are overlaid; everything else (tax-credit
checkboxes, dependent-children tables, page 2, signatures) is left
exactly as in the original for the person to fill in by hand — this
never edits the form's own structure.

Positions are found at runtime via fitz's Page.search_for(), which
returns each label's exact bounding box in the same point-based,
top-left-origin coordinate system Page.insert_text() uses — not
hardcoded coordinates read off a rendered preview by eye. That manual
approach was tried first and was consistently wrong (confirmed by
comparing against search_for()'s real bounding boxes: e.g. "Název
plátce daně" is actually at y≈132-143, not y≈291 as an earlier visual
read of a rendered grid overlay had suggested) — searching for the
actual label text sidesteps that failure mode entirely and stays
correct even if a future revision of the form shifts the layout
slightly.
"""
from pathlib import Path
from typing import Optional
import uuid

import fitz

from app.config import settings
from app.blank_service import _s, _fmt_date, _safe_filename_part

POPLATNIK_SOURCE = Path(__file__).resolve().parent / "templates" / "bundle" / "poplatnik.pdf"

_FONT_SIZE = 9
_X_GAP = 8  # points of horizontal padding after a label before the value starts
_Y_NUDGE = 1  # small upward nudge so the value's baseline sits on the label's own line

# (context key, exact label text as printed on the form, which
# occurrence to use when a label appears more than once — e.g.
# "Příjmení"/"Jméno(-a)" also appear as column headers in the dependent-
# children table further down the page, so occurrence 0 is always the
# "Identifikace poplatníka" section near the top).
_FIELDS = [
    ("FIRMA", "Název plátce daně", 0),
    ("ADRESA_FIRMY", "Adresa", 0),
    ("PRIJMENI", "Příjmení", 0),
    ("JMENO", "Jméno(-a)", 0),
    ("ADRESA", "Adresa bydliště (místo trvalého pobytu)", 0),
    ("DATUM_NAROZENI", "Datum narození", 0),
    ("CISLO_DOKLADU", "Číslo a typ dokladu prokazující totožnost poplatníka", 0),
    ("STATNI_PRISLUSNOST", "Stát, který tento doklad vydal", 0),
]


def _rightmost_edge_per_line(rects: list) -> list:
    """search_for() can return more than one Rect for what is visually one
    line of label text — confirmed for "Adresa bydliště (místo trvalého
    pobytu)", which came back as two adjacent rects rather than one
    (likely a font/style change partway through the phrase in the PDF's
    own text layout). Treating each of those as a separate "occurrence"
    would misalign the (key, label, occurrence) list above and, for a
    label appearing only once, silently pick the wrong (earlier, narrower)
    rect as its position — visually landing the value under the
    parenthetical part of the label instead of after it. Groups rects
    that share a line (close y0) and keeps only the rightmost edge of
    each group, so multi-rect single-line labels behave like one match."""
    if not rects:
        return []
    by_line: list[list] = []
    for r in sorted(rects, key=lambda r: (r.y0, r.x0)):
        if by_line and abs(by_line[-1][-1].y0 - r.y0) < 2:
            by_line[-1].append(r)
        else:
            by_line.append([r])
    merged = []
    for group in by_line:
        rightmost = max(group, key=lambda r: r.x1)
        merged.append(fitz.Rect(group[0].x0, group[0].y0, rightmost.x1, rightmost.y1))
    return merged


def _build_overlay_context(fields: dict) -> dict:
    """Same field set _build_context() (blank_service.py) uses, but only
    the handful of keys this form actually overlays — kept separate so a
    change to the main contracts' context shape can't silently break
    this form."""
    return {
        "FIRMA": _s(fields, "company_name"),
        "ADRESA_FIRMY": _s(fields, "company_address"),
        "PRIJMENI": _s(fields, "last_name"),
        "JMENO": _s(fields, "first_name"),
        "ADRESA": _s(fields, "address"),
        "DATUM_NAROZENI": _fmt_date(fields.get("birth_date")),
        "CISLO_DOKLADU": _s(fields, "doc_number"),
        "STATNI_PRISLUSNOST": _s(fields, "nationality"),
    }


def fill_poplatnik_pdf(fields: dict) -> Optional[Path]:
    """Returns the path to a filled copy of the tax declaration PDF, or
    None if the source form is missing (best-effort, same as
    convert_to_pdf() — a bundle-doc problem must never fail the whole
    /api/fill request)."""
    if not POPLATNIK_SOURCE.exists():
        return None
    try:
        context = _build_overlay_context(fields)
        doc = fitz.open(str(POPLATNIK_SOURCE))
        page = doc[0]
        for key, label, occurrence in _FIELDS:
            value = context.get(key, "")
            if not value:
                continue
            # search_for() returns matches in content-stream order, which
            # is NOT reliably top-to-bottom for this PDF (confirmed: a
            # plain "Adresa" search returned the later, lower-on-the-page
            # "Adresa bydliště" substring match *before* the standalone
            # "Adresa" line that appears higher up) — sort by vertical
            # then horizontal position so "occurrence 0" reliably means
            # "topmost, leftmost", matching reading order as printed. Also
            # merge same-line rects (see _rightmost_edge_per_line) so a
            # label split into multiple rects still counts as one
            # occurrence, positioned after its full width.
            rects = _rightmost_edge_per_line(page.search_for(label))
            if occurrence >= len(rects):
                continue  # label not found (or not enough occurrences) — skip rather than guess
            r = rects[occurrence]
            page.insert_text((r.x1 + _X_GAP, r.y1 - _Y_NUDGE), value, fontsize=_FONT_SIZE, fontname="helv")

        safe_last = _safe_filename_part(fields.get("last_name"), "dokument")
        safe_first = _safe_filename_part(fields.get("first_name"))
        unique = uuid.uuid4().hex
        out_name = f"poplatnik_{safe_last}_{safe_first}_{unique}.pdf".strip("_")
        out_path = (settings.GENERATED_DIR / out_name).resolve()
        if settings.GENERATED_DIR.resolve() not in out_path.parents:
            raise ValueError("Neplatná cesta k vygenerovanému souboru.")

        doc.save(str(out_path))
        doc.close()
        return out_path
    except Exception:
        return None
