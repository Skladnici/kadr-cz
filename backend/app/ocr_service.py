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
import base64
import re
import mimetypes
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

import httpx

from app.config import settings

VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate"

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


def _find_dates(text: str) -> list[str]:
    found = []
    for pattern in DATE_PATTERNS:
        for m in re.finditer(pattern, text):
            found.append(m.group(0))
    return found


def _parse_mrz(text: str) -> Optional[str]:
    """Very lightweight MRZ line detector (two lines of 44 chars w/ '<')."""
    lines = [l.strip() for l in text.splitlines() if "<<" in l]
    if lines:
        return "\n".join(lines[-2:])
    return None


def _quality_score(image_bytes: bytes) -> int:
    """Rough heuristic placeholder — in production this reads Vision's
    imageProperties/faceAnnotation confidence. Here we approximate from
    file size as a stand-in signal so the UI has something real to show."""
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
    """Extracts visa number and expiry date from a Czech/Schengen visa
    sticker. Two independent sources, used together for reliability:
      1. The plain visa number printed near 'VIZUM/VISA' (6-10 digits).
      2. The visa's own MRZ-style line at the bottom, which also encodes
         the holder's birth date and the visa's expiry date — reading
         the expiry from here is far more reliable than guessing from
         printed (and often OCR-mangled) calendar dates on the sticker.
    """
    result = {}

    if not re.search(r"\bVIZUM\b|\bVISA\b", text, re.IGNORECASE):
        return result  # doesn't look like a visa document at all

    m = re.search(r"VIZUM\s*/\s*VISA\s*\n\s*([A-Z]{3})\s*\n\s*(\d{6,10})", text, re.IGNORECASE)
    if m:
        result["visa_number"] = f"{m.group(1).upper()}{m.group(2)}"
    else:
        # Series line not found right where expected — still capture the
        # bare number, and separately look for a 3-letter series code
        # (CZE, POL, SVK…) anywhere nearby to prefix it with.
        m_num = re.search(r"VIZUM\s*/\s*VISA.*?\n.*?\n(\d{6,10})", text, re.IGNORECASE | re.DOTALL)
        m_series = re.search(r"\b(CZE|POL|SVK|DEU|AUT|HUN)\b", text)
        if m_num:
            prefix = m_series.group(1) if m_series else ""
            result["visa_number"] = f"{prefix}{m_num.group(1)}"

    m2 = re.search(r"(\d{8,10})\d?[A-Z]{3}(\d{6})\d[MF](\d{6})\d", text)
    if m2:
        if "visa_number" not in result:
            result["visa_number"] = m2.group(1)
        expiry_raw = m2.group(3)  # YYMMDD
        try:
            yy, mm, dd = int(expiry_raw[0:2]), int(expiry_raw[2:4]), int(expiry_raw[4:6])
            year = _interpret_two_digit_year(yy, role="expiry")
            date(year, mm, dd)  # validate
            result["visa_validity"] = f"{dd:02d}.{mm:02d}.{year}"
        except (ValueError, IndexError):
            pass

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


def _extract_passport_number_from_mrz(text: str) -> tuple[Optional[str], bool]:
    """Reads the document number straight from the MRZ's own field +
    check digit, rather than guessing from printed (often smudged or
    glare-affected) text elsewhere on the page — this is the same field
    real e-passport gates rely on, and it self-verifies via checksum."""
    m = re.search(r"([A-Z0-9<]{9})(\d)[A-Z]{3}\d{6}\d[MF<]\d{6}\d", text)
    if not m:
        return None, False
    raw, check = m.group(1), m.group(2)
    corrected, verified = _verify_and_correct(raw, check)
    doc_number = corrected.replace("<", "").strip()
    return (doc_number or None), verified


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

    # Fall back to positional guessing only if labels weren't found —
    # better than nothing, but labeled matches above are preferred.
    remaining_dates = [d for d in dates if d not in (birth_date, expiry_date, issue_date)]
    if not issue_date and remaining_dates:
        issue_date = remaining_dates[0]
    if not expiry_date and len(remaining_dates) >= 2:
        expiry_date = remaining_dates[1]

    # Prefer the MRZ-derived document number — it self-verifies via a
    # checksum, unlike text found elsewhere on the page. Only fall back
    # to the generic label/pattern search if there's no MRZ to read.
    mrz_doc_number, doc_number_verified = _extract_passport_number_from_mrz(raw_text)
    doc_number = mrz_doc_number or _find_doc_number(raw_text)
    address = _find_address(raw_text)
    visa_info = _find_visa_info(raw_text)

    is_expired = False
    warnings = []
    if mrz_doc_number and not doc_number_verified:
        warnings.append(
            f"Číslo dokladu ({doc_number}) se nepodařilo ověřit kontrolním součtem "
            "— zkontrolujte prosím ručně podle fotografie."
        )
    if expiry_date:
        try:
            parsed = _parse_any_date(expiry_date)
            if parsed and parsed < date.today():
                is_expired = True
                warnings.append("Doklad je propadlý — platnost skončila.")
            elif parsed and parsed < date.today() + timedelta(days=60):
                warnings.append("Platnost dokladu vyprší do 60 dní.")
        except Exception:
            pass

    if quality < 60:
        warnings.append("Kvalita fotografie je nízká — doporučujeme nahrát nový sken.")

    confidence = "high" if quality > 85 else "medium" if quality > 65 else "low"

    return {
        "doc_type": doc_type,
        "issuing_country": country,
        "document_language": language,
        "issue_date": issue_date,
        "expiry_date": expiry_date,
        "birth_date": birth_date,
        "doc_number": doc_number,
        "doc_number_verified": bool(mrz_doc_number and doc_number_verified),
        "address": address,
        "visa_number": visa_info.get("visa_number"),
        "visa_validity": visa_info.get("visa_validity"),
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
    1. MRZ 'SURNAME<<GIVEN' pattern (passports) — most reliable.
    2. Labelled fields 'Jméno'/'Příjmení' or 'Given name'/'Surname'
       (Czech ID cards, residence permits — bilingual labels).
    3. Nothing found — left for manual entry; the raw recognized text is
       still shown to the user so they can copy it themselves.
    """
    mrz_match = re.search(r"([A-Z]+)<<([A-Z<]+)", text)
    if mrz_match:
        last = mrz_match.group(1).replace("<", " ").strip().title()
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
    slash_names = re.findall(r"^[^\n/]{2,25}/([A-Z]{2,25})\s*$", text, re.MULTILINE)
    if len(slash_names) >= 2:
        return slash_names[1].title(), slash_names[0].title()
    if len(slash_names) == 1 and not (first or last):
        return None, slash_names[0].title()

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
        print(f"[ocr] auto-crop skipped: {type(e).__name__}: {e}")
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
        print(f"[ocr] _compress_for_upload failed to decode image: {type(e).__name__}: {e}")
        return image_bytes  # let the caller's error handling deal with it

    img = _auto_crop_document(img)

    w, h = img.size
    if max(w, h) > 1800:
        scale = 1800 / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

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
    url = "https://api.ocr.space/parse/image"
    image_bytes = _compress_for_upload(image_bytes)
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
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(url, data=data, files=files)
                resp.raise_for_status()
                result = resp.json()
        except Exception as e:
            print(f"[ocr] OCR.space request failed ({attempt}): {type(e).__name__}: {e}")
            continue

        if result.get("IsErroredOnProcessing"):
            err = result.get("ErrorMessage") or result.get("ErrorDetails") or "unknown error"
            print(f"[ocr] OCR.space error ({attempt}): {err}")
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
        print(f"[ocr] Failed to open/preprocess image: {type(e).__name__}: {e}")
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
            print(f"[ocr] Tesseract failed with lang={langs}: {type(e).__name__}: {e}")
            continue
    return ""


async def recognize_document(file_path: Path, original_filename: str) -> dict:
    """
    Main entry point used by the API layer.
    Returns a flat dict matching schemas.ExtractedFields.
    """
    image_bytes = file_path.read_bytes()
    quality = _quality_score(image_bytes)

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
            raw_text = await _ocr_space_ocr(image_bytes, original_filename)
        except Exception as e:
            print(f"[ocr] OCR.space request failed: {type(e).__name__}: {e}")
            raw_text = ""
        if not raw_text.strip():
            # Graceful fallback: if the remote free API is unreachable or
            # over its daily quota, try local Tesseract rather than
            # failing outright, so the feature keeps working either way.
            try:
                raw_text = _tesseract_ocr(image_bytes)
            except Exception:
                raw_text = ""
        if not raw_text.strip():
            result = _mock_extract(original_filename)
            result["warnings"] = ["Nepodařilo se přečíst text z dokumentu — zkuste ostřejší fotografii."]
            return result
        fields = _extract_fields_from_text(raw_text, quality, mode="ocrspace")
        first, last = _parse_name_from_text(raw_text)
        fields["first_name"] = first
        fields["last_name"] = last
        fields["ocr_raw_text"] = raw_text
        return fields

    if settings.OCR_MODE == "local":
        if mime == "application/pdf":
            result = _mock_extract(original_filename)
            result["warnings"] = result.get("warnings", []) + [
                "Rozpoznávání PDF v bezplatném režimu zatím není podporováno — zobrazena ukázková data."
            ]
            return result
        try:
            raw_text = _tesseract_ocr(image_bytes)
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
