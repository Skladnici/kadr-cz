"""
Document recognition pipeline.

Two modes, selected automatically by whether GOOGLE_VISION_API_KEY is set:

  - "live": calls the Google Cloud Vision API (free tier ~1000 units/month)
    to OCR the image, then runs it through field-extraction rules tuned
    for Czech, Ukrainian, and generic ICAO/EU documents.

  - "mock": returns realistic, deterministic sample data so the whole
    product can be developed, demoed and tested for free, with zero
    external dependency. The extraction/validation code path is IDENTICAL
    in both modes — only where the raw text comes from differs. This
    means switching to "live" later requires no changes anywhere else in
    the app: just set the API key.

To go live: put GOOGLE_VISION_API_KEY=... in backend/.env
(Get a free-tier key at https://console.cloud.google.com/apis/library/vision.googleapis.com)
"""
import asyncio
import base64
import logging
import re
import mimetypes
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate"

# _tesseract_ocr() has no timeout of its own — a malformed or adversarial
# image could hang the thread it runs in indefinitely on a
# memory/CPU-constrained free instance. asyncio.wait_for can't actually
# kill the underlying OS thread (Python threads aren't forcibly
# cancellable), but it does bound how long a request waits for it,
# freeing the request to fall back to mock data instead of hanging.
TESSERACT_TIMEOUT_SECONDS = 30

# ---------------------------------------------------------------- doc type
DOC_TYPE_KEYWORDS = {
    "Občanský průkaz": ["občanský průkaz", "obcansky prukaz", "identity card czech"],
    "Cestovní pas": ["cestovní pas", "cestovni pas", "passport", "паспорт"],
    "Zaměstnanecká karta": ["zaměstnanecká karta", "zamestnanecka karta", "employee card"],
    "Modrá karta": ["modrá karta", "modra karta", "blue card"],
    "Povolení k pobytu": ["povolení k pobytu", "poboyt", "residence permit"],
    "Přechodný pobyt": ["přechodný pobyt", "prechodny pobyt", "temporary residence"],
    "Trvalý pobyt": ["trvalý pobyt", "trvaly pobyt", "permanent residence"],
    "Vízum": ["vízum", "vizum", "visa", "виза"],
    "Kartička zdravotní pojišťovny": ["zdravotní pojišťovna", "zdravotni pojistovna", "health insurance card"],
    "Řidičský průkaz": ["řidičský průkaz", "ridicsky prukaz", "driving licence", "driver licence"],
    "Biometrický pas": ["biometrichnyi pasport", "біометричний паспорт", "biometric passport"],
    "ID karta": ["id card", "identity card", "id-карта"],
}

COUNTRY_HINTS = {
    "Ukrajina": ["ukraine", "україна", "ukrajina", "ukr"],
    "Česká republika": ["czech republic", "česká republika", "ceska republika", "cze"],
    "Slovensko": ["slovakia", "slovensko", "svk"],
    "Polsko": ["poland", "polska", "pol"],
}

# ISO 3166-1 alpha-3 codes, as printed in a passport's own MRZ nationality
# field — the same fixed ICAO 9303 position _extract_passport_number_
# from_mrz already reads doc_number/birth_date/expiry_date from, and for
# the same reason preferred over COUNTRY_HINTS' free-text keyword search
# above: it's a structured field, not a guess from whatever OCR text
# happens to be recognizable. Covers the countries this HR business's
# foreign workforce most commonly comes from; an unmapped code falls back
# to COUNTRY_HINTS (see _extract_fields_from_text) rather than showing a
# raw, possibly-confusing 3-letter code on an official tax form.
MRZ_NATIONALITY_TO_CZECH = {
    "UKR": "Ukrajina",
    "ARM": "Arménie",
    "CZE": "Česká republika",
    "SVK": "Slovensko",
    "POL": "Polsko",
    "RUS": "Rusko",
    "BLR": "Bělorusko",
    "MDA": "Moldavsko",
    "GEO": "Gruzie",
    "AZE": "Ázerbájdžán",
    "KAZ": "Kazachstán",
    "UZB": "Uzbekistán",
    "KGZ": "Kyrgyzstán",
    "TJK": "Tádžikistán",
    "TKM": "Turkmenistán",
    "MNG": "Mongolsko",
    "VNM": "Vietnam",
    "IND": "Indie",
    "SRB": "Srbsko",
    "ROU": "Rumunsko",
    "BGR": "Bulharsko",
    "HUN": "Maďarsko",
    "DEU": "Německo",
    "AUT": "Rakousko",
    "USA": "Spojené státy americké",
    "GBR": "Spojené království",
}


def _detect_doc_type(text: str) -> str:
    low = text.lower()
    for doc_type, keywords in DOC_TYPE_KEYWORDS.items():
        if any(k in low for k in keywords):
            return doc_type
    return "Neznámý dokument"


def _detect_country(text: str) -> Optional[str]:
    low = text.lower()
    for country, keywords in COUNTRY_HINTS.items():
        if any(k in low for k in keywords):
            return country
    return None


def _detect_language(text: str) -> str:
    if re.search(r"[а-яіїєґ]", text.lower()):
        return "ukrajinština"
    if re.search(r"[ěščřžýáíéůňťď]", text.lower()):
        return "čeština"
    return "angličtina"


DATE_PATTERNS = [
    r"(\d{2})[.\-/](\d{2})[.\-/](\d{4})",   # 12.03.1994 or 12-03-1994
    r"(\d{4})[.\-/](\d{2})[.\-/](\d{2})",   # 1994-03-12
]


def _is_plausible_year(y: int) -> bool:
    """Rejects nonsense 'years' produced when OCR runs two unrelated
    numbers together (e.g. '1831' from '18' + '31-03-27' merging) —
    real documents only ever have years in this realistic window."""
    return 1920 <= y <= 2100


def _find_dates(text: str) -> list[str]:
    found = []
    for pattern in DATE_PATTERNS:
        for m in re.finditer(pattern, text):
            groups = m.groups()
            year = int(groups[2]) if len(groups[2]) == 4 else int(groups[0])
            if _is_plausible_year(year):
                found.append(m.group(0))
    return found


# ICAO 9303 MRZ lines are fixed-width and contain only A-Z, 0-9 and '<'
# (the filler/separator character) — nothing else is ever legitimately
# printed there.
_MRZ_VALID_CHARS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<")

# OCR has been observed emitting a full-width or angle-bracket-shaped
# Unicode look-alike of the ASCII '<' filler/separator instead of the real
# character — e.g. U+FF1C "＜" FULLWIDTH LESS-THAN SIGN, seen verbatim on a
# real EU visa MRZ line ("VDCZEPELEKH＜＜DMYTRO..."). Visually near-identical
# to '<', but a different codepoint, so an exact match against
# _MRZ_VALID_CHARS misses it entirely — with zero literal ASCII '<' left on
# the line, it fails the MRZ-shape check below and the parser falls back to
# matching the document's bilingual header instead (see
# test_parse_name_ignores_header_false_positive_before_real_mrz for that
# exact failure mode). Used only to *decide* whether a line looks like
# MRZ — the line text callers actually see (mrz_raw) stays the true,
# uncorrected OCR read; see _parse_mrz's docstring for why that matters.
_MRZ_LOOKALIKE_CHARS = "＜＞‹›〈〉"


def _normalize_mrz_lookalikes(candidate: str) -> str:
    for ch in _MRZ_LOOKALIKE_CHARS:
        candidate = candidate.replace(ch, "<")
    return candidate


def _looks_like_mrz_line(candidate: str, min_valid_ratio: float) -> bool:
    """Right length plus mostly-MRZ-charset composition, rather than
    requiring a literal '<<' — OCR has been observed corrupting *every*
    '<' on a line (separators and filler alike) into unrelated glyphs,
    which would erase all adjacent '<<' pairs while the line is still
    unmistakably MRZ-shaped otherwise. Requiring '<<' literally (as a
    prior version of this check did) means exactly the most-corrupted —
    and therefore most important to flag — lines silently vanish instead
    of being recognized as MRZ at all."""
    if not (20 <= len(candidate) <= 45):
        return False
    candidate = _normalize_mrz_lookalikes(candidate)
    if "<<" in candidate:
        return True
    if candidate.count("<") < 3:
        return False
    valid = sum(1 for c in candidate if c.upper() in _MRZ_VALID_CHARS)
    return valid / len(candidate) >= min_valid_ratio


def _parse_mrz(text: str) -> Optional[str]:
    """Very lightweight MRZ line detector (two lines of ~44 chars).
    Deliberately permissive (low valid_ratio floor) — this feeds
    mrz_raw, which callers (see _normalize_mrz_text below, and the
    frontend's MRZ-purity ranking) rely on to see the true, uncorrected
    OCR read and judge how contaminated it is. Missing a corrupted line
    here would hide contamination instead of surfacing it."""
    lines = [l.strip() for l in text.splitlines() if _looks_like_mrz_line(l.strip(), min_valid_ratio=0.6)]
    if lines:
        return "\n".join(lines[-2:])
    return None


def _estimate_quality_from_file_size(image_bytes: bytes) -> int:
    """NOT a real image-quality measurement — no blur/resolution/lighting
    analysis happens here. This is a coarse proxy (bigger file ~ more
    detail retained by compression) used only because it costs nothing to
    compute and is directionally better than nothing. A small file that's
    sharp and well-lit scores exactly the same as a small file that's a
    blurry mess, and a large-but-blurry photo scores "high" — callers
    (see the quality<60 warning in _extract_fields_from_text) should treat
    this as a weak hint, not a verdict. Swap for Vision's
    imageProperties/faceAnnotation confidence if/when that's wired up."""
    size_kb = len(image_bytes) / 1024
    if size_kb < 50:
        return 55
    if size_kb < 300:
        return 78
    return 92


def _find_labeled_date(text: str, label_patterns: list[str]) -> Optional[str]:
    """Finds a date that appears near a specific label (e.g. 'Datum narození'),
    rather than just grabbing dates in document order — much more reliable
    once real (non-MRZ) documents are involved, since dates can appear in
    any order on the page."""
    for label in label_patterns:
        m = re.search(label + r"[:\s]*\n?\s*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4})", text, re.IGNORECASE)
        if m:
            return m.group(1)
    return None


DOC_NUMBER_LABELS = [
    r"(?:Č\.?\s*dokladu|Číslo dokladu|Doklad\s*č|Document\s*(?:No|Number))",
    r"(?:Č\.?\s*OP|Rodné\s*číslo)",
]


MONTH_ABBR = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def _interpret_two_digit_year(yy: int, role: str) -> int:
    """Converts a 2-digit year to 4 digits, using a different plausible
    window depending on the field's role — birth dates can be up to a
    century old, while issue/expiry dates are always near the present
    (documents are valid for a limited number of years)."""
    current_yy = date.today().year % 100
    if role == "birth":
        # Birth years: assume 21st century unless that would be a future
        # date, in which case it must be 20th century.
        return 2000 + yy if yy <= current_yy else 1900 + yy
    # issue/expiry: passports/permits are valid up to ~10-15 years —
    # anything within that window of "now" is almost certainly 20XX.
    return 2000 + yy if yy <= current_yy + 15 else 1900 + yy


def _find_bilingual_date_tuples(text: str) -> list[tuple[int, int, int]]:
    """Ukrainian/CIS passports show dates as 'DD <Cyrillic-month>/<Latin
    month abbr> YY' (e.g. '05 KBI/APR 81'). Returns (day, month, 2-digit
    year) tuples in the order they appear on the document — which is
    reliably birth date, then issue date, then expiry date, so callers
    can assign roles by position rather than by guessing from the value."""
    results = []
    for m in re.finditer(r"(\d{1,2})\s+[^\s/]+/([A-Za-z]{3})\s+(\d{2})", text):
        day, mon_abbr, yy = m.groups()
        month = MONTH_ABBR.get(mon_abbr.lower())
        if month:
            results.append((int(day), month, int(yy)))
    return results


PASSPORT_NUMBER_PATTERN = r"\b([A-Z]{1,2}\d{6,8})\b"


def _find_visa_info(text: str) -> dict:
    """Extracts visa number, birth date, expiry date, and (when present)
    the printed visa type/category code from a Czech/Schengen visa
    sticker. Two independent sources for number/dates, used together for
    reliability:
      1. The plain visa number printed near 'VIZUM/VISA' (6-10 digits).
      2. The visa's own MRZ-style line at the bottom, which also encodes
         the holder's birth date and the visa's expiry date — reading
         these from here is far more reliable than guessing from printed
         (and often OCR-mangled) calendar dates on the sticker, or than
         the name fields on the very same line, since ICAO 9303 MRZ
         numeric fields have a checked, fixed-position format that gives
         OCR much less room to go wrong than free-form letters do.
    """
    result = {}

    # Real case (Roman Shyshka): the OCR text for this visa arrived with
    # no whitespace at all between printed fields/lines (e.g.
    # "...EUVIZUM/VISA902699651CESKO..." — "VIZUM" glued directly to the
    # text before and after it). A strict \bVIZUM\b/\bVISA\b requires a
    # word-boundary on both sides, and digits/letters are both "word"
    # characters to regex, so glued text like that never had one to
    # begin with — the old anchored check returned nothing at all for a
    # real, valid visa. A plain substring search has no such requirement
    # and isn't any less safe here: nothing else in ID-document OCR text
    # plausibly contains "VIZUM" or "VISA" as a substring by accident
    # (Czech "víza" has an accented í, so it doesn't collide).
    if not re.search(r"V[IÍ]ZUM|VISA", text, re.IGNORECASE):
        return result  # doesn't look like a visa document at all

    # The visa's printed category/type code (e.g. "D/SD/91") — seen
    # printed right next to the holder's name, immediately before the
    # printed birth date and the MRZ block. Format: 1-2 letters, "/", 2
    # letters, "/", exactly 2 digits. The trailing digit count must stay
    # exactly 2 (not a range) because, in the one real sample seen so
    # far, this code sits directly against the following DD-MM-YY birth
    # date with no separator at all ("D/SD/9114-11-96") — a greedy \d{1,3}
    # eats one digit of "14" into the code instead, leaving a mangled
    # "4-11-96" behind. Some particular codes carry a legal meaning of
    # their own (see visaWarnings.js on the frontend for "SD" = the
    # "strpění" residence status) — this only extracts the raw code,
    # deciding what it means is a frontend/UI concern.
    m_type = re.search(r"[A-Z]{1,2}/[A-Z]{2}/\d{2}", text)
    if m_type:
        result["visa_type_code"] = m_type.group(0)

    # Most reliable source for the series: the visa's own MRZ line always
    # starts with "V" + a subtype char + the 3-letter issuing country
    # code (e.g. "VDCZEMOKHNIA<<VASYL..." → CZE) — far more robust than
    # scanning printed text, which OCR often garbles differently ("CZE"
    # misread as "CLE" etc).
    # Real case: matching this pattern against the raw text as a whole
    # (rather than a line already confirmed to be MRZ-shaped) let it match
    # the plain header word "VIZUM" itself — "V" + "I" (satisfies
    # [A-Z<]) + "ZUM" (satisfies the 3-letter group) — producing a bogus
    # "ZUM"-prefixed visa_number (e.g. "ZUM9018601197") that has nothing
    # to do with the country code. Restricting the search to lines that
    # already pass _looks_like_mrz_line (the same MRZ-shape check used
    # everywhere else in this file) excludes short header words like
    # that, since a genuine MRZ line is 20-45 chars of mostly MRZ-charset
    # content, never a bare 5-letter word.
    mrz_series = None
    for line in text.splitlines():
        candidate = line.strip()
        if not _looks_like_mrz_line(candidate, min_valid_ratio=0.6):
            continue
        m_line = re.match(r"V[A-Z<]([A-Z]{3})", candidate)
        if m_line:
            mrz_series = m_line
            break

    m = re.search(r"V[IÍ]ZUM\s*/\s*VISA\s+([A-Z]{3})\s+(\d{6,10})", text, re.IGNORECASE | re.DOTALL)
    if m:
        result["visa_number"] = f"{m.group(1).upper()}{m.group(2)}"
    else:
        # Series line not found right next to VIZUM/VISA — still capture
        # the bare number anywhere reasonably nearby, and prefix it with
        # the MRZ-derived series if we found one, else fall back to
        # scanning printed text for a standalone series code.
        m_num = re.search(r"V[IÍ]ZUM\s*/\s*VISA[\s\S]{0,40}?(\d{6,10})", text, re.IGNORECASE)
        m_series = mrz_series or re.search(r"\b(CZE|POL|SVK|DEU|AUT|HUN)\b", text)
        if m_num:
            prefix = m_series.group(1) if m_series else ""
            result["visa_number"] = f"{prefix}{m_num.group(1)}"

    # Group 4 here is new: whatever alphanumeric data follows the expiry
    # check digit (ICAO 9303's "optional data" field). On real Czech/
    # Schengen visa stickers this often carries the passport number the
    # visa was issued against — a useful cross-check for auto-merge (see
    # BatchDocFiller.jsx's findPossibleMatch) even when the name fields
    # elsewhere on the line are too OCR-garbled to match on directly.
    m2 = re.search(r"(\d{8,10})\d?[A-Z]{3}(\d{6})\d[MF](\d{6})\d([A-Z0-9<]{0,20})", text)
    if m2:
        if "visa_number" not in result:
            result["visa_number"] = m2.group(1)

        # Group 2 is the holder's birth date (YYMMDD) — was being matched
        # but never read out. Numeric MRZ fields like this are far more
        # reliable than the visa's own name fields, so this is preferred
        # over anything positional/label-based found elsewhere on a visa.
        birth_raw = m2.group(2)
        try:
            yy, mm, dd = int(birth_raw[0:2]), int(birth_raw[2:4]), int(birth_raw[4:6])
            year = _interpret_two_digit_year(yy, role="birth")
            date(year, mm, dd)  # validate
            result["birth_date"] = f"{dd:02d}.{mm:02d}.{year}"
        except (ValueError, IndexError):
            pass

        expiry_raw = m2.group(3)  # YYMMDD
        try:
            yy, mm, dd = int(expiry_raw[0:2]), int(expiry_raw[2:4]), int(expiry_raw[4:6])
            year = _interpret_two_digit_year(yy, role="expiry")
            date(year, mm, dd)  # validate
            result["visa_validity"] = f"{dd:02d}.{mm:02d}.{year}"
        except (ValueError, IndexError):
            pass

        # Best-effort: pull a passport-number-shaped token (letters mixed
        # with digits, ICAO passport numbers are never all-digit or
        # all-letter) out of the optional-data tail, for the auto-merge
        # cross-check mentioned above. Absent or unrecognizable is fine —
        # this is a bonus corroboration signal, never a required field.
        tail = (m2.group(4) or "").replace("<", "")
        ref_doc_match = re.search(
            r"\b(?=[A-Z0-9]{5,10}\b)(?=[A-Z0-9]*[0-9])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,10}\b", tail
        )
        if ref_doc_match:
            result["visa_referenced_doc_number"] = ref_doc_match.group(0)

    return result


# --- MRZ checksum verification (ICAO 9303 standard) ---
# Every passport's machine-readable zone includes a check digit for the
# document number — the same mechanism real passport-control scanners
# use to catch misreads. We use it to *verify* our OCR result, and where
# it doesn't check out, try correcting the single most likely OCR
# confusion (0/O, 1/I, 5/S, 8/B, 2/Z, 6/G) until the checksum matches.
_OCR_CONFUSIONS = {
    "0": ["O", "Q", "D"], "O": ["0"],
    "1": ["I", "L"], "I": ["1"], "L": ["1"],
    "5": ["S"], "S": ["5"],
    "8": ["B"], "B": ["8"],
    "2": ["Z"], "Z": ["2"],
    "6": ["G"], "G": ["6"],
}


def _icao_check_digit(s: str) -> int:
    weights = [7, 3, 1]
    total = 0
    for i, c in enumerate(s):
        if c.isdigit():
            v = int(c)
        elif c == "<":
            v = 0
        elif c.isalpha():
            v = ord(c.upper()) - 55
        else:
            v = 0
        total += v * weights[i % 3]
    return total % 10


def _verify_and_correct(raw: str, check_char: str) -> tuple[str, bool]:
    """Returns (value, is_verified). If the checksum already matches,
    trusts the OCR result as-is. If not, tries a single-character fix
    for the most common OCR digit/letter mixups; if that resolves the
    checksum, returns the corrected value as verified. Otherwise returns
    the original, unverified — the caller should warn the user to
    double-check it by eye rather than silently trusting a bad read."""
    if not check_char.isdigit():
        return raw, False
    expected = int(check_char)
    if _icao_check_digit(raw) == expected:
        return raw, True
    for i, c in enumerate(raw):
        for alt in _OCR_CONFUSIONS.get(c, []):
            candidate = raw[:i] + alt + raw[i + 1:]
            if _icao_check_digit(candidate) == expected:
                return candidate, True
    return raw, False


def _normalize_mrz_text(text: str) -> str:
    """Coerces stray, clearly-invalid characters back to '<' — but only
    within lines that already look overwhelmingly like genuine MRZ (see
    _looks_like_mrz_line; a stricter 0.8 valid-ratio floor here, versus
    _parse_mrz's 0.6, since this one destructively rewrites the line and
    so needs more confidence it's really MRZ before doing so — an
    ordinary short label line that happens to be mostly uppercase letters
    and digits, e.g. "Č. DOKLADU AB1234567", must never get "fixed" into
    fake MRZ structure).
    Used only as a pre-pass for the name/doc-number extraction below —
    deliberately NOT applied to what _parse_mrz returns as mrz_raw, which
    stays the true, unaltered OCR read. That way a caller merging results
    from multiple uploaded documents can still tell how contaminated a
    given read actually was (see the frontend's MRZ-purity-based ranking
    when merging OCR results from several files), instead of every read
    looking artificially clean after correction."""
    out_lines = []
    for line in text.splitlines():
        candidate = line.strip()
        if _looks_like_mrz_line(candidate, min_valid_ratio=0.8):
            out_lines.append(
                "".join(c.upper() if c.upper() in _MRZ_VALID_CHARS else "<" for c in candidate)
            )
            continue
        out_lines.append(line)
    return "\n".join(out_lines)


def _extract_passport_number_from_mrz(
    text: str,
) -> tuple[Optional[str], bool, Optional[str], Optional[str], Optional[str]]:
    """Reads the document number, the holder's birth date, the document's
    own expiry date, and the issuing country/nationality, straight from
    the MRZ's own fields + check digits, rather than guessing from
    printed (often smudged, glare-affected, or non-Latin-script) text
    elsewhere on the page — this is the same field real e-passport gates
    rely on, and the doc number self-verifies via checksum.

    The birth-date digits sit in the very same regex match (ICAO 9303
    TD3 line 2: doc number, check digit, nationality, birth date YYMMDD,
    ...) — they were being matched but never read out, the identical gap
    that _find_visa_info's birth_date fix (see its own docstring) already
    closed for visas. TD3 field positions are fixed by the ICAO standard
    regardless of the issuing country or the script printed elsewhere on
    the page, so this needs no per-country handling: confirmed against a
    real Armenian passport ("...ARM7402016M3501151<<<<04") whose printed
    "DATE OF BIRTH" a passport-side label search couldn't reliably catch,
    while this MRZ field read correctly.

    The expiry-date digits (immediately after birth date + sex) had the
    exact same gap: matched structurally to anchor the regex, but never
    captured. Real case (the same Tadevosyan passport): the printed page
    had "DATE OF ISSUE\nDATE OF EXPIRY\n15 JAN 2025\n15 JAN 2035" — OCR
    line order put both labels before both dates, so a labeled search
    for "Date of expiry" never finds a date right after it, and the
    generic positional date-fallback elsewhere in this file ends up
    picking the *issue* date instead (15.01.2025) because nothing had
    excluded it first. The MRZ's own expiry field has no such ambiguity
    — same fixed-position reasoning as birth date above — and per this
    module's existing pattern for doc_number/visa validity, callers
    should prefer this over the printed-text guess whenever it's
    available, not just fall back to it when the guess comes up empty.

    The nationality code (between the doc-number check digit and birth
    date) had the same gap once more: matched to anchor the regex, never
    captured. Unlike the date fields, this one still needs a lookup
    table (MRZ_NATIONALITY_TO_CZECH) to turn the 3-letter ICAO code into
    the Czech-language country name the tax form actually wants — an
    unrecognized code returns None so the caller can fall back to
    COUNTRY_HINTS' free-text guess instead of printing a raw code."""
    m = re.search(r"([A-Z0-9<]{9})(\d)([A-Z]{3})(\d{6})\d[MF<](\d{6})\d", _normalize_mrz_text(text))
    if not m:
        return None, False, None, None, None
    raw, check, nationality_code, birth_raw, expiry_raw = (
        m.group(1), m.group(2), m.group(3), m.group(4), m.group(5),
    )
    corrected, verified = _verify_and_correct(raw, check)
    doc_number = corrected.replace("<", "").strip()

    def _decode(raw_digits, role):
        try:
            yy, mm, dd = int(raw_digits[0:2]), int(raw_digits[2:4]), int(raw_digits[4:6])
            year = _interpret_two_digit_year(yy, role=role)
            date(year, mm, dd)  # validate
            return f"{dd:02d}.{mm:02d}.{year}"
        except (ValueError, IndexError):
            return None

    birth_date = _decode(birth_raw, "birth")
    expiry_date = _decode(expiry_raw, "expiry")
    nationality = MRZ_NATIONALITY_TO_CZECH.get(nationality_code)

    return (doc_number or None), verified, birth_date, expiry_date, nationality


def _find_doc_number(text: str) -> Optional[str]:
    for label in DOC_NUMBER_LABELS:
        m = re.search(label + r"[:\s]*\n?\s*([A-Z0-9]{5,12})", text, re.IGNORECASE)
        if m:
            return m.group(1).upper()
    # ICAO-style passport number: 1-2 letters followed by 6-8 digits
    # (e.g. "FY401825") — reliable pattern across most passport formats.
    m = re.search(PASSPORT_NUMBER_PATTERN, text)
    if m:
        return m.group(1)
    # Fallback: a standalone alphanumeric token with both letters and
    # digits, 6-10 chars, is a decent generic heuristic for ID numbers.
    m = re.search(r"\b(?=[A-Z0-9]{6,10}\b)(?=[A-Z0-9]*[0-9])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,10}\b", text)
    return m.group(0) if m else None


ADDRESS_LABEL = r"(?:Adresa|Trvalý pobyt|Bydliště|Address)"


def _find_address(text: str) -> Optional[str]:
    m = re.search(ADDRESS_LABEL + r"[:\s]*\n?\s*([^\n]{5,60})", text, re.IGNORECASE)
    return m.group(1).strip() if m else None


def _extract_fields_from_text(raw_text: str, quality: int, mode: str) -> dict:
    """`quality` is a 0-100 confidence estimate, not a measured value: for
    photos it's _estimate_quality_from_file_size's file-size proxy (see
    its docstring for why that's a weak signal); pasted text and mock
    mode just pass a fixed high number since there's no image to assess."""
    doc_type = _detect_doc_type(raw_text)
    country = _detect_country(raw_text)
    language = _detect_language(raw_text)
    dates = _find_dates(raw_text)
    mrz = _parse_mrz(raw_text)

    birth_date = _find_labeled_date(raw_text, [r"Datum narození", r"Date of birth", r"Nar\."])
    expiry_date = _find_labeled_date(raw_text, [r"Platnost do", r"Date of expiry", r"Expiry"])
    issue_date = _find_labeled_date(raw_text, [r"Datum vydání", r"Date of issue"])

    # No labeled dates found (common on Ukrainian/CIS passports where OCR
    # mangles the Cyrillic labels) — fall back to the bilingual
    # 'DD MON/MON YY' format. These always appear in a fixed document
    # order (birth, then issue, then expiry), so we assign by position
    # rather than by sorting values, which avoids ambiguity when a
    # 2-digit year could plausibly belong to either century.
    if not (birth_date or issue_date or expiry_date):
        tuples = _find_bilingual_date_tuples(raw_text)

        def _fmt(day, month, yy, role):
            year = _interpret_two_digit_year(yy, role)
            try:
                date(year, month, day)  # validates the date is real
                return f"{day:02d}.{month:02d}.{year}"
            except ValueError:
                return None

        if len(tuples) >= 1:
            birth_date = _fmt(*tuples[0], role="birth")
        if len(tuples) >= 2:
            issue_date = _fmt(*tuples[1], role="issue")
        if len(tuples) >= 3:
            expiry_date = _fmt(*tuples[2], role="expiry")

    # Visa documents don't reliably carry printed dates in the same
    # layout as passports/ID cards, so guessing an expiry from "whatever
    # date-like text appears on the page" is unreliable and risks
    # picking up garbage. We already read the visa's real validity from
    # its own MRZ line (see visa_info below) — skip the generic
    # positional date-guessing entirely for visas.
    is_visa = bool(re.search(r"\bV[IÍ]ZUM\b|\bVISA\b", raw_text, re.IGNORECASE))

    # Fall back to positional guessing only if labels weren't found —
    # better than nothing, but labeled matches above are preferred.
    if not is_visa:
        remaining_dates = [d for d in dates if d not in (birth_date, expiry_date, issue_date)]
        if not issue_date and remaining_dates:
            issue_date = remaining_dates[0]
        if not expiry_date and len(remaining_dates) >= 2:
            expiry_date = remaining_dates[1]

    # Prefer the MRZ-derived document number — it self-verifies via a
    # checksum, unlike text found elsewhere on the page. Only fall back
    # to the generic label/pattern search if there's no MRZ to read.
    mrz_doc_number, doc_number_verified, mrz_birth_date, mrz_expiry_date, mrz_nationality = (
        _extract_passport_number_from_mrz(raw_text)
    )
    doc_number = mrz_doc_number or _find_doc_number(raw_text)
    address = _find_address(raw_text)

    # Country/script-agnostic fallback: only kicks in once the labeled
    # and Ukrainian/CIS-bilingual-date heuristics above have both come up
    # empty — a real Armenian passport whose printed "Date of birth"
    # label wasn't picked up (and which obviously never matches the
    # Cyrillic-script bilingual pattern) still has this same MRZ field,
    # decoded here exactly as ICAO 9303 defines it for every country.
    if not birth_date and mrz_birth_date:
        birth_date = mrz_birth_date

    # Unlike birth_date above, this WINS over the printed-text guess
    # rather than just filling a gap — same priority _extract_fields_
    # from_text already gives doc_number. Real case: a passport whose
    # OCR text had "DATE OF ISSUE\nDATE OF EXPIRY\n15 JAN 2025\n15 JAN
    # 2035" (both labels before both dates, so the labeled search above
    # never found "Date of expiry"'s own date) fell through to the
    # generic positional dates[] fallback, which — with no birth_date
    # found yet either to exclude from consideration — ended up reading
    # the *issue* date (15.01.2025) into expiry_date instead, wrongly
    # flagging a passport valid until 2035 as expired. The MRZ's expiry
    # field has no such ambiguity to get shifted by.
    if mrz_expiry_date:
        expiry_date = mrz_expiry_date

    # Same "MRZ wins when present" priority — a passport-tax-declaration
    # form field ("Stát, který tento doklad vydal") needs a specific
    # Czech country name, not a guess from whichever keyword happened to
    # be recognizable in noisy OCR text. Falls back to the free-text
    # COUNTRY_HINTS guess (via `country`, already computed above) for a
    # nationality code not in MRZ_NATIONALITY_TO_CZECH, or when there's
    # no MRZ to read at all (e.g. a plain ID card).
    nationality = mrz_nationality or country

    # If nothing about this text looks like an actual ID document (no
    # MRZ, no recognized doc type, no doc number) and it's short — the
    # person probably just typed a plain address directly into the
    # "paste text" box (e.g. "Kyjev, Tarasa Ševčenka 10"), not a scanned
    # document. Use the whole text as the address in that case, instead
    # of leaving it empty just because it has no "Adresa:" label.
    looks_like_document = bool(mrz or doc_number or is_visa) or doc_type != "Neznámý dokument"
    if not address and not looks_like_document and 0 < len(raw_text.strip()) < 200:
        address = raw_text.strip().replace("\n", ", ")

    visa_info = _find_visa_info(raw_text)

    # A visa's own MRZ line encodes the holder's birth date numerically
    # (see _find_visa_info) — far more reliable than the labeled/
    # positional guessing above, which visas mostly don't carry anyway.
    # Only used as a fallback: a passport/ID card's own birth_date (if
    # this upload turns out to already have one) always wins.
    if is_visa and not birth_date and visa_info.get("birth_date"):
        birth_date = visa_info["birth_date"]

    is_expired = False
    warnings = []
    if mrz_doc_number and not doc_number_verified:
        warnings.append(
            f"Číslo dokladu ({doc_number}) se nepodařilo ověřit kontrolním součtem "
            "— zkontrolujte prosím ručně podle fotografie."
        )
    # For visas, check expiry against the MRZ-derived visa validity
    # rather than the (unreliable) generic expiry_date field.
    expiry_to_check = visa_info.get("visa_validity") if is_visa else expiry_date
    if expiry_to_check:
        try:
            parsed = _parse_any_date(expiry_to_check)
            if parsed and parsed < date.today():
                is_expired = True
                warnings.append("Doklad je propadlý — platnost skončila.")
            elif parsed and parsed < date.today() + timedelta(days=60):
                warnings.append("Platnost dokladu vyprší do 60 dní.")
        except Exception:
            pass

    if quality < 60:
        # "quality" here is a file-size heuristic, not a measurement of
        # actual sharpness/legibility (see _estimate_quality_from_file_size)
        # — worded as a hedge, not a diagnosis, so it doesn't overstate
        # what was actually checked.
        warnings.append(
            "Kvalita fotografie (odhad podle velikosti souboru) může být nízká "
            "— pokud se některé údaje nerozpoznaly správně, zkuste nahrát ostřejší nebo větší sken."
        )

    confidence = "high" if quality > 85 else "medium" if quality > 65 else "low"

    return {
        "doc_type": doc_type,
        "issuing_country": country,
        "nationality": nationality,
        "document_language": language,
        "issue_date": issue_date,
        "expiry_date": expiry_date,
        "birth_date": birth_date,
        "doc_number": doc_number,
        "doc_number_verified": bool(mrz_doc_number and doc_number_verified),
        "address": address,
        "visa_number": visa_info.get("visa_number"),
        "visa_validity": visa_info.get("visa_validity"),
        "visa_type_code": visa_info.get("visa_type_code"),
        "visa_referenced_doc_number": visa_info.get("visa_referenced_doc_number"),
        "mrz_raw": mrz,
        "ocr_quality_score": quality,
        "ocr_confidence": confidence,
        "ocr_mode": mode,
        "is_expired": is_expired,
        "warnings": warnings,
    }


def _parse_any_date(raw: str) -> Optional[date]:
    for fmt in ("%d.%m.%Y", "%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d", "%Y.%m.%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------- MOCK MODE
_MOCK_SAMPLES = [
    {
        "raw_text": "OBČANSKÝ PRŮKAZ\nCESTA JANA\nNOVÁK\n12.03.1994\nČeská republika\nČ.DOKL: 999123456",
        "first_name": "Jan", "last_name": "Novák", "gender": "Muž",
        "birth_date": "1994-03-12", "nationality": "Česká republika",
        "doc_number": "999123456", "address": "Vinohradská 45, Praha 2",
        "issuing_authority": "MV ČR",
    },
    {
        "raw_text": "БІОМЕТРИЧНИЙ ПАСПОРТ УКРАЇНА\nPETRENKO MYKOLA\n08.05.1992\nUkraine\nFK778899",
        "first_name": "Mykola", "last_name": "Petrenko", "gender": "Muž",
        "birth_date": "1992-05-08", "nationality": "Ukrajina",
        "doc_number": "FK778899", "address": None,
        "issuing_authority": "DMS Ukrajiny",
    },
]


def _mock_extract(filename: str) -> dict:
    import hashlib
    idx = int(hashlib.md5(filename.encode()).hexdigest(), 16) % len(_MOCK_SAMPLES)
    sample = _MOCK_SAMPLES[idx]
    quality = 88
    base = _extract_fields_from_text(sample["raw_text"], quality, mode="mock")
    base.update({
        "first_name": sample["first_name"],
        "last_name": sample["last_name"],
        "gender": sample["gender"],
        "birth_date": sample["birth_date"],
        "nationality": sample["nationality"],
        "doc_number": sample["doc_number"],
        "address": sample["address"],
        "issuing_authority": sample["issuing_authority"],
        # give the mock a plausible future expiry so nothing looks broken
        "issue_date": "2021-02-10",
        "expiry_date": "2031-02-10",
        "is_expired": False,
        "warnings": [],
    })
    return base


# ---------------------------------------------------------------- LIVE MODE
async def _vision_ocr(image_bytes: bytes) -> str:
    """Calls Google Cloud Vision's TEXT_DETECTION and returns raw text."""
    b64 = base64.b64encode(image_bytes).decode()
    payload = {
        "requests": [{
            "image": {"content": b64},
            "features": [{"type": "TEXT_DETECTION"}],
        }]
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            VISION_ENDPOINT,
            params={"key": settings.GOOGLE_VISION_API_KEY},
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()

    try:
        return data["responses"][0]["fullTextAnnotation"]["text"]
    except (KeyError, IndexError):
        return ""


NAME_LABEL_PATTERNS = [
    # (label regex, group meaning)
    (r"(?:Příjmení|Surname)\s*[:\-]?\s*\n?\s*([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ\s]{1,30})", "last"),
    (r"(?:Jméno|Given name)s?\s*[:\-]?\s*\n?\s*([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ\s]{1,30})", "first"),
]


def _parse_name_from_text(text: str) -> tuple[Optional[str], Optional[str]]:
    """Best-effort name extraction, in order of reliability:
    1. MRZ 'SURNAME<<GIVEN' pattern (passports, visas) — most reliable.
    2. Labelled fields 'Jméno'/'Příjmení' or 'Given name'/'Surname'
       (Czech ID cards, residence permits — bilingual labels).
    3. Nothing found — left for manual entry; the raw recognized text is
       still shown to the user so they can copy it themselves.
    """
    # Restricted to genuine MRZ-shaped lines (via _parse_mrz) rather than
    # searching the whole raw text: a document's bilingual header (e.g.
    # "VÍZUM / VISA") sits above the real MRZ block, and if OCR misreads
    # its "/" as "<<" — plausible, they're visually similar strokes — a
    # search across the whole text would match that header first (re.search
    # returns the leftmost match) and return "Visa"/"Vízum" as the name
    # instead of ever looking at the actual MRZ line below it. Restricting
    # to _parse_mrz's output means only lines that are actually the right
    # shape for MRZ (see _looks_like_mrz_line) are ever considered here.
    mrz_lines = _parse_mrz(text)
    # Normalized first: OCR misreading one of the '<' separators/filler
    # into an unrelated glyph would otherwise break this exact "<<" match
    # even when the surname/given name letters themselves read fine — see
    # _normalize_mrz_text's docstring.
    normalized_mrz = _normalize_mrz_text(mrz_lines) if mrz_lines else None
    mrz_match = re.search(r"([A-Z]+)<<([A-Z<]+)", normalized_mrz) if normalized_mrz else None
    if mrz_match:
        raw_last = mrz_match.group(1)
        # Standard MRZ has no separator between the 3-letter country code
        # and the surname that follows it ("P<UKRMOKHNIA<<VASYL..."), so
        # our regex captures them glued together ("UKRMOKHNIA"). ICAO 9303
        # fixes the doc-type char + filler + 3-letter country/nationality
        # code to exactly line positions 0-4 on a passport ("P<UKR...") or
        # visa ("V<CZE...") name line — how much of that 5-char prefix ends
        # up glued onto raw_last depends only on whether the filler OCR'd
        # as a literal '<' (breaks the uppercase-letter run our regex
        # matches on, so it's excluded automatically — raw_last starts
        # right at the country code) or got misread into a stray letter
        # instead (doesn't break the run, so it's included — e.g.
        # "VDCZEPELEKH"). Strip by the match's ABSOLUTE POSITION on its own
        # line rather than searching for one of a handful of hardcoded
        # country codes: a whitelist silently fails — gluing the country
        # code onto the surname — for any of the ~200 valid ICAO codes it
        # doesn't happen to enumerate (e.g. a visa issued by a country this
        # file never listed, which is exactly what real bug reports of
        # "worse recognition with a visa attached" turned out to be).
        line_start = normalized_mrz.rfind("\n", 0, mrz_match.start(1)) + 1
        if normalized_mrz[line_start:line_start + 1] in ("P", "V"):
            prefix_len = 5 - (mrz_match.start(1) - line_start)
            if 0 < prefix_len < len(raw_last):
                raw_last = raw_last[prefix_len:]
        last = raw_last.replace("<", " ").strip().title()
        first = mrz_match.group(2).replace("<", " ").strip().title()
        # OCR sometimes drops one of the two '<' separators, causing this
        # regex to match the tail-end filler ("<<<<<...") instead of the
        # real given name — resulting in an empty first name. Only trust
        # this match if both parts look like real name fragments.
        if last and first:
            return first, last

    first = last = None
    for pattern, kind in NAME_LABEL_PATTERNS:
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            value = m.group(1).strip().split("\n")[0].strip().title()
            if kind == "first":
                first = value
            else:
                last = value
    if first and last:
        return first, last

    # Ukrainian/CIS-style passports show each name field twice: OCR-garbled
    # Cyrillic, then "/", then a clean Latin transliteration — e.g.
    # "РОМАНЧУК/ROMANCHUK" (surname) followed on the next line by
    # "ІВАННА/IVANNA" (given name). The Latin half after "/" is reliable
    # even when Tesseract/OCR.space garbles the Cyrillic half into
    # nonsense, since Latin-script OCR is far more accurate. Order on the
    # document is always surname first, then given name.
    # Ukrainian/CIS-style passports show each name field twice: OCR-garbled
    # Cyrillic, then "/", then a clean Latin transliteration — e.g.
    # "РОМАНЧУК/ROMANCHUK" (surname) followed on the next line by
    # "ІВАННА/IVANNA" (given name) — two separate lines. Other documents
    # (like some Ukrainian passports) print "SURNAME/GIVEN" already
    # correctly transliterated on a single line instead. We can't tell
    # these apart by looking at the characters (OCR often turns Cyrillic
    # into Latin lookalikes either way) — but we *can* tell by how many
    # such lines exist: two lines means the two-line format; exactly one
    # line means that line already contains the full surname/given pair.
    slash_names = re.findall(r"^([^\n/]{2,25})/([A-Z]{2,25})\s*$", text, re.MULTILINE)
    if len(slash_names) >= 2:
        return slash_names[1][1].title(), slash_names[0][1].title()
    if len(slash_names) == 1 and not (first or last):
        left, right = slash_names[0]
        return right.title(), left.title()

    return first, last


def _preprocess_for_ocr(image):
    """Improves OCR accuracy on real-world phone photos (as opposed to
    flat scans, which Tesseract was originally designed for). Applies:
    auto-crop of excess background, grayscale, contrast boost, upscaling
    for small images, and sharpening. This is pure PIL — no extra
    dependencies, negligible cost."""
    from PIL import Image, ImageOps, ImageEnhance, ImageFilter

    image = _auto_crop_document(image)
    gray = ImageOps.grayscale(image)

    # Upscale small photos — Tesseract does much better with more pixels
    # per character. Phone photos of documents are often downsized by
    # the browser before upload.
    w, h = gray.size
    if max(w, h) < 1800:
        scale = 1800 / max(w, h)
        gray = gray.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

    gray = ImageOps.autocontrast(gray, cutoff=1)
    gray = ImageEnhance.Sharpness(gray).enhance(1.8)
    gray = ImageEnhance.Contrast(gray).enhance(1.3)
    return gray


def _auto_crop_document(img):
    """Trims excess background (table, shadows, empty margin) around a
    photographed document, effectively 'zooming in' on the actual content
    before OCR — helps when a document is small relative to the whole
    photo. Deliberately conservative: only crops when confident there's
    a large, genuinely uniform margin, and never crops more than a modest
    amount, so it can't accidentally cut off real document content.
    Tries both polarities (document darker than background, or lighter),
    since real photos vary — a light ID card on a dark desk is just as
    common as a dark passport cover on a light table."""
    from PIL import ImageOps

    try:
        gray = ImageOps.grayscale(img)
        w, h = img.size

        def _bbox_for(threshold, darker_is_content):
            if darker_is_content:
                bw = gray.point(lambda x: 255 if x < threshold else 0)
            else:
                bw = gray.point(lambda x: 255 if x > threshold else 0)
            return bw.getbbox()

        candidates = []
        for darker_is_content in (True, False):
            bbox = _bbox_for(200, darker_is_content)
            if not bbox:
                continue
            left, top, right, bottom = bbox
            area_ratio = ((right - left) * (bottom - top)) / (w * h)
            # A confident crop trims a real margin but doesn't shrink to a
            # tiny fragment (which would mean we only caught some text or
            # noise, not the actual document boundary).
            if 0.20 <= area_ratio <= 0.90:
                candidates.append((area_ratio, bbox))

        if not candidates:
            return img

        # Prefer the candidate that trims the LEAST (safest choice) when
        # both polarities produce a plausible result, to minimize risk of
        # cutting off real content.
        candidates.sort(key=lambda c: -c[0])
        _, (left, top, right, bottom) = candidates[0]

        content_w, content_h = right - left, bottom - top
        pad_x, pad_y = int(content_w * 0.06), int(content_h * 0.06)
        left = max(0, left - pad_x)
        top = max(0, top - pad_y)
        right = min(w, right + pad_x)
        bottom = min(h, bottom + pad_y)
        return img.crop((left, top, right, bottom))
    except Exception as e:
        logger.warning("auto-crop skipped: %s: %s", type(e).__name__, e)
        return img


def _compress_for_upload(image_bytes: bytes, max_size_kb: int = 900) -> bytes:
    """OCR.space's free tier rejects files over ~1MB with a generic
    'errored in parsing' message. Real phone photos are often 3-8MB, so
    we resize and re-compress to fit comfortably under that limit before
    sending — this alone often fixes silent parsing failures."""
    from PIL import Image
    import io

    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except ImportError:
        pass  # non-HEIC images still work fine without this

    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception as e:
        logger.warning("_compress_for_upload failed to decode image: %s: %s", type(e).__name__, e)
        return image_bytes  # let the caller's error handling deal with it

    # Downscale FIRST, then auto-crop on the smaller image — auto-crop
    # does pixel-by-pixel analysis (grayscale + bounding-box scans), and
    # running that on a full-resolution phone photo (often 3000-4000px+)
    # before shrinking it was needlessly slow on a weak free-tier CPU.
    # A 1800px-wide image is still plenty sharp for finding the document
    # boundary, at a fraction of the processing cost.
    w, h = img.size
    if max(w, h) > 1800:
        scale = 1800 / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

    img = _auto_crop_document(img)

    for quality in (85, 70, 55, 40):
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        if len(buf.getvalue()) <= max_size_kb * 1024:
            return buf.getvalue()
    return buf.getvalue()  # smallest attempt, even if still over budget


async def _ocr_space_ocr(image_bytes: bytes, filename: str) -> str:
    """Free remote OCR via ocr.space — no billing account needed, just a
    free API key from https://ocr.space/ocrapi (email signup, instant,
    no card). Processing happens on their servers, not this one, which
    solves both the speed and reliability problems of running Tesseract
    locally on a memory/CPU-constrained free hosting instance."""
    import time
    url = "https://api.ocr.space/parse/image"

    t_compress = time.time()
    # Run in a separate thread — this does CPU-bound PIL image work
    # (grayscale scans, resizing, JPEG encoding), which would otherwise
    # block the single-worker async event loop entirely, freezing every
    # other request on the server (including simple ones) until it's
    # done. Offloading it keeps the server responsive to other requests
    # while this one's image processing runs in the background.
    image_bytes = await asyncio.to_thread(_compress_for_upload, image_bytes)
    logger.info("compress: %.1fs, result=%.0fKB", time.time() - t_compress, len(image_bytes) / 1024)
    filename = "upload.jpg"  # always send as a plain, unambiguous jpeg now

    # OCR.space has two engines with different language support — Engine 2
    # only supports a small language subset that excludes "cze"/"ukr", so
    # we try Engine 1 (broad language support) first, then fall back to
    # Engine 2 with English if that somehow fails too.
    attempts = [
        {"language": "auto", "OCREngine": "2"},
        {"language": "eng", "OCREngine": "1"},
        {"language": "eng", "OCREngine": "2"},
    ]

    for attempt in attempts:
        data = {
            "apikey": settings.OCR_SPACE_API_KEY,
            "scale": "true",
            "isTable": "false",
            **attempt,
        }
        files = {"file": (filename, image_bytes, "image/jpeg")}
        t_attempt = time.time()
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(url, data=data, files=files)
                resp.raise_for_status()
                result = resp.json()
            logger.info("attempt %s: %.1fs", attempt, time.time() - t_attempt)
        except Exception as e:
            logger.warning("attempt %s FAILED after %.1fs: %s: %s", attempt, time.time() - t_attempt, type(e).__name__, e)
            continue

        if result.get("IsErroredOnProcessing"):
            err = result.get("ErrorMessage") or result.get("ErrorDetails") or "unknown error"
            logger.warning("OCR.space error (%s): %s", attempt, err)
            continue

        parsed = result.get("ParsedResults") or []
        if parsed and parsed[0].get("ParsedText", "").strip():
            return parsed[0]["ParsedText"]

    return ""


def _tesseract_ocr(image_bytes: bytes) -> str:
    """Free, local, no-API-key OCR using Tesseract — no billing account or
    API key needed at all. Less accurate than Google Vision but works out
    of the box on any server. Requires the `tesseract-ocr` system package
    (installed via Dockerfile) and `pytesseract` + `Pillow` Python packages."""
    import pytesseract
    from PIL import Image
    import io

    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except ImportError:
        pass  # HEIC support unavailable; non-HEIC images still work fine.

    try:
        image = Image.open(io.BytesIO(image_bytes))
        image.load()
        image = image.convert("RGB")

        # Cap the incoming image size BEFORE any processing. Real phone
        # photos can be huge (4000x3000px+) — on a memory-constrained free
        # server, processing that at full resolution can exhaust RAM and
        # hang indefinitely. 2000px on the long side is more than enough
        # detail for OCR and keeps memory/CPU use bounded and fast.
        w, h = image.size
        if max(w, h) > 1500:
            scale = 1500 / max(w, h)
            image = image.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

        image = _preprocess_for_ocr(image)
    except Exception as e:
        logger.warning("Failed to open/preprocess image: %s: %s", type(e).__name__, e)
        return ""

    # Use the combined Czech+Ukrainian+English model first — needed to
    # correctly read Czech diacritics (é, ř, š, etc.) on real documents.
    # Only fall back to English-only if that genuinely fails to run
    # (e.g. missing language data), not just because the result looks odd.
    config = "--psm 6"
    for langs in ("ces+ukr+eng", "eng"):
        try:
            return pytesseract.image_to_string(image, lang=langs, config=config)
        except Exception as e:
            logger.warning("Tesseract failed with lang=%s: %s: %s", langs, type(e).__name__, e)
            continue
    return ""


def _looks_like_garbage_name(name: Optional[str]) -> bool:
    """Flags an OCR name read that's almost certainly noise rather than a
    real name — e.g. "Kk Kk Kkk" from a badly-blurred visa MRZ line, where
    nearly every character collapsed to the same one or two letters. Real
    names (even short, even heavily transliterated ones) don't look like
    this, so a low character-diversity name is a strong noise signal —
    used only to decide whether a single extra OCR.space call is worth
    trying, so a false positive here just costs one harmless retry, never
    a wrong result."""
    if not name:
        return False
    compact = re.sub(r"\s+", "", name).upper()
    if len(compact) < 5:
        return False
    return len(set(compact)) <= 2


def _has_missing_important_field(fields: dict) -> bool:
    """A first-pass read that came back without one of a document's core
    identifying fields is a strong sign the OCR read itself was bad, not
    that the field is genuinely absent — birth_date is expected on
    essentially every ID document, and doc_number/visa_number is the one
    field the upload exists to capture. Checked per document type (a
    visa's own number lives in visa_number, not doc_number) so this
    doesn't fire on every non-visa upload just because visa_number is
    (correctly) empty there."""
    if not fields.get("birth_date"):
        return True
    if fields.get("doc_type") == "Vízum":
        return not fields.get("visa_number")
    return not fields.get("doc_number")


async def recognize_document(file_path: Path, original_filename: str) -> dict:
    """
    Main entry point used by the API layer.
    Returns a flat dict matching schemas.ExtractedFields.
    """
    import time
    t0 = time.time()

    image_bytes = file_path.read_bytes()
    quality = _estimate_quality_from_file_size(image_bytes)
    logger.info("file read: %.1fs, size=%.0fKB", time.time() - t0, len(image_bytes) / 1024)

    if settings.OCR_MODE == "mock":
        result = _mock_extract(original_filename)
        return result

    mime, _ = mimetypes.guess_type(str(file_path))

    if settings.OCR_MODE == "ocrspace":
        if mime == "application/pdf":
            result = _mock_extract(original_filename)
            result["warnings"] = result.get("warnings", []) + [
                "Rozpoznávání PDF v bezplatném režimu zatím není podporováno — zobrazena ukázková data."
            ]
            return result
        try:
            t1 = time.time()
            raw_text = await _ocr_space_ocr(image_bytes, original_filename)
            logger.info("OCR.space total: %.1fs, got %d chars", time.time() - t1, len(raw_text))
        except Exception as e:
            logger.warning("OCR.space request failed: %s: %s", type(e).__name__, e)
            raw_text = ""
        if not raw_text.strip():
            # Graceful fallback: if the remote free API is unreachable or
            # over its daily quota, try local Tesseract rather than
            # failing outright, so the feature keeps working either way.
            try:
                t2 = time.time()
                raw_text = await asyncio.wait_for(
                    asyncio.to_thread(_tesseract_ocr, image_bytes),
                    timeout=TESSERACT_TIMEOUT_SECONDS,
                )
                logger.info("Tesseract fallback: %.1fs, got %d chars", time.time() - t2, len(raw_text))
            except Exception as e:
                logger.warning("Tesseract fallback failed: %s: %s", type(e).__name__, e)
                raw_text = ""
        if not raw_text.strip():
            result = _mock_extract(original_filename)
            result["warnings"] = ["Nepodařilo se přečíst text z dokumentu — zkuste ostřejší fotografii."]
            logger.info("TOTAL (fell back to mock): %.1fs", time.time() - t0)
            return result
        fields = _extract_fields_from_text(raw_text, quality, mode="ocrspace")
        first, last = _parse_name_from_text(raw_text)
        fields["first_name"] = first
        fields["last_name"] = last
        fields["ocr_raw_text"] = raw_text

        # OCR.space's result can vary between calls to the same image (it
        # tries several engine/language combos internally and returns
        # whichever succeeds first — see _ocr_space_ocr). Several signals
        # can each independently mark a first read as low quality: a
        # garbled name, a core field (birth_date/doc_number/visa_number)
        # that came back empty, or an MRZ check digit that didn't verify
        # (a near-certain sign the digits it read are wrong). Any one of
        # these is cheap insurance to try a second full attempt against —
        # but regardless of how many fire at once, only a single extra
        # OCR.space call is ever made per file (never risk multiplying
        # request volume against its free-tier quota), and the retry only
        # replaces the original result if it actually resolved the
        # specific problem(s) that triggered it — never risks making
        # things worse.
        name_garbled = _looks_like_garbage_name(first) or _looks_like_garbage_name(last)
        missing_field = _has_missing_important_field(fields)
        mrz_doc_number, mrz_verified, _, _, _ = _extract_passport_number_from_mrz(raw_text)
        checksum_failed = bool(mrz_doc_number and not mrz_verified)

        if name_garbled or missing_field or checksum_failed:
            logger.info(
                "low-quality OCR read (garbled_name=%s, missing_field=%s, checksum_failed=%s) - retrying OCR.space once",
                name_garbled, missing_field, checksum_failed,
            )
            try:
                retry_text = await _ocr_space_ocr(image_bytes, original_filename)
            except Exception as e:
                logger.warning("OCR.space retry failed: %s: %s", type(e).__name__, e)
                retry_text = ""
            if retry_text.strip():
                retry_fields = _extract_fields_from_text(retry_text, quality, mode="ocrspace")
                retry_first, retry_last = _parse_name_from_text(retry_text)
                retry_fields["first_name"] = retry_first
                retry_fields["last_name"] = retry_last
                retry_fields["ocr_raw_text"] = retry_text

                name_fixed = (
                    (retry_first or retry_last)
                    and not _looks_like_garbage_name(retry_first)
                    and not _looks_like_garbage_name(retry_last)
                )
                missing_field_fixed = not _has_missing_important_field(retry_fields)
                retry_mrz_doc_number, retry_verified, _, _, _ = _extract_passport_number_from_mrz(retry_text)
                checksum_fixed = bool(retry_mrz_doc_number and retry_verified)

                if (
                    (not name_garbled or name_fixed)
                    and (not missing_field or missing_field_fixed)
                    and (not checksum_failed or checksum_fixed)
                ):
                    fields = retry_fields
                    logger.info("retry produced a better read - using it")

        logger.info("TOTAL: %.1fs", time.time() - t0)
        return fields

    if settings.OCR_MODE == "local":
        if mime == "application/pdf":
            result = _mock_extract(original_filename)
            result["warnings"] = result.get("warnings", []) + [
                "Rozpoznávání PDF v bezplatném režimu zatím není podporováno — zobrazena ukázková data."
            ]
            return result
        try:
            raw_text = await asyncio.wait_for(
                asyncio.to_thread(_tesseract_ocr, image_bytes),
                timeout=TESSERACT_TIMEOUT_SECONDS,
            )
        except Exception:
            raw_text = ""
        if not raw_text.strip():
            result = _mock_extract(original_filename)
            result["warnings"] = ["Nepodařilo se přečíst text z dokumentu — zkuste ostřejší fotografii."]
            return result
        fields = _extract_fields_from_text(raw_text, quality, mode="local")
        first, last = _parse_name_from_text(raw_text)
        fields["first_name"] = first
        fields["last_name"] = last
        fields["ocr_raw_text"] = raw_text
        return fields

    # live mode (Google Vision)
    if mime == "application/pdf":
        # Vision's images:annotate needs a rasterized image; for PDFs a
        # production build should use files:asyncBatchAnnotate instead.
        # For MVP scope we OCR only image uploads live; PDFs fall back to mock
        # with a warning so the user isn't blocked.
        result = _mock_extract(original_filename)
        result["warnings"] = result.get("warnings", []) + [
            "Živé rozpoznávání PDF zatím není podporováno — zobrazena ukázková data."
        ]
        return result

    raw_text = await _vision_ocr(image_bytes)
    if not raw_text:
        result = _mock_extract(original_filename)
        result["warnings"] = ["Nepodařilo se přečíst text z dokumentu — zkontrolujte kvalitu skenu."]
        return result

    fields = _extract_fields_from_text(raw_text, quality, mode="live")
    first, last = _parse_name_from_text(raw_text)
    fields["first_name"] = first
    fields["last_name"] = last
    fields["ocr_raw_text"] = raw_text
    return fields
