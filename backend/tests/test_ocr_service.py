"""
Regression tests for the pure, deterministic extraction logic in
ocr_service.py — dates, MRZ checksums, name parsing, document-type/country
detection. These are the pieces most likely to silently break (regexes
tuned against real documents) and previously had zero coverage, which is
exactly how the missing `import asyncio` (see test_recognize_document.py)
went unnoticed.
"""
from datetime import date

import pytest

from app.ocr_service import (
    _detect_doc_type,
    _detect_country,
    _detect_language,
    _is_plausible_year,
    _find_dates,
    _icao_check_digit,
    _verify_and_correct,
    _extract_passport_number_from_mrz,
    _interpret_two_digit_year,
    _parse_name_from_text,
    _parse_mrz,
    _extract_fields_from_text,
    _find_visa_info,
)


def test_detect_doc_type_recognizes_passport():
    assert _detect_doc_type("CESTOVNÍ PAS") == "Cestovní pas"


def test_detect_doc_type_falls_back_to_unknown():
    assert _detect_doc_type("random unrelated text") == "Neznámý dokument"


def test_detect_country_from_cyrillic():
    assert _detect_country("УКРАЇНА") == "Ukrajina"


def test_detect_language_ukrainian_cyrillic():
    assert _detect_language("паспорт україна") == "ukrajinština"


def test_detect_language_czech_diacritics():
    assert _detect_language("řízký text ěščř") == "čeština"


def test_detect_language_defaults_to_english():
    assert _detect_language("hello world") == "angličtina"


@pytest.mark.parametrize("year,expected", [
    (1994, True),
    (1831, False),  # the exact "merged digits" scenario the comment describes
    (2150, False),
])
def test_is_plausible_year(year, expected):
    assert _is_plausible_year(year) is expected


def test_find_dates_rejects_implausible_year():
    # "01.01.1831" looks like a date but isn't a plausible document year —
    # only the real date should come back.
    found = _find_dates("narozen 12.03.1994 platnost 01.01.1831")
    assert found == ["12.03.1994"]


def test_icao_check_digit_matches_official_example():
    # ICAO Doc 9303 part 4 worked example: document number "L898902C3"
    # has check digit 6.
    assert _icao_check_digit("L898902C3") == 6


def test_verify_and_correct_accepts_matching_checksum():
    value, verified = _verify_and_correct("L898902C3", "6")
    assert value == "L898902C3"
    assert verified is True


def test_verify_and_correct_fixes_single_ocr_confusion():
    # "8" misread as "B" at position 1 — the checksum no longer matches
    # the raw OCR text, but the single-character fix should recover it.
    value, verified = _verify_and_correct("LB98902C3", "6")
    assert value == "L898902C3"
    assert verified is True


def test_verify_and_correct_gives_up_on_unfixable_mismatch():
    value, verified = _verify_and_correct("XXXXXXXXX", "6")
    assert value == "XXXXXXXXX"
    assert verified is False


def test_extract_passport_number_from_mrz_self_verifies():
    mrz_text = (
        "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\n"
        "L898902C36UTO7408122F1204159ZE184226B<<<<<10"
    )
    doc_number, verified = _extract_passport_number_from_mrz(mrz_text)
    assert doc_number == "L898902C3"
    assert verified is True


def test_extract_passport_number_from_mrz_none_without_mrz():
    assert _extract_passport_number_from_mrz("no mrz line here") == (None, False)


def test_parse_mrz_still_captures_line_with_no_surviving_double_angle_bracket():
    # Real-world case: OCR misread every '<' on the name line (both the
    # "<<" separator and the trailing filler) into unrelated glyphs, so no
    # "<<" survives anywhere on the line even though it's still clearly
    # MRZ-shaped. mrz_raw must still surface this line — callers (the
    # frontend's MRZ-purity ranking) rely on seeing the true, contaminated
    # read to deprioritize it; if _parse_mrz drops the line because it
    # never finds a literal "<<", the contamination becomes invisible and
    # a worse OCR read can win purely because a "cleaner" doc_type/
    # checksum signal masks it.
    corrupted_name_line = "PELEKHく〜DBYTRO" + "".join("<へ" for _ in range(15))
    corrupted_name_line = corrupted_name_line[:44]
    data_line = "AB1234567<4UKR9001015M300101<<<<<<<<<<<<<<<<"
    raw_text = f"PASSPORT OF UKRAINE\n{corrupted_name_line}\n{data_line}"

    mrz = _parse_mrz(raw_text)

    assert mrz is not None
    assert "PELEKH" in mrz
    # The point of surfacing it: it must fail a strict MRZ-charset check.
    import re
    assert not re.match(r"^[A-Z0-9<\s]+\Z", mrz)


def test_parse_mrz_ignores_ordinary_short_label_line():
    assert _parse_mrz("C. DOKLADU AB1234567 PLATNOST DO 2030") is None


def test_interpret_two_digit_year_birth_boundary():
    current_yy = date.today().year % 100
    # At or below "now": treated as 21st century.
    assert _interpret_two_digit_year(current_yy, "birth") == 2000 + current_yy
    # One year "in the future": must be 20th century instead.
    assert _interpret_two_digit_year((current_yy + 1) % 100, "birth") == 1900 + ((current_yy + 1) % 100)


def test_interpret_two_digit_year_expiry_window_is_wider():
    current_yy = date.today().year % 100
    # Issue/expiry dates get a +15 year window instead of birth's "now".
    within_window = (current_yy + 15) % 100
    beyond_window = (current_yy + 16) % 100
    assert _interpret_two_digit_year(within_window, "expiry") == 2000 + within_window
    assert _interpret_two_digit_year(beyond_window, "expiry") == 1900 + beyond_window


def test_parse_name_from_mrz_strips_known_country_code():
    text = "P<UKRSHEVCHENKO<<TARAS<<<<<<<<<<<<<<<<<<<<<<"
    assert _parse_name_from_text(text) == ("Taras", "Shevchenko")


def test_parse_name_from_labeled_fields():
    text = "Příjmení: NOVÁK\nJméno: JAN"
    assert _parse_name_from_text(text) == ("Jan", "Novák")


def test_parse_name_returns_none_when_nothing_matches():
    assert _parse_name_from_text("just some unrelated text") == (None, None)


def test_parse_name_from_mrz_strips_country_code_shifted_by_visa_prefix():
    # Visa MRZ lines are "V<CZE..." (doc-type 'V' + filler + country code),
    # unlike a passport's "P<UKR..." where the code is right at position 0.
    # OCR misread the filler '<' into a stray letter, gluing it onto the
    # country code ("VDCZEPELEKH" instead of "V<CZEPELEKH"), which used to
    # defeat the country-code strip (it only checked position 0).
    text = "VDCZEPELEKH<<DMYTRO<<<<<<<<<<<<<<<<<<<<<<<<"
    assert _parse_name_from_text(text) == ("Dmytro", "Pelekh")


def test_parse_name_ignores_header_false_positive_before_real_mrz():
    # Real bug: a Schengen visa's bilingual header ("VÍZUM / VISA") got
    # OCR'd with its '/' misread as '<<' and its diacritic dropped
    # ("VIZUM<<VISA"), which the old unconstrained regex matched first
    # (it appears before the real MRZ block at the bottom of the page) —
    # returning "Visa"/"Vízum" as the person's name instead of ever
    # looking at the genuine MRZ line below it.
    text = (
        "SCHENGEN\n"
        "VIZUM<<VISA\n"
        "1. PELEKH DMYTRO\n"
        "2. UA 12.03.1990\n"
        "Platnost / Valid until: 15.09.2027\n"
        "VDCZEPELEKH<<DMYTRO<<<<<<<<<<<<<<<<<<<<<<<<\n"
        "1234567<8CZE9003125M270915<<<<<<<<<<<<<<<02"
    )
    assert _parse_name_from_text(text) == ("Dmytro", "Pelekh")


def test_parse_name_matches_across_passport_and_visa_for_same_person():
    # The point of both fixes above: a passport and visa MRZ for the same
    # person must resolve to the identical name, so the frontend's
    # cross-document name-mismatch warning doesn't fire a false positive.
    visa_text = (
        "VIZUM<<VISA\n"
        "VDCZEPELEKH<<DMYTRO<<<<<<<<<<<<<<<<<<<<<<<<"
    )
    passport_text = "P<UKRPELEKH<<DMYTRO<<<<<<<<<<<<<<<<<<<<<<<<"
    assert _parse_name_from_text(visa_text) == _parse_name_from_text(passport_text)


def test_extract_fields_from_labeled_czech_id():
    text = (
        "OBČANSKÝ PRŮKAZ\n"
        "Jméno: JAN\n"
        "Příjmení: NOVÁK\n"
        "Datum narození: 12.03.1994\n"
        "Č. dokladu: 999123456\n"
        "Česká republika"
    )
    fields = _extract_fields_from_text(text, quality=88, mode="mock")
    assert fields["doc_type"] == "Občanský průkaz"
    assert fields["issuing_country"] == "Česká republika"
    assert fields["birth_date"] == "12.03.1994"
    assert fields["doc_number"] == "999123456"
    assert fields["is_expired"] is False


def test_extract_fields_warns_on_low_quality():
    fields = _extract_fields_from_text("x", quality=40, mode="mock")
    assert any("Kvalita fotografie" in w for w in fields["warnings"])


def test_extract_fields_flags_expired_document():
    fields = _extract_fields_from_text("Platnost do: 01.01.2000", quality=88, mode="mock")
    assert fields["is_expired"] is True
    assert any("propadlý" in w for w in fields["warnings"])


def test_find_visa_info_extracts_series_and_number():
    visa = _find_visa_info("VIZUM / VISA CZE 1234567")
    assert visa["visa_number"] == "CZE1234567"


def test_find_visa_info_ignores_non_visa_text():
    assert _find_visa_info("obyčejný text bez víza") == {}
