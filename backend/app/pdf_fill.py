"""Fills the official "Prohlášení poplatníka daně z příjmů..." tax form
(MFin 5457) by overlaying text next to its printed labels, rather than
form-filling — a check with pypdf confirmed this PDF has no AcroForm
fields (it's a flat scan/export), so there's nothing to fill
programmatically. Only the handful of header fields on page 1 (plus one
signature-table cell on page 2) that we actually have data for are
overlaid; everything else (tax-credit checkboxes, dependent-children
tables, most of page 2) is left exactly as in the original for the
person to fill in by hand — this never edits the form's own structure.

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

Overlay text is drawn with an embedded DejaVu Sans (see app/fonts/),
not PyMuPDF's "helv" built-in alias. "helv" maps to the strict 8-bit
Base-14 Helvetica font using WinAnsiEncoding, which cannot represent
Czech-specific characters at all (ř, ě, ď, ť, ň, ů — all above U+00FF)
regardless of what fitz.Font(...).has_glyph() reports for a bare "helv"
Font object (that check resolves differently than what insert_text()
actually embeds) — real case: an address containing "Pařížská" and
"Město" rendered those letters as a stray middle-dot placeholder in the
generated PDF. DejaVu Sans has full coverage for these and is bundled
directly in the repo (not relying on whatever fonts the host happens to
have installed) — see app/fonts/DejaVuSans-LICENSE.txt.
"""
from datetime import date
from pathlib import Path
from typing import Optional
import logging
import uuid

import fitz

from app.config import settings
from app.blank_service import _s, _fmt_date, _safe_filename_part

logger = logging.getLogger(__name__)

POPLATNIK_SOURCE = Path(__file__).resolve().parent / "templates" / "bundle" / "poplatnik.pdf"
OVERLAY_FONT_PATH = Path(__file__).resolve().parent / "fonts" / "DejaVuSans.ttf"
OVERLAY_FONT_NAME = "dejavu"

_FONT_SIZE = 9
_X_GAP = 8  # points of horizontal padding after a label before the value starts
_Y_NUDGE = 1  # small upward nudge so the value's baseline sits on the label's own line

# (context key, exact label text as printed on the form, which
# occurrence to use when a label appears more than once — e.g.
# "Příjmení"/"Jméno(-a)" also appear as column headers in the dependent-
# children table further down the page, so occurrence 0 is always the
# "Identifikace poplatníka" section near the top). All on page 1.
_FIELDS = [
    ("FIRMA", "Název plátce daně", 0),
    ("ADRESA_FIRMY", "Adresa", 0),
    ("PRIJMENI", "Příjmení", 0),
    ("JMENO", "Jméno(-a)", 0),
    ("ADRESA", "Adresa bydliště (místo trvalého pobytu)", 0),
    ("DATUM_NAROZENI", "Datum narození", 0),
    ("CISLO_DOKLADU", "Číslo a typ dokladu prokazující totožnost poplatníka", 0),
    ("STATNI_PRISLUSNOST", "Stát, který tento doklad vydal", 0),
    # The form's own title line ("...pro zdaňovací období (pro část
    # zdaňovacího období)1)") has an empty box printed right after it for
    # the year — same label-search-then-place-after approach as every
    # other field here, just against a heading instead of a form-line label.
    ("ROK_ZDANOVACI", "pro zdaňovací období (pro část zdaňovacího období)", 0),
    ("DANOVY_REZIDENT", "Stát, jehož jste daňovým rezidentem", 0),
]

# (context key, row label, column label) — targets a specific table CELL
# on page 2 (the "Podpisová část" signature table), found as the
# intersection of a row label's y-position and a column header's
# x-position, rather than "search for label, place value right after it"
# like _FIELDS above. Needed because this value doesn't sit next to its
# own label at all — it belongs in a blank grid cell below the "Ověření
# plátcem daně9) (písemně, elektronicky) a datum" column header, on the
# "Na uvedené zdaňovací období" row specifically (not the "Dodatečně za
# uvedené zdaňovací období" row below it, which is for backdated
# declarations — out of scope here, nothing in `fields` maps to it).
_CELL_FIELDS_PAGE2 = [
    ("OVERENI_DATUM", "Na uvedené zdaňovací období", "Ověření plátcem daně"),
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


def _find_adjacent_box(page, label_rect):
    """Some header fields' blank isn't an underscored text line at all —
    it's a small drawn (rounded) rectangle immediately to the right of
    the label, e.g. the year box next to "pro zdaňovací období (pro
    část zdaňovacího období)1)". Placing text there the same way as
    every other field (baseline = label's own y1) puts it near the
    *bottom* of that label's text row instead of centered in the much
    shorter box, since this particular label is set in a much bigger
    heading font than the 9pt overlay value — visually the value ends
    up sitting half outside/below the box. Searches the page's vector
    drawings for a small (form-field-sized, not the page background)
    rect on the same line and to the right of the label; returns None
    if there isn't one, so the caller falls back to the normal
    after-the-label placement used everywhere else."""
    best = None
    for d in page.get_drawings():
        rect = d.get("rect")
        if not rect or rect.width > 250 or rect.height > 40:
            continue  # not a small form-field box (e.g. the page's own background fill)
        if rect.x0 < label_rect.x1 - 1:
            continue  # not to the right of the label
        if rect.y1 < label_rect.y0 - 3 or rect.y0 > label_rect.y1 + 3:
            continue  # not on the same line
        if best is None or rect.x0 < best.x0:
            best = rect
    return best


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
        # Current year at generation time — this form is filled out fresh
        # for each new hire, always for the tax period that's currently
        # running, never a past one.
        "ROK_ZDANOVACI": str(date.today().year),
        # Fixed, not sourced from `fields` at all: every person this form
        # gets generated for is working in Czechia, so their tax
        # residency here is always Česká republika regardless of
        # nationality/citizenship (that's the *other* field, "Stát,
        # který tento doklad vydal").
        "DANOVY_REZIDENT": "Česká republika",
        # The payer-side ("plátce daně") verification date — this
        # declaration is being generated and handed over at onboarding,
        # so the relevant date is the employee's own start date, already
        # collected for the contract itself.
        "OVERENI_DATUM": _fmt_date(fields.get("start_date")),
    }


def fill_poplatnik_pdf(fields: dict) -> Optional[Path]:
    """Returns the path to a filled copy of the tax declaration PDF, or
    None if the source form is missing (best-effort, same as
    convert_to_pdf() — a bundle-doc problem must never fail the whole
    /api/fill request). Both failure paths are logged rather than
    silently swallowed — see _fill_bundle_docx's docstring for why."""
    if not POPLATNIK_SOURCE.exists():
        logger.warning("poplatnik source PDF not found on disk: %s", POPLATNIK_SOURCE)
        return None
    try:
        context = _build_overlay_context(fields)
        doc = fitz.open(str(POPLATNIK_SOURCE))
        page1 = doc[0]
        page1.insert_font(fontname=OVERLAY_FONT_NAME, fontfile=str(OVERLAY_FONT_PATH))
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
            rects = _rightmost_edge_per_line(page1.search_for(label))
            if occurrence >= len(rects):
                continue  # label not found (or not enough occurrences) — skip rather than guess
            r = rects[occurrence]
            box = _find_adjacent_box(page1, r)
            if box is not None:
                # Center vertically in the box rather than align to the
                # label's own (much taller heading-font) text row — see
                # _find_adjacent_box's docstring.
                pos = (box.x0 + _X_GAP, box.y0 + box.height * 0.68)
            else:
                pos = (r.x1 + _X_GAP, r.y1 - _Y_NUDGE)
            page1.insert_text(pos, value, fontsize=_FONT_SIZE, fontname=OVERLAY_FONT_NAME)

        page2 = doc[1] if doc.page_count > 1 else None
        if page2 is not None:
            page2.insert_font(fontname=OVERLAY_FONT_NAME, fontfile=str(OVERLAY_FONT_PATH))
            for key, row_label, col_label in _CELL_FIELDS_PAGE2:
                value = context.get(key, "")
                if not value:
                    continue
                row_rects = page2.search_for(row_label)
                col_rects = _rightmost_edge_per_line(page2.search_for(col_label))
                if not row_rects or not col_rects:
                    continue  # row or column label not found — skip rather than guess
                row_r = row_rects[0]
                col_r = col_rects[0]  # topmost occurrence — the signature table's, not the change-log table's
                page2.insert_text(
                    (col_r.x0 + _X_GAP, row_r.y1 - _Y_NUDGE), value, fontsize=_FONT_SIZE, fontname=OVERLAY_FONT_NAME
                )

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
        logger.exception("failed to fill poplatnik PDF")
        return None
