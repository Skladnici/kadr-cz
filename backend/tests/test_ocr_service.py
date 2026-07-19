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
    doc_number, verified, birth_date = _extract_passport_number_from_mrz(mrz_text)
    assert doc_number == "L898902C3"
    assert verified is True
    # ICAO's own standard MRZ example: birth date 12 Aug 1974, positioned
    # right after the nationality code in the same MRZ field this
    # function already reads doc_number from.
    assert birth_date == "12.08.1974"


def test_extract_passport_number_from_mrz_none_without_mrz():
    assert _extract_passport_number_from_mrz("no mrz line here") == (None, False, None)


def test_extract_passport_number_from_mrz_real_armenian_passport_ernest_tadevosyan():
    # Real case that motivated this fallback: a real Armenian passport's
    # printed "DATE OF BIRTH 01 FEB 1974" wasn't reliably caught by the
    # labeled-date search, and (being Armenian, not Cyrillic-script) never
    # matches the Ukrainian/CIS bilingual-date heuristic either — leaving
    # the passport card with no birth_date and breaking batch auto-merge
    # against its (correctly-read) visa. The MRZ line is unaffected by
    # any of that: ICAO 9303 TD3 field positions are the same regardless
    # of issuing country or printed-text script.
    mrz_line2 = "AX05955872ARM7402016M3501151<<<<04"
    _, _, birth_date = _extract_passport_number_from_mrz(mrz_line2)
    assert birth_date == "01.02.1974"


def test_extract_passport_number_from_mrz_real_armenian_passport_david_hambaryan():
    # Second real case, deliberately with no trailing personal-number
    # section (just the fixed doc/nationality/birth/sex/expiry block) —
    # confirms the regex doesn't depend on that optional tail being
    # present.
    mrz_line2 = "AX06570519ARM7702129M3503144"
    _, _, birth_date = _extract_passport_number_from_mrz(mrz_line2)
    assert birth_date == "12.02.1977"


def test_find_visa_info_real_armenian_visa_david_hambaryan():
    # Full (untruncated) real visa MRZ line for the same person as the
    # passport case above. An earlier, truncated excerpt of this same
    # scan ("...M2...", cut off mid-expiry-field) looked like it might
    # not satisfy the fixed-width expiry field the regex requires — the
    # real, complete text does, and correctly agrees with the passport's
    # own birth_date (12.02.1977).
    visa_text = "SCHENGEN\nVIZUM / VISA\n9018601197ARM7702129M2610162T1<<0420"
    info = _find_visa_info(visa_text)
    assert info["birth_date"] == "12.02.1977"


def test_extract_fields_passport_and_visa_agree_on_birth_date_david_hambaryan():
    # End-to-end confirmation that both cards in this real batch pair
    # satisfy canAutoMerge's requirement of an exact, non-empty
    # birth_date match on both sides.
    passport_text = (
        "REPUBLIC OF ARMENIA\n"
        "PASSPORT\n"
        "SURNAME HAMBARYAN\n"
        "GIVEN NAMES DAVID\n"
        "P<ARMHAMBARYAN<<DAVID<<<<<<<<<<<<<<<<<<<<<<<\n"
        "AX06570519ARM7702129M3503144"
    )
    visa_text = "SCHENGEN\nVIZUM / VISA\n9018601197ARM7702129M2610162T1<<0420"
    passport_fields = _extract_fields_from_text(passport_text, quality=88, mode="mock")
    visa_fields = _extract_fields_from_text(visa_text, quality=88, mode="mock")
    assert passport_fields["birth_date"] == "12.02.1977"
    assert visa_fields["birth_date"] == "12.02.1977"


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


def test_parse_mrz_recognizes_fullwidth_unicode_lookalike_of_angle_bracket():
    # Real-world case from an actual EU visa OCR read: the MRZ line's '<'
    # separators came back as U+FF1C "＜" FULLWIDTH LESS-THAN SIGN — visually
    # near-identical to ASCII '<' but a different codepoint — with the
    # trailing filler run misread as Japanese katakana "く" instead of any
    # kind of angle bracket at all. With zero literal ASCII '<' anywhere on
    # the line, the old exact-match check found it "doesn't look like MRZ"
    # and the parser fell back to the visa's bilingual header instead (see
    # test_parse_name_ignores_header_false_positive_before_real_mrz for that
    # exact failure mode reappearing with a different corruption source).
    mrz_line = "VDCZEPELEKH＜＜DMYTRO" + "く" * 7  # ＜＜ ... くくくくくくく
    data_line = "1234567＜8CZE9003125M270915＜＜＜＜＜＜＜＜＜＜02"
    raw_text = f"VIZUM<<VISA\n{mrz_line}\n{data_line}"

    mrz = _parse_mrz(raw_text)

    assert mrz is not None
    assert "PELEKH" in mrz


def test_parse_name_from_visa_with_fullwidth_unicode_mrz_lookalike():
    # Same real-world OCR read as above, end-to-end through name parsing —
    # must resolve to the actual holder, not the "Visa"/"Vízum" header
    # false positive the bug report described.
    text = (
        "SCHENGEN\n"
        "VIZUM<<VISA\n"
        "1. PELEKH DMYTRO\n"
        "Platnost / Valid until: 15.09.2027\n"
        "VDCZEPELEKH＜＜DMYTRO" + "く" * 7 + "\n"
        "1234567＜8CZE9003125M270915＜＜＜＜＜＜＜＜＜＜02"
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


def test_parse_name_strips_country_code_not_in_hardcoded_list():
    # Real bug: the previous implementation stripped the MRZ country code
    # by searching for one of nine hardcoded codes (UKR/CZE/POL/SVK/DEU/
    # AUT/HUN/ROU/MDA). A visa issued by any other Schengen country (here
    # Italy) left the code glued onto the surname ("Itapelekh" instead of
    # "Pelekh") — and because that garbled-but-still-MRZ-valid-charset name
    # could still outrank a correctly-read passport in the frontend's merge
    # logic (see SimpleDocFiller.jsx's pickReliableResult), uploading a
    # visa alongside a passport could make name recognition *worse* than
    # uploading the passport alone. Fixed by stripping the country code by
    # its fixed ICAO 9303 line position instead of a whitelist.
    visa_clean_filler = "V<ITAPELEKH<<DMYTRO<<<<<<<<<<<<<<<<<<<<<<<<"
    assert _parse_name_from_text(visa_clean_filler) == ("Dmytro", "Pelekh")

    visa_corrupted_filler = "VXITAPELEKH<<DMYTRO<<<<<<<<<<<<<<<<<<<<<<<<"
    assert _parse_name_from_text(visa_corrupted_filler) == ("Dmytro", "Pelekh")

    passport_unlisted_country = "P<GRCPAPADOPOULOS<<NIKOS<<<<<<<<<<<<<<<<<<<<"
    assert _parse_name_from_text(passport_unlisted_country) == ("Nikos", "Papadopoulos")


def test_parse_name_from_realistic_visa_text_with_unlisted_country():
    # End-to-end, against a full visa-sticker-shaped text block (bilingual
    # header, visa number/country, validity dates, entries/duration
    # fields, MRZ) — must resolve to the same name as the holder's
    # passport rather than being contaminated by any of that surrounding
    # visa-specific structure.
    visa_text = (
        "SCHENGEN\n"
        "VIZUM / VISA\n"
        "GRC 7654321\n"
        "1. PELEKH DMYTRO\n"
        "2. UA 12.03.1990\n"
        "TYP/TYPE D\n"
        "PLATNE OD/VALID FROM 01.09.2024 DO/UNTIL 15.09.2027\n"
        "POCET VSTUPU/NUMBER OF ENTRIES MULTIPLE\n"
        "DELKA POBYTU/DURATION OF STAY 90 DNI/DAYS\n"
        "VYDANO V/ISSUED IN ATHENS\n"
        "V<GRCPELEKH<<DMYTRO<<<<<<<<<<<<<<<<<<<<<<<<\n"
        "1234567<8UKR9003125M270915<<<<<<<<<<<<<<02"
    )
    passport_text = "P<UKRPELEKH<<DMYTRO<<<<<<<<<<<<<<<<<<<<<<<<"
    assert _parse_name_from_text(visa_text) == ("Dmytro", "Pelekh")
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


def test_extract_fields_uses_generic_mrz_birth_date_fallback_for_passport():
    # Real case: an Armenian passport (Ernest Tadevosyan) whose printed
    # "DATE OF BIRTH 01 FEB 1974" wasn't caught by the labeled-date search
    # on this scan -- and, being Armenian rather than Cyrillic-script,
    # never matches the Ukrainian/CIS bilingual-date heuristic either --
    # left the passport card with no birth_date, so batch auto-merge
    # against its (correctly-read) visa never triggered. The MRZ line
    # underneath is unaffected: ICAO 9303 TD3 field positions are fixed
    # by the standard, the same for every issuing country.
    text = (
        "REPUBLIC OF ARMENIA\n"
        "PASSPORT\n"
        "SURNAME TADEVOSYAN\n"
        "GIVEN NAMES ERNEST\n"
        "P<ARMTADEVOSYAN<<ERNEST<<<<<<<<<<<<<<<<<<<<<\n"
        "AX05955872ARM7402016M3501151<<<<04"
    )
    fields = _extract_fields_from_text(text, quality=88, mode="mock")
    assert fields["birth_date"] == "01.02.1974"


def test_extract_fields_prefers_labeled_birth_date_over_mrz():
    # No regression check: when a labeled date IS found, it must still
    # win over the MRZ fallback, exactly as it already wins over the
    # Ukrainian/CIS bilingual-date guess above it.
    text = (
        "PASSPORT\n"
        "Date of birth: 01.01.2000\n"
        "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\n"
        "L898902C36UTO7408122F1204159ZE184226B<<<<<10"
    )
    fields = _extract_fields_from_text(text, quality=88, mode="mock")
    assert fields["birth_date"] == "01.01.2000"


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


def test_find_visa_info_does_not_glue_vizum_header_word_onto_visa_number():
    # Real case (David Hambaryan): mrz_series used to search the whole
    # text for "^V[A-Z<][A-Z]{3}" without confirming the match was on an
    # actual MRZ-shaped line -- so it matched the plain header word
    # "VIZUM" itself ("V" + "I" + "ZUM"), producing a bogus visa_number
    # like "ZUM9018601197" that has nothing to do with the real issuing
    # country. No real MRZ series line is present here at all, so the
    # printed number should come through completely clean.
    text = "SCHENGEN\nVIZUM / VISA\n9018601197ARM7702129M2610162T1<<0420"
    visa = _find_visa_info(text)
    assert visa["visa_number"] == "9018601197"


def test_find_visa_info_still_uses_real_mrz_series_line_as_fallback():
    # No-regression check for the fallback this fix touched: when the
    # printed number ISN'T directly adjacent to "VIZUM / VISA <CODE>"
    # (forcing the mrz_series/m_num fallback path), a genuine MRZ-shaped
    # series line elsewhere in the text must still supply the country
    # prefix, exactly as before.
    text = (
        "SCHENGEN\n"
        "VIZUM / VISA\n"
        "1234567\n"
        "1. PELEKH DMYTRO\n"
        "VDCZEPELEKH<<DMYTRO<<<<<<<<<<<<<<<<<<<<<<<<\n"
        "1234567<8UKR9003125M270915<<<<<<<<<<<<<<02"
    )
    visa = _find_visa_info(text)
    assert visa["visa_number"] == "CZE1234567"
