"""Regression tests for pdf_fill.py's tax-declaration overlay.

fitz.Page.insert_text()/merge_page() were both tried against hand-read
coordinates first, and both silently mis-positioned every field on this
exact PDF (confirmed via rendered before/after screenshots — text meant
for the top of the page landed hundreds of points lower). Searching for
the real label text at runtime (search_for()) turned out to be the
actual bug: not the rendering, but the hand-measured coordinates
themselves. These tests lock in the search_for()-based approach and the
None-safety it needs to share with blank_service.py.
"""
import fitz
import pytest

from app.pdf_fill import fill_poplatnik_pdf, POPLATNIK_SOURCE


@pytest.mark.skipif(not POPLATNIK_SOURCE.exists(), reason="source form not present")
def test_fill_poplatnik_pdf_places_values_next_to_their_labels(tmp_path, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)

    fields = {
        "first_name": "Jan", "last_name": "Novak", "address": "Vinohradska 45, Praha",
        "birth_date": "01.01.1990", "doc_number": "AB123456", "nationality": "Ukrajina",
        "company_name": "ACME s.r.o.", "company_address": "Prazska 1, Praha",
    }
    out_path = fill_poplatnik_pdf(fields)
    assert out_path is not None
    assert out_path.exists()

    doc = fitz.open(str(out_path))
    page = doc[0]

    # Every inserted value must land level with (same line as) its label
    # -- "same line" meaning the value's own bounding box vertically
    # overlaps the label's, not just "appears somewhere on the page".
    checks = [
        ("Název plátce daně", "ACME s.r.o."),
        ("Příjmení", "Novak"),
        ("Jméno(-a)", "Jan"),
        ("Adresa bydliště", "Vinohradska 45, Praha"),
        ("Datum narození", "01.01.1990"),
        ("Číslo a typ dokladu prokazující totožnost poplatníka", "AB123456"),
        ("Stát, který tento doklad vydal", "Ukrajina"),
    ]
    for label, value in checks:
        label_rects = sorted(page.search_for(label), key=lambda r: (r.y0, r.x0))
        value_rects = page.search_for(value)
        assert label_rects, f"label {label!r} not found in rendered PDF"
        assert value_rects, f"value {value!r} not found in rendered PDF"
        label_y_mid = (label_rects[0].y0 + label_rects[0].y1) / 2
        assert any(
            v.y0 <= label_y_mid <= v.y1 for v in value_rects
        ), f"{value!r} is not on the same line as label {label!r}"

    doc.close()


@pytest.mark.skipif(not POPLATNIK_SOURCE.exists(), reason="source form not present")
def test_fill_poplatnik_pdf_never_renders_the_literal_word_none(tmp_path, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)

    # Same None-vs-missing-key concern as blank_service.py's context
    # builder (FillRequest sends every unset field as an explicit None,
    # not an omitted key) -- _build_overlay_context must be equally safe.
    fields = {
        "first_name": None, "last_name": None, "address": None,
        "birth_date": None, "doc_number": None, "nationality": None,
        "company_name": None, "company_address": None,
    }
    out_path = fill_poplatnik_pdf(fields)
    assert out_path is not None

    doc = fitz.open(str(out_path))
    text = doc[0].get_text()
    doc.close()
    assert "None" not in text


@pytest.mark.skipif(not POPLATNIK_SOURCE.exists(), reason="source form not present")
def test_fill_poplatnik_pdf_leaves_page_two_untouched(tmp_path, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)

    fields = {"first_name": "Jan", "last_name": "Novak"}
    out_path = fill_poplatnik_pdf(fields)
    doc = fitz.open(str(out_path))
    assert len(doc) == 2

    original = fitz.open(str(POPLATNIK_SOURCE))
    assert doc[1].get_text() == original[1].get_text()
    doc.close()
    original.close()


def test_fill_poplatnik_pdf_returns_none_when_source_missing(tmp_path, monkeypatch):
    import app.pdf_fill as pdf_fill
    monkeypatch.setattr(pdf_fill, "POPLATNIK_SOURCE", tmp_path / "does_not_exist.pdf")
    assert fill_poplatnik_pdf({"first_name": "Jan"}) is None
